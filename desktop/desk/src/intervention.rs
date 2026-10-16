use crate::protocol::{ErrorCode, Failure};
use core_foundation::runloop::{kCFRunLoopDefaultMode, CFRunLoop};
use core_graphics::event::{CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType, EventField};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

static TARGET_INTERVENED: AtomicBool = AtomicBool::new(false);
static SWITCH_INPUT: AtomicBool = AtomicBool::new(false);
static ROOT_TARGET: AtomicI32 = AtomicI32::new(0);
static DELEGATED_TARGET: AtomicI32 = AtomicI32::new(0);
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};
use std::time::Duration;

fn is_target_intervention(source: i64, destination: i64, own: i64, target: i32, delegated: i32) -> bool {
    source != own && (destination == i64::from(target) || (delegated != 0 && destination == i64::from(delegated)))
}

fn may_switch_apps(key: bool, flags: CGEventFlags, source: i64, destination: i64, own: i64, foreground: i32) -> bool {
    let chord = flags.intersects(CGEventFlags::CGEventFlagCommand | CGEventFlags::CGEventFlagControl);
    source != own && (destination != i64::from(foreground) || (key && chord))
}

pub fn target_took_foreground(pid: i32) -> bool {
    let delegated = DELEGATED_TARGET.load(Ordering::Acquire);
    !SWITCH_INPUT.load(Ordering::Acquire) && (pid == ROOT_TARGET.load(Ordering::Acquire) || (delegated != 0 && pid == delegated))
}

pub fn include_target(pid: i32) {
    let root = ROOT_TARGET.load(Ordering::Acquire);
    if root != 0 && pid != root {
        DELEGATED_TARGET.store(pid, Ordering::Release);
    }
}

pub struct Intervention {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Intervention {
    pub fn begin(target: i32, foreground: i32) -> Result<Self, Failure> {
        TARGET_INTERVENED.store(false, Ordering::Release);
        SWITCH_INPUT.store(false, Ordering::Release);
        ROOT_TARGET.store(target, Ordering::Release);
        DELEGATED_TARGET.store(0, Ordering::Release);
        let stop = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let quit = Arc::clone(&stop);
        let thread = thread::spawn(move || {
            let tap = CGEventTap::new(
                CGEventTapLocation::AnnotatedSession,
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
                        TARGET_INTERVENED.store(true, Ordering::Release);
                        return None;
                    }
                    let source = event.get_integer_value_field(EventField::EVENT_SOURCE_UNIX_PROCESS_ID);
                    let destination = event.get_integer_value_field(EventField::EVENT_TARGET_UNIX_PROCESS_ID);
                    let own = i64::from(std::process::id());
                    if !matches!(kind, CGEventType::FlagsChanged)
                        && may_switch_apps(matches!(kind, CGEventType::KeyDown), event.get_flags(), source, destination, own, foreground)
                    {
                        SWITCH_INPUT.store(true, Ordering::Release);
                    }
                    if is_target_intervention(source, destination, own, target, DELEGATED_TARGET.load(Ordering::Acquire)) {
                        TARGET_INTERVENED.store(true, Ordering::Release);
                    }
                    None
                },
            );
            let Ok(tap) = tap else {
                let _ = ready_tx.send(Err("Could not create the target-input event tap"));
                return;
            };
            let Ok(source) = tap.mach_port.create_runloop_source(0) else {
                let _ = ready_tx.send(Err("Could not create the target-input run-loop source"));
                return;
            };
            let runloop = CFRunLoop::get_current();
            runloop.add_source(&source, unsafe { kCFRunLoopDefaultMode });
            tap.enable();
            if ready_tx.send(Ok(())).is_ok() {
                while !quit.load(Ordering::Acquire) {
                    CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, Duration::from_millis(30), false);
                    let _ = crate::focus::check_current();
                }
            }
            runloop.remove_source(&source, unsafe { kCFRunLoopDefaultMode });
        });
        let ready = ready_rx.recv_timeout(Duration::from_millis(350));
        if matches!(ready, Ok(Ok(()))) {
            return Ok(Self { stop, thread: Some(thread) });
        }
        stop.store(true, Ordering::Release);
        let message = match ready {
            Ok(Err(message)) => message,
            Err(mpsc::RecvTimeoutError::Timeout) => "Target-input monitoring did not start within 350 ms",
            _ => "Target-input monitoring stopped before initialization",
        };
        Err(Failure::new(ErrorCode::ActionFailed, message))
    }

    pub fn check(&self) -> Result<(), Failure> {
        check_current()
    }
}

pub fn check_current() -> Result<(), Failure> {
    if TARGET_INTERVENED.load(Ordering::Acquire) {
        Err(Failure::new(ErrorCode::ActionFailed, "User interacted with target app; stopped"))
    } else {
        Ok(())
    }
}

impl Drop for Intervention {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        ROOT_TARGET.store(0, Ordering::Release);
        DELEGATED_TARGET.store(0, Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::{is_target_intervention, may_switch_apps};
    use core_graphics::event::CGEventFlags;

    #[test]
    fn ignores_agent_and_other_app_input() {
        assert!(is_target_intervention(99, 42, 10, 20, 42));
        assert!(!is_target_intervention(10, 42, 10, 20, 42));
        assert!(!is_target_intervention(99, 0, 10, 20, 0));
        assert!(!is_target_intervention(23, 42, 23, 42, 0));
        assert!(!is_target_intervention(17, 99, 23, 42, 0));
        assert!(is_target_intervention(0, 42, 23, 42, 0));
        assert!(is_target_intervention(17, 42, 23, 42, 0));
    }

    #[test]
    fn treats_input_outside_the_foreground_app_or_shortcuts_as_switching() {
        let none = CGEventFlags::empty();
        assert!(!may_switch_apps(true, none, 99, 7, 10, 7));
        assert!(!may_switch_apps(false, none, 99, 7, 10, 7));
        assert!(!may_switch_apps(true, CGEventFlags::CGEventFlagShift, 99, 7, 10, 7));
        assert!(may_switch_apps(true, CGEventFlags::CGEventFlagCommand, 99, 7, 10, 7));
        assert!(may_switch_apps(true, CGEventFlags::CGEventFlagControl, 99, 7, 10, 7));
        assert!(!may_switch_apps(false, CGEventFlags::CGEventFlagCommand, 99, 7, 10, 7));
        assert!(may_switch_apps(false, none, 99, 8, 10, 7));
        assert!(may_switch_apps(true, none, 99, 0, 10, 7));
        assert!(!may_switch_apps(true, CGEventFlags::CGEventFlagCommand, 10, 8, 10, 7));
    }
}
