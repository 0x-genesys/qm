use crate::protocol::{ErrorCode, Failure};
use core_foundation::base::{CFTypeRef, TCFType};
use core_foundation::string::{CFString, CFStringRef};
use objc2::msg_send;
use objc2::rc::autoreleasepool;
use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType};
use objc2_foundation::NSPoint;
use std::ffi::c_void;
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::{Duration, Instant};

static EXPECTED_FOREGROUND: AtomicI32 = AtomicI32::new(0);

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventPostToPid(pid: i32, event: *mut c_void);
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFDictionaryGetValue(dict: CFTypeRef, key: CFTypeRef) -> CFTypeRef;
    fn CFBooleanGetValue(value: CFTypeRef) -> bool;
    fn CFBooleanGetTypeID() -> usize;
    fn CFGetTypeID(value: CFTypeRef) -> usize;
    fn CGSessionCopyCurrentDictionary() -> CFTypeRef;
    fn AXUIElementCreateSystemWide() -> CFTypeRef;
    fn AXUIElementCopyAttributeValue(element: CFTypeRef, attribute: CFStringRef, value: *mut CFTypeRef) -> i32;
    fn AXUIElementGetPid(element: CFTypeRef, pid: *mut i32) -> i32;
}

fn screen_available() -> bool {
    let session = unsafe { CGSessionCopyCurrentDictionary() };
    if session.is_null() {
        return false;
    }
    let field = |name: &str| {
        let key = CFString::new(name);
        let v = unsafe { CFDictionaryGetValue(session, key.as_CFTypeRef()) };
        if v.is_null() || unsafe { CFGetTypeID(v) } != unsafe { CFBooleanGetTypeID() } {
            None
        } else {
            Some(unsafe { CFBooleanGetValue(v) })
        }
    };
    let available = field("CGSSessionScreenIsLocked") != Some(true) && field("kCGSSessionOnConsoleKey") == Some(true);
    unsafe { core_foundation::base::CFRelease(session) };
    available
}

fn synthetic_focus(pid: i32, window: u32, subtype: i16) -> Result<(), Failure> {
    autoreleasepool(|_| {
        let event = NSEvent::otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2(
            NSEventType::AppKitDefined,
            NSPoint::new(0.0, 0.0),
            NSEventModifierFlags(if window == 0 { 0 } else { 0xc0000 }),
            0.0,
            window as isize,
            None,
            subtype,
            0,
            0,
        )
        .ok_or_else(|| Failure::new(ErrorCode::ActionFailed, "Cannot create background focus event"))?;
        let cg: *mut c_void = unsafe { msg_send![&*event, CGEvent] };
        if cg.is_null() {
            return Err(Failure::new(ErrorCode::ActionFailed, "Cannot convert background focus event"));
        }
        unsafe { CGEventPostToPid(pid, cg) };
        Ok::<(), Failure>(())
    })?;
    Ok(())
}

fn frontmost() -> Option<i32> {
    let system = unsafe { AXUIElementCreateSystemWide() };
    if system.is_null() {
        return None;
    }
    let key = CFString::new("AXFocusedApplication");
    let mut app: CFTypeRef = std::ptr::null();
    let status = unsafe { AXUIElementCopyAttributeValue(system, key.as_concrete_TypeRef(), &mut app) };
    unsafe { core_foundation::base::CFRelease(system) };
    if status != 0 || app.is_null() {
        return None;
    }
    let mut pid = 0;
    let status = unsafe { AXUIElementGetPid(app, &mut pid) };
    unsafe { core_foundation::base::CFRelease(app) };
    (status == 0 && pid > 0).then_some(pid)
}

pub struct Focus {
    target: i32,
    activated: bool,
    intervention: Option<crate::intervention::Intervention>,
}

impl Focus {
    pub fn begin(target: i32, window: u32) -> Result<Self, Failure> {
        if !screen_available() {
            return Err(Failure::new(ErrorCode::ActionFailed, "Screen is locked or console session unavailable"));
        }
        let original = frontmost().ok_or_else(|| Failure::new(ErrorCode::ActionFailed, "Cannot identify the foreground app"))?;
        let intervention = crate::intervention::Intervention::begin(target)?;
        if original == target {
            EXPECTED_FOREGROUND.store(original, Ordering::Release);
            return Ok(Self { target, activated: false, intervention: Some(intervention) });
        }
        if window == 0 {
            return Err(Failure::new(ErrorCode::ActionFailed, "Background window has no ID; observe again"));
        }
        synthetic_focus(target, window, 1)?;
        let guard = Self { target, activated: true, intervention: Some(intervention) };
        EXPECTED_FOREGROUND.store(original, Ordering::Release);
        guard.check()?;
        Ok(guard)
    }

    pub fn check(&self) -> Result<(), Failure> {
        check_current()?;
        if let Some(intervention) = &self.intervention {
            intervention.check()?;
        }
        Ok(())
    }
}

pub fn check_current() -> Result<(), Failure> {
    let expected = EXPECTED_FOREGROUND.load(Ordering::Acquire);
    if expected == 0 {
        return Ok(());
    }
    if !screen_available() {
        return Err(Failure::new(ErrorCode::ActionFailed, "Screen is locked or console session unavailable"));
    }
    crate::intervention::check_current()?;
    if frontmost() != Some(expected) {
        return Err(Failure::new(ErrorCode::ActionFailed, "Foreground app changed during background input; stopped"));
    }
    Ok(())
}

impl Drop for Focus {
    fn drop(&mut self) {
        EXPECTED_FOREGROUND.store(0, Ordering::Release);
        if self.activated {
            let until = Instant::now() + Duration::from_millis(80);
            while Instant::now() < until && !crate::cancellation::cancelled() {
                std::thread::sleep(Duration::from_millis(8));
            }
            if frontmost() != Some(self.target) {
                let _ = synthetic_focus(self.target, 0, 2);
            }
        }
    }
}
