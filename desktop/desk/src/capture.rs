use crate::cancellation;
use crate::protocol::{Rect, Screenshot};
use base64::Engine;
use block2::RcBlock;
use core_foundation::array::CFArray;
use core_foundation::base::{CFRetain, CFType, CFTypeRef, TCFType};
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::runloop::{kCFRunLoopDefaultMode, CFRunLoop};
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::image::CGImage;
use core_graphics::window::{
    copy_window_info, create_image, kCGWindowImageBoundsIgnoreFraming, kCGWindowImageNominalResolution, kCGWindowListOptionIncludingWindow,
    kCGWindowListOptionOnScreenAboveWindow, kCGWindowNumber, kCGWindowOwnerPID,
};
use foreign_types::ForeignType;
use objc2::rc::Retained;
use objc2::runtime::AnyClass;
use objc2::AnyThread;
use objc2_core_foundation::{CGPoint, CGRect, CGSize};
use objc2_foundation::{NSArray, NSError, NSMutableData};
use objc2_screen_capture_kit::{SCContentFilter, SCScreenshotManager, SCShareableContent, SCStreamConfiguration, SCWindow};
use std::sync::mpsc::{sync_channel, Receiver, RecvTimeoutError, SyncSender};
use std::time::{Duration, Instant};

#[link(name = "ImageIO", kind = "framework")]
extern "C" {
    fn CGImageDestinationCreateWithData(data: CFTypeRef, kind: CFStringRef, count: usize, options: CFTypeRef) -> CFTypeRef;
    fn CGImageDestinationAddImage(destination: CFTypeRef, image: CFTypeRef, properties: CFTypeRef);
    fn CGImageDestinationFinalize(destination: CFTypeRef) -> bool;
}

const TIMEOUT: Duration = Duration::from_secs(5);

type Shot = Result<Screenshot, String>;

pub fn window(id: u32, frame: Rect) -> Shot {
    if AnyClass::get(c"SCScreenshotManager").is_none() {
        return legacy(id, frame);
    }
    let above = above(id);
    let (tx, rx) = sync_channel(1);
    let block = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
        let started = unsafe { content.as_ref() }.ok_or_else(|| reason(error)).and_then(|c| shoot(c, id, &above, frame, tx.clone()));
        if let Err(e) = started {
            let _ = tx.try_send(Err(e));
        }
    });
    unsafe { SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(true, false, &block) };
    drop(block);
    wait(rx)
}

fn above(id: u32) -> Vec<(u32, i64)> {
    let number = |d: &CFDictionary<CFString, CFType>, key| d.find(key).and_then(|v| v.downcast::<CFNumber>()).and_then(|n| n.to_i64());
    let infos = copy_window_info(kCGWindowListOptionOnScreenAboveWindow | kCGWindowListOptionIncludingWindow, id);
    infos
        .iter()
        .flat_map(CFArray::iter)
        .filter_map(|item| {
            let d = unsafe { CFDictionary::<CFString, CFType>::wrap_under_get_rule(*item as _) };
            Some((
                number(&d, unsafe { CFString::wrap_under_get_rule(kCGWindowNumber) })? as u32,
                number(&d, unsafe { CFString::wrap_under_get_rule(kCGWindowOwnerPID) })?,
            ))
        })
        .collect()
}

fn shoot(content: &SCShareableContent, id: u32, above: &[(u32, i64)], frame: Rect, tx: SyncSender<Shot>) -> Result<(), String> {
    let windows = unsafe { content.windows() };
    let target = windows.iter().find(|w| unsafe { w.windowID() } == id).ok_or("The window is not available to capture.")?;
    let bounds = cg(frame);
    let config = unsafe { SCStreamConfiguration::new() };
    unsafe {
        config.setWidth(frame.w.round().max(1.0) as usize);
        config.setHeight(frame.h.round().max(1.0) as usize);
        config.setShowsCursor(false);
        config.setIgnoreShadowsDisplay(true);
    }
    let pid = above.iter().find(|(w, _)| *w == id).map(|(_, p)| *p);
    let front: Vec<Retained<SCWindow>> = windows
        .iter()
        .filter(|w| {
            let wid = unsafe { w.windowID() };
            wid != id && pid.is_some_and(|p| above.contains(&(wid, p))) && overlap(unsafe { w.frame() }, bounds) > 0.0
        })
        .collect();
    let display = unsafe { content.displays() }
        .iter()
        .max_by(|a, b| overlap(unsafe { a.frame() }, bounds).total_cmp(&overlap(unsafe { b.frame() }, bounds)))
        .filter(|d| !front.is_empty() && overlap(unsafe { d.frame() }, bounds) > 0.0);
    let filter = match display {
        Some(d) => {
            let shown: Vec<Retained<SCWindow>> = std::iter::once(target.clone()).chain(front).collect();
            unsafe {
                config.setSourceRect(local(bounds, d.frame()));
                SCContentFilter::initWithDisplay_includingWindows(SCContentFilter::alloc(), &d, &NSArray::from_retained_slice(&shown))
            }
        }
        None => unsafe { SCContentFilter::initWithDesktopIndependentWindow(SCContentFilter::alloc(), &target) },
    };
    let done = RcBlock::new(move |image: *mut objc2_core_graphics::CGImage, error: *mut NSError| {
        let shot = match unsafe { image.as_ref() } {
            Some(i) => encode(&unsafe { CGImage::from_ptr(CFRetain((i as *const objc2_core_graphics::CGImage).cast()) as _) }, frame),
            None => Err(reason(error)),
        };
        let _ = tx.try_send(shot);
    });
    unsafe { SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(&filter, &config, Some(&done)) };
    Ok(())
}

