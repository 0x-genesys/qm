use crate::protocol::{ErrorCode, Failure};
use core_foundation::runloop::{kCFRunLoopDefaultMode, CFRunLoop};
use core_graphics::event::{CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType, EventField};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};
use std::time::Duration;

pub struct Intervention {
    detected: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Intervention {
    pub fn begin(target: i32) -> Result<Self, Failure> {
        let detected = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let seen = Arc::clone(&detected);
        let quit = Arc::clone(&stop);
        let thread = thread::spawn(move || {
            let tap = CGEventTap::new(
                CGEventTapLocation::Session,
                CGEventTapPlacement::HeadInsertEventTap,
                CGEventTapOptions::ListenOnly,
                vec![
                    CGEventType::LeftMouseDown,
                    CGEventType::RightMouseDown,
                    CGEventType::OtherMouseDown,
                    CGEventType::KeyDown,
                    CGEventType::FlagsChanged,
                ],
                move |_, kind, event| {
                    if matches!(kind, CGEventType::TapDisabledByTimeout | CGEventType::TapDisabledByUserInput) {
                        seen.store(true, Ordering::Release);
                        return None;
                    }
                    let source = event.get_integer_value_field(EventField::EVENT_SOURCE_UNIX_PROCESS_ID);
                    let destination = event.get_integer_value_field(EventField::EVENT_TARGET_UNIX_PROCESS_ID);
                    if source != i64::from(std::process::id()) && destination == i64::from(target) {
                        seen.store(true, Ordering::Release);
                    }
                    None
                },
            );
            let Ok(tap) = tap else {
                let _ = ready_tx.send(false);
                return;
            };
            let Ok(source) = tap.mach_port.create_runloop_source(0) else {
                let _ = ready_tx.send(false);
                return;
            };
            let runloop = CFRunLoop::get_current();
            runloop.add_source(&source, unsafe { kCFRunLoopDefaultMode });
            tap.enable();
            if ready_tx.send(true).is_ok() {
                while !quit.load(Ordering::Acquire) {
                    CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, Duration::from_millis(30), false);
                }
            }
            runloop.remove_source(&source, unsafe { kCFRunLoopDefaultMode });
        });
        match ready_rx.recv_timeout(Duration::from_millis(350)) {
            Ok(true) => Ok(Self { detected, stop, thread: Some(thread) }),
            _ => {
                stop.store(true, Ordering::Release);
                Err(Failure::new(ErrorCode::ActionFailed, "Cannot monitor input to target app"))
            }
        }
    }

    pub fn check(&self) -> Result<(), Failure> {
        if self.detected.load(Ordering::Acquire) {
            Err(Failure::new(ErrorCode::ActionFailed, "User interacted with target app; stopped"))
        } else {
            Ok(())
        }
    }
}

impl Drop for Intervention {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
