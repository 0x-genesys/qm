use super::*;
use core_foundation::runloop::{kCFRunLoopDefaultMode, CFRunLoop, CFRunLoopSource};
use std::cell::Cell;

type Callback = extern "C" fn(CFTypeRef, CFTypeRef, CFStringRef, *mut c_void);

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXObserverCreate(pid: i32, callback: Callback, out: *mut CFTypeRef) -> i32;
    fn AXObserverAddNotification(observer: CFTypeRef, e: CFTypeRef, name: CFStringRef, refcon: *mut c_void) -> i32;
    fn AXObserverGetRunLoopSource(observer: CFTypeRef) -> CFTypeRef;
}

const NOTIFICATIONS: &[&str] = &[
    "AXFocusedUIElementChanged",
    "AXFocusedWindowChanged",
    "AXMainWindowChanged",
    "AXWindowCreated",
    "AXValueChanged",
    "AXSelectedTextChanged",
    "AXSelectedChildrenChanged",
    "AXSelectedRowsChanged",
    "AXMenuOpened",
    "AXMenuClosed",
    "AXLayoutChanged",
    "AXCreated",
    "AXUIElementDestroyed",
    "AXTitleChanged",
    "AXRowCountChanged",
    "AXLoadComplete",
];
const MIN: Duration = Duration::from_millis(60);
const QUIET: Duration = Duration::from_millis(120);
const CAP: Duration = Duration::from_millis(800);

extern "C" fn noted(_: CFTypeRef, _: CFTypeRef, _: CFStringRef, last: *mut c_void) {
    if let Some(last) = unsafe { (last as *const Cell<Option<Instant>>).as_ref() } {
        last.set(Some(Instant::now()));
    }
}

pub(super) struct Quiet {
    _observer: CFType,
    source: CFRunLoopSource,
    last: Box<Cell<Option<Instant>>>,
}

impl Quiet {
    pub(super) fn new(pid: i32, ax: &El) -> Option<Quiet> {
        let mut observer: CFTypeRef = std::ptr::null();
        if unsafe { AXObserverCreate(pid, noted, &mut observer) } != 0 || observer.is_null() {
            return None;
        }
        let observer = unsafe { CFType::wrap_under_create_rule(observer) };
        let last = Box::new(Cell::new(None));
        let refcon = &*last as *const Cell<Option<Instant>> as *mut c_void;
        let added = NOTIFICATIONS
            .iter()
            .filter(|n| unsafe { AXObserverAddNotification(observer.as_CFTypeRef(), ax.as_CFTypeRef(), cfs(n).as_concrete_TypeRef(), refcon) } == 0)
            .count();
        let source = unsafe { AXObserverGetRunLoopSource(observer.as_CFTypeRef()) };
        if added == 0 || source.is_null() {
            return None;
        }
        let source = unsafe { CFRunLoopSource::wrap_under_get_rule(source as _) };
        CFRunLoop::get_current().add_source(&source, unsafe { kCFRunLoopDefaultMode });
        Some(Quiet { _observer: observer, source, last })
    }

    pub(super) fn wait(&self) {
        let start = Instant::now();
        while start.elapsed() < CAP && !cancellation::cancelled() {
            CFRunLoop::run_in_mode(unsafe { kCFRunLoopDefaultMode }, Duration::from_millis(15), true);
            let since = self.last.get().map_or(start.elapsed(), |t| t.elapsed());
            if start.elapsed() >= MIN && since >= QUIET {
                break;
            }
        }
    }

    pub(super) fn reset(&self) {
        self.last.set(None);
    }
}

impl Drop for Quiet {
    fn drop(&mut self) {
        CFRunLoop::get_current().remove_source(&self.source, unsafe { kCFRunLoopDefaultMode });
    }
}