fn wait(rx: Receiver<Shot>) -> Shot {
    let start = Instant::now();
    loop {
        if cancellation::cancelled() {
            return Err("Computer action cancelled".into());
        }
        match rx.recv_timeout(Duration::from_millis(20)) {
            Ok(shot) => return shot,
            Err(RecvTimeoutError::Disconnected) => return Err("Screen capture ended without an image.".into()),
            Err(RecvTimeoutError::Timeout) if start.elapsed() >= TIMEOUT => return Err("Screen capture timed out.".into()),
            Err(RecvTimeoutError::Timeout) => {
                CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, Duration::ZERO, true);
            }
        }
    }
}

fn reason(error: *mut NSError) -> String {
    unsafe { error.as_ref() }.map_or_else(|| "Screen capture returned nothing.".into(), |e| e.localizedDescription().to_string())
}

fn legacy(id: u32, frame: Rect) -> Shot {
    let bounds = core_graphics::geometry::CGRect::new(
        &core_graphics::geometry::CGPoint::new(frame.x, frame.y),
        &core_graphics::geometry::CGSize::new(frame.w, frame.h),
    );
    let image =
        create_image(bounds, kCGWindowListOptionIncludingWindow, id, kCGWindowImageBoundsIgnoreFraming | kCGWindowImageNominalResolution)
            .ok_or("Window capture returned nothing.")?;
    encode(&image, frame)
}

fn encode(image: &CGImage, frame: Rect) -> Shot {
    let data = NSMutableData::new();
    let kind = CFString::from_static_string("public.png");
    let written = unsafe {
        let destination = CGImageDestinationCreateWithData(Retained::as_ptr(&data).cast(), kind.as_concrete_TypeRef(), 1, std::ptr::null());
        if destination.is_null() {
            return Err("Could not encode the screenshot.".into());
        }
        let destination = CFType::wrap_under_create_rule(destination);
        CGImageDestinationAddImage(destination.as_CFTypeRef(), image.as_ptr().cast(), std::ptr::null());
        CGImageDestinationFinalize(destination.as_CFTypeRef())
    };
    if !written {
        return Err("Could not encode the screenshot.".into());
    }
    let (width, height) = (image.width() as u32, image.height() as u32);
    Ok(Screenshot {
        png_base64: base64::engine::general_purpose::STANDARD.encode(data.to_vec()),
        width,
        height,
        pixels_per_point: if frame.w > 0.0 { width as f64 / frame.w } else { 1.0 },
    })
}

fn cg(r: Rect) -> CGRect {
    CGRect::new(CGPoint::new(r.x, r.y), CGSize::new(r.w, r.h))
}

fn overlap(a: CGRect, b: CGRect) -> f64 {
    let w = (a.origin.x + a.size.width).min(b.origin.x + b.size.width) - a.origin.x.max(b.origin.x);
    let h = (a.origin.y + a.size.height).min(b.origin.y + b.size.height) - a.origin.y.max(b.origin.y);
    w.max(0.0) * h.max(0.0)
}

fn local(r: CGRect, display: CGRect) -> CGRect {
    CGRect::new(CGPoint::new(r.origin.x - display.origin.x, r.origin.y - display.origin.y), r.size)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f64, y: f64, w: f64, h: f64) -> CGRect {
        cg(Rect { x, y, w, h })
    }

    #[test]
    fn overlap_is_the_shared_area() {
        assert_eq!(overlap(rect(0.0, 0.0, 100.0, 100.0), rect(50.0, 60.0, 100.0, 100.0)), 50.0 * 40.0);
        assert_eq!(overlap(rect(0.0, 0.0, 10.0, 10.0), rect(10.0, 0.0, 10.0, 10.0)), 0.0);
        assert_eq!(overlap(rect(0.0, 0.0, 10.0, 10.0), rect(30.0, 30.0, 10.0, 10.0)), 0.0);
    }

    #[test]
    fn local_is_relative_to_the_display() {
        let r = local(rect(-1500.0, 200.0, 800.0, 600.0), rect(-1920.0, 0.0, 1920.0, 1080.0));
        assert_eq!((r.origin.x, r.origin.y, r.size.width, r.size.height), (420.0, 200.0, 800.0, 600.0));
    }
}
