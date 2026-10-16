use crate::cancellation;
use crate::protocol::*;
use crate::text::{self, Key as TextKey, Stroke};
use crate::tree::{self, Key, Locator, Props, ROOT};
use core_foundation::array::CFArray;
use core_foundation::base::{CFType, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::data::CFData;
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::event::{CGEvent, CGEventFlags, CGEventType, CGMouseButton, EventField, ScrollEventUnit};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::{CGPoint, CGSize};
use foreign_types::ForeignType;
use objc2_app_kit::{NSApplicationActivationPolicy, NSWorkspace};
use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{Duration, Instant};

type El = CFType;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXUIElementCreateApplication(pid: i32) -> CFTypeRef;
    fn AXUIElementCopyAttributeValue(e: CFTypeRef, a: CFStringRef, v: *mut CFTypeRef) -> i32;
    fn AXUIElementCopyMultipleAttributeValues(e: CFTypeRef, names: CFTypeRef, options: u32, v: *mut CFTypeRef) -> i32;
    fn AXValueGetTypeID() -> usize;
    fn AXValueGetType(v: CFTypeRef) -> u32;
    fn AXUIElementSetAttributeValue(e: CFTypeRef, a: CFStringRef, v: CFTypeRef) -> i32;
    fn AXUIElementIsAttributeSettable(e: CFTypeRef, a: CFStringRef, v: *mut bool) -> i32;
    fn AXUIElementCopyActionNames(e: CFTypeRef, v: *mut CFTypeRef) -> i32;
    fn AXUIElementPerformAction(e: CFTypeRef, a: CFStringRef) -> i32;
    fn AXUIElementCopyElementAtPosition(app: CFTypeRef, x: f32, y: f32, e: *mut CFTypeRef) -> i32;
    fn AXUIElementSetMessagingTimeout(e: CFTypeRef, t: f32) -> i32;
    fn AXValueGetValue(v: CFTypeRef, kind: u32, out: *mut c_void) -> bool;
    fn AXValueCreate(kind: u32, value: *const c_void) -> CFTypeRef;
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(o: CFTypeRef) -> bool;
    fn _AXUIElementGetWindow(e: CFTypeRef, id: *mut u32) -> i32;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
    fn CGEventSetLocation(e: *mut c_void, p: CGPoint);
}

#[link(name = "Carbon", kind = "framework")]
extern "C" {
    fn TISCopyCurrentKeyboardLayoutInputSource() -> CFTypeRef;
    fn TISCopyCurrentASCIICapableKeyboardLayoutInputSource() -> CFTypeRef;
    fn TISGetInputSourceProperty(source: CFTypeRef, key: CFStringRef) -> CFTypeRef;
    static kTISPropertyUnicodeKeyLayoutData: CFStringRef;
    fn LMGetKbdType() -> u8;
    #[allow(clippy::too_many_arguments)]
    fn UCKeyTranslate(
        layout: *const u8,
        code: u16,
        action: u16,
        modifiers: u32,
        keyboard: u32,
        options: u32,
        dead: *mut u32,
        max: usize,
        len: *mut usize,
        out: *mut u16,
    ) -> i32;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFHash(cf: CFTypeRef) -> usize;
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
    fn CFURLGetTypeID() -> usize;
    fn CFURLGetString(url: CFTypeRef) -> CFStringRef;
}

const MAX_TREE_CHARS: usize = 60_000;
const MAX_VISITS: usize = 6_000;
const MAX_BUSY_VISITS: usize = 800;
const MAX_DEPTH: usize = 200;
const MAX_INDENT: usize = 50;
const CLIPS: &[&str] = &["AXScrollArea", "AXWebArea"];
const BORING: &[&str] = &["AXShowMenu", "AXScrollToVisible", "AXShowDefaultUI", "AXShowAlternateUI"];
const SPARSE: &[&str] = &["AXWebArea", "AXGroup", "AXScrollArea", "AXLayoutArea", "AXUnknown"];
const TRANSIENT: &[&str] = &["AXDialog", "AXSystemDialog", "AXFloatingWindow", "AXSystemFloatingWindow"];
const POPUPS: &[&str] = &["AXSheet", "AXPopover", "AXDrawer", "AXMenu"];
const INVALID_ELEMENT: i32 = -25202;
const FETCH: &[&str] = &[
    "AXRole",
    "AXSubrole",
    "AXTitle",
    "AXDescription",
    "AXHelp",
    "AXValue",
    "AXPlaceholderValue",
    "AXURL",
    "AXIdentifier",
    "AXExpanded",
    "AXFocused",
    "AXEnabled",
    "AXSelected",
    "AXTitleUIElement",
    "AXPosition",
    "AXSize",
    "AXChildren",
];
const BUSY: &[&str] = &["AXBusyIndicator", "AXProgressIndicator"];
const PRESS_MS: u64 = 50;
const HOVER_MS: u64 = 30;
static EVENT_NUMBER: AtomicI64 = AtomicI64::new(1);
const SETTLE: Duration = Duration::from_millis(1000);

struct App {
    name: String,
    bundle: Option<String>,
    pid: i32,
    active: bool,
}

struct Snapshot {
    window: u32,
    window_element: El,
    origin: (f64, f64),
    elements: Vec<(u32, El)>,
    lines: HashMap<Key, String>,
    ids: tree::Ids<El>,
}

#[derive(Default)]
pub struct Desk {
    cache: HashMap<i32, Snapshot>,
    touched: HashMap<i32, Instant>,
    enabled: HashSet<i32>,
    enhanced: HashSet<i32>,
}

impl Drop for Desk {
    fn drop(&mut self) {
        for pid in &self.enhanced {
            set_attr(&app_element(*pid), "AXEnhancedUserInterface", &CFBoolean::false_value().as_CFType());
        }
    }
}

fn fail(code: ErrorCode, m: impl Into<String>) -> Failure {
    Failure::new(code, m)
}

fn cfs(s: &str) -> CFString {
    CFString::new(s)
}

fn attr(e: &El, name: &str) -> Option<CFType> {
    let mut v: CFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(e.as_CFTypeRef(), cfs(name).as_concrete_TypeRef(), &mut v) };
    (err == 0 && !v.is_null()).then(|| unsafe { CFType::wrap_under_create_rule(v) })
}

fn dead(e: &El) -> bool {
    let mut v: CFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(e.as_CFTypeRef(), cfs("AXRole").as_concrete_TypeRef(), &mut v) };
    if !v.is_null() {
        drop(unsafe { CFType::wrap_under_create_rule(v) });
    }
    err == INVALID_ELEMENT
}

fn app_element(pid: i32) -> El {
    unsafe { CFType::wrap_under_create_rule(AXUIElementCreateApplication(pid)) }
}

fn text_of(v: &CFType) -> Option<String> {
    if let Some(s) = v.downcast::<CFString>() {
        return Some(s.to_string());
    }
    if unsafe { CFGetTypeID(v.as_CFTypeRef()) == CFURLGetTypeID() } {
        let s = unsafe { CFURLGetString(v.as_CFTypeRef()) };
        return (!s.is_null()).then(|| unsafe { CFString::wrap_under_get_rule(s) }.to_string());
    }
    let n = v.downcast::<CFNumber>()?;
    n.to_i64().map(|i| i.to_string()).or_else(|| n.to_f64().map(|f| f.to_string()))
}

fn str_attr(e: &El, name: &str) -> Option<String> {
    attr(e, name).and_then(|v| text_of(&v)).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn bool_attr(e: &El, name: &str) -> Option<bool> {
    attr(e, name).and_then(|v| v.downcast::<CFBoolean>()).map(bool::from)
}

fn settable(e: &El, name: &str) -> bool {
    let mut b = false;
    unsafe { AXUIElementIsAttributeSettable(e.as_CFTypeRef(), cfs(name).as_concrete_TypeRef(), &mut b) == 0 && b }
}

fn ax_value<T: Default>(e: &El, name: &str, kind: u32) -> Option<T> {
    let v = attr(e, name)?;
    let mut out = T::default();
    unsafe { AXValueGetValue(v.as_CFTypeRef(), kind, &mut out as *mut T as *mut c_void) }.then_some(out)
}

fn frame(e: &El) -> Option<Rect> {
    let p: CGPoint = ax_value(e, "AXPosition", 1)?;
    let s: CGSize = ax_value(e, "AXSize", 2)?;
    Some(Rect { x: p.x, y: p.y, w: s.width, h: s.height })
}

fn list(v: CFType) -> Vec<CFType> {
    v.downcast::<CFArray>().map(|a| a.iter().map(|p| unsafe { CFType::wrap_under_get_rule(*p) }).collect()).unwrap_or_default()
}

fn actions(e: &El) -> Vec<String> {
    let mut v: CFTypeRef = std::ptr::null();
    if unsafe { AXUIElementCopyActionNames(e.as_CFTypeRef(), &mut v) } != 0 || v.is_null() {
        return vec![];
    }
    list(unsafe { CFType::wrap_under_create_rule(v) }).iter().filter_map(text_of).collect()
}

fn set_attr(e: &El, name: &str, v: &CFType) -> i32 {
    unsafe { AXUIElementSetAttributeValue(e.as_CFTypeRef(), cfs(name).as_concrete_TypeRef(), v.as_CFTypeRef()) }
}

fn perform(e: &El, action: &str) -> Result<(), Failure> {
    match unsafe { AXUIElementPerformAction(e.as_CFTypeRef(), cfs(action).as_concrete_TypeRef()) } {
        0 => Ok(()),
        n => Err(fail(ErrorCode::ActionFailed, format!("{action} failed (AXError {n})"))),
    }
}

fn running() -> Vec<App> {
    NSWorkspace::sharedWorkspace()
        .runningApplications()
        .iter()
        .filter(|a| a.activationPolicy() == NSApplicationActivationPolicy::Regular)
        .map(|a| App {
            name: a.localizedName().map(|s| s.to_string()).unwrap_or_default(),
            bundle: a.bundleIdentifier().map(|s| s.to_string()),
            pid: a.processIdentifier(),
            active: a.isActive(),
        })
        .collect()
}

fn pt(x: f64, y: f64) -> CGPoint {
    CGPoint::new(x, y)
}

fn source() -> Result<CGEventSource, Failure> {
    CGEventSource::new(CGEventSourceStateID::HIDSystemState).map_err(|_| fail(ErrorCode::ActionFailed, "no event source"))
}

fn post(e: CGEvent, pid: i32) {
    e.post_to_pid(pid);
    std::thread::sleep(Duration::from_millis(8));
}

fn in_window(e: &CGEvent, win: u32) {
    e.set_integer_value_field(EventField::MOUSE_EVENT_WINDOW_UNDER_MOUSE_POINTER, win as i64);
    e.set_integer_value_field(EventField::MOUSE_EVENT_WINDOW_UNDER_MOUSE_POINTER_THAT_CAN_HANDLE_THIS_EVENT, win as i64);
}

struct Press {
    win: u32,
    number: i64,
}

fn mouse(pid: i32, at: &Press, ty: CGEventType, p: CGPoint, b: CGMouseButton, clicks: i64, flags: CGEventFlags) -> Result<(), Failure> {
    let e = CGEvent::new_mouse_event(source()?, ty, p, b).map_err(|_| fail(ErrorCode::ActionFailed, "mouse event"))?;
    e.set_flags(flags);
    e.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, clicks);
    e.set_integer_value_field(EventField::MOUSE_EVENT_NUMBER, at.number);
    in_window(&e, at.win);
    e.set_integer_value_field(EventField::EVENT_SOURCE_UNIX_PROCESS_ID, std::process::id() as i64);
    post(e, pid);
    Ok(())
}

fn hit(ax: &El, p: CGPoint) -> Option<(El, bool)> {
    let mut v: CFTypeRef = std::ptr::null();
    if unsafe { AXUIElementCopyElementAtPosition(ax.as_CFTypeRef(), p.x as f32, p.y as f32, &mut v) } != 0 || v.is_null() {
        return None;
    }
    let mut e = unsafe { CFType::wrap_under_create_rule(v) };
    let mut web = false;
    for _ in 0..MAX_DEPTH {
        match str_attr(&e, "AXRole").as_deref() {
            Some("AXWebArea") => web = true,
            Some("AXWindow") => return Some((e, web)),
            _ => {}
        }
        e = attr(&e, "AXParent")?;
    }
    None
}

fn prepare(pid: i32, ax: &El, win: u32, p: CGPoint) -> Result<Press, Failure> {
    active()?;
    let win = match hit(ax, p) {
        Some((w, _web)) if window_id(&w) != 0 => window_id(&w),
        _ => win,
    };
    mouse(pid, &Press { win, number: 0 }, CGEventType::MouseMoved, p, CGMouseButton::Left, 0, CGEventFlags::empty())?;
    cancellation::wait(Duration::from_millis(HOVER_MS));
    Ok(Press { win, number: EVENT_NUMBER.fetch_add(1, Ordering::Relaxed) })
}

fn click_at(pid: i32, press: Press, p: CGPoint, button: Button, count: u8, mods: &[Modifier], hold: u32) -> Result<(), Failure> {
    with_modifiers(pid, flags(mods), || click_at_inner(pid, press, p, button, count, mods, hold))
}

fn click_at_inner(pid: i32, mut press: Press, p: CGPoint, button: Button, count: u8, mods: &[Modifier], hold: u32) -> Result<(), Failure> {
    let hold = if hold == 0 { PRESS_MS } else { hold.min(10_000) as u64 };
    let (down, up, b) = match button {
        Button::Left => (CGEventType::LeftMouseDown, CGEventType::LeftMouseUp, CGMouseButton::Left),
        Button::Right => (CGEventType::RightMouseDown, CGEventType::RightMouseUp, CGMouseButton::Right),
        Button::Middle => (CGEventType::OtherMouseDown, CGEventType::OtherMouseUp, CGMouseButton::Center),
    };
    for n in 1..=count.max(1) as i64 {
        active()?;
        if n > 1 {
            press.number = EVENT_NUMBER.fetch_add(1, Ordering::Relaxed);
        }
        mouse(pid, &press, down, p, b, n, flags(mods))?;
        cancellation::wait(Duration::from_millis(hold));
        mouse(pid, &press, up, p, b, n, flags(mods))?;
    }
    Ok(())
}

fn key(pid: i32, code: u16, flags: CGEventFlags, text: Option<&str>, hold: u32) -> Result<(), Failure> {
    send_key_events(pid, crate::keys::events(code, flags.bits()), text, hold)
}

fn send_key_events(pid: i32, steps: Vec<crate::keys::Event>, text: Option<&str>, hold: u32) -> Result<(), Failure> {
    active()?;
    let prepared = steps.into_iter().map(|step| key_event(step, text)).collect::<Result<Vec<_>, _>>()?;
    let mut failure = None;
    let mut releasing = false;
    for (step, e) in prepared {
        if step.release && !releasing {
            cancellation::wait(Duration::from_millis(hold.min(10_000) as u64));
            releasing = true;
        }
        if step.release && failure.is_none() {
            failure = active().err();
        }
        if !step.release {
            if failure.is_none() {
                failure = active().err();
            }
            if failure.is_some() {
                continue;
            }
        }
        post(e, pid);
    }
    failure.map_or(Ok(()), Err)
}

fn key_event(step: crate::keys::Event, text: Option<&str>) -> Result<(crate::keys::Event, CGEvent), Failure> {
    let e = CGEvent::new_keyboard_event(source()?, step.code, step.down).map_err(|_| fail(ErrorCode::ActionFailed, "key event"))?;
    if step.modifier {
        e.set_type(CGEventType::FlagsChanged);
    }
    e.set_flags(CGEventFlags::from_bits_truncate(step.flags));
    if !step.modifier {
        if let Some(t) = text {
            e.set_string(t);
        }
    }
    Ok((step, e))
}

fn with_modifiers(pid: i32, flags: CGEventFlags, action: impl FnOnce() -> Result<(), Failure>) -> Result<(), Failure> {
    let prepared = crate::keys::events(0, flags.bits())
        .into_iter()
        .filter(|e| e.modifier)
        .map(|step| key_event(step, None))
        .collect::<Result<Vec<_>, _>>()?;
    let (down, up): (Vec<_>, Vec<_>) = prepared.into_iter().partition(|(step, _)| !step.release);
    let result = (|| {
        for (_, event) in down {
            active()?;
            post(event, pid);
        }
        action()
    })();
    for (_, event) in up {
        post(event, pid);
    }
    result
}

fn layout_data(source: CFTypeRef) -> Option<CFData> {
    if source.is_null() {
        return None;
    }
    let source = unsafe { CFType::wrap_under_create_rule(source) };
    let data = unsafe { TISGetInputSourceProperty(source.as_CFTypeRef(), kTISPropertyUnicodeKeyLayoutData) };
    (!data.is_null()).then(|| unsafe { CFData::wrap_under_get_rule(data as _) })
}

fn keyboard() -> HashMap<char, Stroke> {
    keyboard_for_flags(CGEventFlags::empty())
}

fn keyboard_for_flags(flags: CGEventFlags) -> HashMap<char, Stroke> {
    let Some(data) = layout_data(unsafe { TISCopyCurrentKeyboardLayoutInputSource() })
        .or_else(|| layout_data(unsafe { TISCopyCurrentASCIICapableKeyboardLayoutInputSource() }))
    else {
        return HashMap::new();
    };
    let kind = unsafe { LMGetKbdType() } as u32;
    text::layout(|code, shift, option| {
        let modifiers =
            if shift { 2 } else { 0 } | if option { 8 } else { 0 } | if flags.contains(CGEventFlags::CGEventFlagCommand) { 1 } else { 0 };
        let (mut dead, mut len, mut out) = (0u32, 0usize, [0u16; 4]);
        let status =
            unsafe { UCKeyTranslate(data.bytes().as_ptr(), code, 0, modifiers, kind, 0, &mut dead, out.len(), &mut len, out.as_mut_ptr()) };
        if status != 0 || dead != 0 {
            return None;
        }
        let mut chars = char::decode_utf16(out[..len].iter().copied());
        match (chars.next(), chars.next()) {
            (Some(Ok(c)), None) => Some(c),
            _ => None,
        }
    })
}

fn type_text(pid: i32, s: &str) -> Result<(), Failure> {
    for k in text::plan(s, &keyboard()) {
        match k {
            TextKey::Return => key(pid, chord("return")?.0, CGEventFlags::empty(), None, 0)?,
            TextKey::Tab => key(pid, chord("tab")?.0, CGEventFlags::empty(), None, 0)?,
            TextKey::Mapped(c, stroke) => {
                let mut mods = vec![];
                if stroke.shift {
                    mods.push(Modifier::Shift);
                }
                if stroke.option {
                    mods.push(Modifier::Option);
                }
                key(pid, stroke.code, flags(&mods), Some(&c.to_string()), 0)?
            }
            TextKey::Unicode(c) => key(pid, 0, CGEventFlags::empty(), Some(&c.to_string()), 0)?,
        }
    }
    Ok(())
}

fn paste(pid: i32, s: &str, format: PasteFormat) -> Result<(), Failure> {
    let v = match keyboard().get(&'v') {
        Some(k) => k.code,
        None => chord("v")?.0,
    };
    let cmd_v = || key(pid, v, CGEventFlags::CGEventFlagCommand, Some("v"), 0);
    crate::pasteboard::paste(s, format, cmd_v, &cancellation::cancelled)
}

fn active() -> Result<(), Failure> {
    if cancellation::cancelled() {
        Err(fail(ErrorCode::ActionFailed, "Computer action cancelled"))
    } else {
        crate::focus::check_current()
    }
}

fn chord(k: &str) -> Result<(u16, Vec<Modifier>), Failure> {
    let parsed = crate::keys::parse(k).ok_or_else(|| fail(ErrorCode::UnknownKey, format!("unknown key {k}")))?;
    let mods = [
        (crate::keys::COMMAND, Modifier::Command),
        (crate::keys::SHIFT, Modifier::Shift),
        (crate::keys::OPTION, Modifier::Option),
        (crate::keys::CONTROL, Modifier::Control),
    ]
    .into_iter()
    .filter_map(|(bit, m)| (parsed.flags & bit != 0).then_some(m))
    .collect();
    Ok((parsed.code, mods))
}

fn flags(mods: &[Modifier]) -> CGEventFlags {
    mods.iter().fold(CGEventFlags::empty(), |f, m| {
        f | match m {
            Modifier::Command => CGEventFlags::CGEventFlagCommand,
            Modifier::Shift => CGEventFlags::CGEventFlagShift,
            Modifier::Option => CGEventFlags::CGEventFlagAlternate,
            Modifier::Control => CGEventFlags::CGEventFlagControl,
        }
    })
}

fn center(w: &El) -> CGPoint {
    frame(w).map(|f| pt(f.x + f.w / 2.0, f.y + f.h / 2.0)).unwrap_or(pt(0.0, 0.0))
}

fn window_of(app: &El) -> Option<El> {
    let candidates = [attr(app, "AXFocusedWindow"), attr(app, "AXMainWindow")]
        .into_iter()
        .flatten()
        .chain(attr(app, "AXWindows").into_iter().flat_map(list));
    for window in candidates {
        if bool_attr(&window, "AXMinimized") == Some(true) || window_id(&window) == 0 {
            continue;
        }
        let sheet = attr(&window, "AXSheets").into_iter().flat_map(list).next();
        if let Some(sheet) = sheet.filter(|sheet| window_id(sheet) != 0) {
            return Some(sheet);
        }
        return Some(window);
    }
    None
}

fn window_id(w: &El) -> u32 {
    let mut id = 0;
    unsafe { _AXUIElementGetWindow(w.as_CFTypeRef(), &mut id) };
    id
}

struct Node {
    props: Props,
    raw: Option<String>,
    frame: Option<Rect>,
    children: Vec<El>,
}

thread_local! {
    static FETCH_NAMES: CFArray<CFString> = CFArray::from_CFTypes(&FETCH.iter().map(|n| cfs(n)).collect::<Vec<_>>());
}

fn fetch_all(e: &El) -> Vec<Option<CFType>> {
    let mut v: CFTypeRef = std::ptr::null();
    let err =
        FETCH_NAMES.with(|names| unsafe { AXUIElementCopyMultipleAttributeValues(e.as_CFTypeRef(), names.as_CFTypeRef(), 0, &mut v) });
    if err != 0 || v.is_null() {
        if !v.is_null() {
            drop(unsafe { CFType::wrap_under_create_rule(v) });
        }
        return FETCH.iter().map(|n| attr(e, n)).collect();
    }
    let values = list(unsafe { CFType::wrap_under_create_rule(v) });
    let error = |x: &CFType| unsafe { CFGetTypeID(x.as_CFTypeRef()) == AXValueGetTypeID() && AXValueGetType(x.as_CFTypeRef()) == 5 };
    let mut out: Vec<Option<CFType>> = values.into_iter().map(|x| (!error(&x)).then_some(x)).collect();
    out.resize(FETCH.len(), None);
    out
}

fn point_of<T: Default>(v: &CFType, kind: u32) -> Option<T> {
    let mut out = T::default();
    unsafe { AXValueGetValue(v.as_CFTypeRef(), kind, &mut out as *mut T as *mut c_void) }.then_some(out)
}

fn fetch(e: &El) -> Node {
    let v = fetch_all(e);
    let get = |name: &str| v[FETCH.iter().position(|n| *n == name).unwrap()].as_ref();
    let s = |name: &str| get(name).and_then(text_of).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let b = |name: &str| get(name).and_then(|v| v.downcast::<CFBoolean>()).map(bool::from);
    let title = s("AXTitle");
    let label = if title.is_none() {
        get("AXTitleUIElement").and_then(|l| str_attr(l, "AXValue").or_else(|| str_attr(l, "AXTitle")))
    } else {
        None
    };
    let has_value = get("AXValue").is_some();
    let props = Props {
        role: s("AXRole").unwrap_or_else(|| "AXUnknown".into()),
        subrole: s("AXSubrole"),
        title,
        description: s("AXDescription").or_else(|| s("AXHelp")),
        label,
        value: s("AXValue"),
        placeholder: s("AXPlaceholderValue"),
        url: s("AXURL"),
        identifier: s("AXIdentifier"),
        expanded: b("AXExpanded"),
        focused: b("AXFocused") == Some(true),
        disabled: b("AXEnabled") == Some(false),
        selected: b("AXSelected") == Some(true),
        settable: has_value,
        actions: vec![],
    };
    let frame = match (get("AXPosition").and_then(|p| point_of::<CGPoint>(p, 1)), get("AXSize").and_then(|p| point_of::<CGSize>(p, 2))) {
        (Some(p), Some(z)) => Some(Rect { x: p.x, y: p.y, w: z.width, h: z.height }),
        _ => None,
    };
    let children = get("AXChildren").cloned().map(list).unwrap_or_default();
    let raw = get("AXValue").or(get("AXTitle")).and_then(text_of);
    Node { props, raw, frame, children }
}

fn complete(e: &El, mut n: Node) -> Node {
    n.props.settable = n.props.settable && settable(e, "AXValue");
    n.props.actions = actions(e).into_iter().filter(|a| !BORING.contains(&a.as_str())).collect();
    n
}

fn extras(ax: &El, main: &El) -> Vec<El> {
    let mut out: Vec<El> = attr(ax, "AXChildren")
        .map(list)
        .unwrap_or_default()
        .into_iter()
        .filter(|c| str_attr(c, "AXRole").as_deref() == Some("AXMenu"))
        .collect();
    let bar = attr(ax, "AXMenuBar").map(|b| attr(&b, "AXChildren").map(list).unwrap_or_default()).unwrap_or_default();
    for item in bar.iter().filter(|i| bool_attr(i, "AXSelected") == Some(true)) {
        out.extend(
            attr(item, "AXChildren")
                .map(list)
                .unwrap_or_default()
                .into_iter()
                .filter(|c| str_attr(c, "AXRole").as_deref() == Some("AXMenu")),
        );
    }
    for w in attr(ax, "AXWindows").map(list).unwrap_or_default() {
        let role = str_attr(&w, "AXRole").unwrap_or_default();
        let sub = str_attr(&w, "AXSubrole").unwrap_or_default();
        if &w != main && (POPUPS.contains(&role.as_str()) || TRANSIENT.contains(&sub.as_str())) && !out.contains(&w) {
            out.push(w);
        }
    }
    out
}

struct Walk {
    ids: tree::Ids<El>,
    elements: Vec<(u32, El)>,
    lines: Vec<(Key, String)>,
    notes: HashMap<u32, u32>,
    chars: usize,
    truncated: bool,
    visited: usize,
    window: Rect,
}

impl Walk {
    fn id(&mut self, e: &El, locator: Locator) -> u32 {
        let id = self.ids.assign(e, unsafe { CFHash(e.as_CFTypeRef()) }, locator, dead);
        self.elements.push((id, e.clone()));
        id
    }

    fn full(&self) -> bool {
        self.chars >= MAX_TREE_CHARS || self.visited >= MAX_VISITS || cancellation::cancelled()
    }

    fn push(&mut self, key: Key, indent: usize, s: String) {
        let line = format!("{}{s}", "  ".repeat(indent));
        self.chars += line.len() + 1;
        self.lines.push((key, line));
    }

    fn note(&mut self, anchor: u32, indent: usize, s: String) {
        let seq = self.notes.entry(anchor).or_default();
        let key = Key::Note(anchor, *seq);
        *seq += 1;
        self.push(key, indent, s);
    }

    #[allow(clippy::too_many_arguments)]
    fn visit(&mut self, e: &El, n: Node, depth: usize, indent: usize, anchor: u32, clip: Rect, at: Locator, force: bool) {
        if depth > MAX_DEPTH || indent > MAX_INDENT {
            self.truncated = true;
            return;
        }
        let hash = unsafe { CFHash(e.as_CFTypeRef()) };
        if self.ids.seen(e, hash) {
            return;
        }
        let (s, keep) = n.props.describe();
        let keep = keep || force;
        let clip = narrow(clip, &n.props.role, n.frame);
        let locator = at.child(&n.props);
        let drawn = n.props.role == "AXWebArea" || n.children.is_empty();
        let before = self.lines.len();
        let (indent, anchor) = if keep {
            let id = self.id(e, locator);
            self.push(Key::Element(id), indent, format!("[{id}] {s}"));
            (indent + 1, id)
        } else {
            (indent, anchor)
        };
        self.children(&n.children, depth + 1, indent, anchor, clip, locator);
        let inside = self.lines.len() - before - keep as usize;
        if drawn
            && !self.truncated
            && SPARSE.contains(&n.props.role.as_str())
            && n.frame.is_some_and(|f| tree::sparse(f, self.window, inside))
        {
            self.note(
                anchor,
                indent,
                "… nothing readable inside; the app may draw this area itself (for example a canvas). Use the screenshot and point targets"
                    .into(),
            );
        }
    }

    fn text_run(&mut self, run: &mut Vec<(El, Node)>, depth: usize, indent: usize, anchor: u32, clip: Rect, at: Locator) {
        match run.len() {
            0 => {}
            1 => {
                let (e, n) = run.pop().unwrap();
                self.visit(&e, n, depth, indent, anchor, clip, at, false);
            }
            _ => {
                let texts: Vec<(String, Option<Rect>)> = run.iter().filter_map(|(_, n)| Some((n.raw.clone()?, n.frame))).collect();
                let (first, n) = &run[0];
                let id = self.id(first, at.child(&n.props));
                self.push(Key::Element(id), indent, format!("[{id}] {}", tree::merged_text(&texts)));
            }
        }
        run.clear();
    }

    fn children(&mut self, kids: &[El], depth: usize, indent: usize, anchor: u32, clip: Rect, at: Locator) {
        let mut hidden = 0;
        let mut run: Vec<(El, Node)> = vec![];
        for (i, c) in kids.iter().enumerate() {
            if self.full() {
                self.truncated = true;
                self.text_run(&mut run, depth, indent, anchor, clip, at);
                self.note(anchor, indent, format!("… {} more not shown; the observation size limit was reached", kids.len() - i));
                break;
            }
            self.visited += 1;
            let n = fetch(c);
            if n.frame.is_some_and(|f| tree::visible(f, clip).is_none()) {
                hidden += 1;
                continue;
            }
            let n = complete(c, n);
            if n.props.plain_text() && n.children.is_empty() {
                run.push((c.clone(), n));
                continue;
            }
            self.text_run(&mut run, depth, indent, anchor, clip, at);
            self.visit(c, n, depth, indent, anchor, clip, at, false);
        }
        self.text_run(&mut run, depth, indent, anchor, clip, at);
        if hidden > 0 {
            self.note(anchor, indent, format!("… {hidden} more offscreen; scroll to reveal"));
        }
    }
}

fn relocate(roots: &[(El, Locator)], target: Locator) -> Option<El> {
    let mut queue: std::collections::VecDeque<(El, Locator)> = roots.iter().cloned().collect();
    let (mut found, mut seen) = (None, 0);
    while let Some((e, at)) = queue.pop_front() {
        seen += 1;
        if seen > MAX_VISITS || cancellation::cancelled() {
            return None;
        }
        let n = fetch(&e);
        let here = at.child(&n.props);
        if here == target {
            if found.is_some() {
                return None;
            }
            found = Some(e);
        }
        queue.extend(n.children.into_iter().map(|c| (c, here)));
    }
    found
}

fn empty_web(e: &El, depth: usize, seen: &mut usize) -> bool {
    *seen += 1;
    if *seen > MAX_BUSY_VISITS || depth > MAX_DEPTH {
        return false;
    }
    let kids = attr(e, "AXChildren").map(list).unwrap_or_default();
    if str_attr(e, "AXRole").as_deref() == Some("AXWebArea") {
        return kids.is_empty();
    }
    kids.iter().any(|c| empty_web(c, depth + 1, seen))
}

fn narrow(clip: Rect, role: &str, f: Option<Rect>) -> Rect {
    match f {
        Some(f) if CLIPS.contains(&role) => tree::intersect(f, clip).unwrap_or(clip),
        _ => clip,
    }
}

fn visible_rect(e: &El, f: Rect, window: Rect) -> Option<Rect> {
    let mut clip = window;
    let mut parent = attr(e, "AXParent");
    for _ in 0..MAX_DEPTH {
        let Some(p) = parent else { break };
        let role = str_attr(&p, "AXRole").unwrap_or_default();
        if role == "AXWindow" {
            break;
        }
        if CLIPS.contains(&role.as_str()) {
            clip = narrow(clip, &role, frame(&p));
        }
        parent = attr(&p, "AXParent");
    }
    tree::visible(f, clip)
}

fn busy(e: &El, depth: usize, seen: &mut usize) -> bool {
    *seen += 1;
    if *seen > MAX_BUSY_VISITS || depth > MAX_DEPTH {
        return false;
    }
    if str_attr(e, "AXRole").is_some_and(|r| BUSY.contains(&r.as_str())) {
        return true;
    }
    attr(e, "AXChildren").map(list).unwrap_or_default().iter().any(|c| busy(c, depth + 1, seen))
}

fn select(e: &El, text: &str, prefix: &str, suffix: &str, selection: Selection) -> Result<(), Failure> {
    let value = attr(e, "AXValue").and_then(|v| text_of(&v)).unwrap_or_default();
    let at = value
        .match_indices(text)
        .map(|(i, _)| i)
        .find(|&i| value[..i].ends_with(prefix) && value[i + text.len()..].starts_with(suffix))
        .ok_or_else(|| fail(ErrorCode::ActionFailed, format!("text {text:?} not found in the element's value")))?;
    let start = value[..at].encode_utf16().count() as isize;
    let len = text.encode_utf16().count() as isize;
    let range: [isize; 2] = match selection {
        Selection::Text => [start, len],
        Selection::CursorBefore => [start, 0],
        Selection::CursorAfter => [start + len, 0],
    };
    set_attr(e, "AXFocused", &CFBoolean::true_value().as_CFType());
    let v = unsafe { CFType::wrap_under_create_rule(AXValueCreate(4, range.as_ptr() as *const c_void)) };
    match set_attr(e, "AXSelectedTextRange", &v) {
        0 => Ok(()),
        n => Err(fail(ErrorCode::ActionFailed, format!("setting the selection failed (AXError {n})"))),
    }
}

fn settle(w: &El, since: Instant) {
    cancellation::wait(SETTLE.saturating_sub(since.elapsed()));
    for _ in 0..16 {
        if cancellation::cancelled() || !busy(w, 0, &mut 0) {
            return;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

fn permissions(prompt: bool) -> Reply {
    let accessibility = if prompt {
        let d = CFDictionary::from_CFType_pairs(&[(cfs("AXTrustedCheckOptionPrompt").as_CFType(), CFBoolean::true_value().as_CFType())]);
        unsafe { AXIsProcessTrustedWithOptions(d.as_CFTypeRef()) }
    } else {
        unsafe { AXIsProcessTrusted() }
    };
    let screen_recording = unsafe {
        if prompt {
            CGRequestScreenCaptureAccess()
        } else {
            CGPreflightScreenCaptureAccess()
        }
    };
    let binary = std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default();
    let help = "System Settings > Privacy & Security > Accessibility and > Screen Recording: add the app that launches desk \
(QM, or your terminal when run alone) with +, switch it on, then quit and reopen that app. \
`desk permissions --prompt` raises the system prompts."
        .to_string();
    Reply::Permissions { accessibility, screen_recording, binary, help }
}

impl Desk {
    pub fn handle(&mut self, cmd: Command, pace: &mut dyn FnMut(u32, Point) -> Result<(), Failure>) -> Reply {
        objc2::rc::autoreleasepool(|_| self.handle_inner(cmd, pace))
    }

    fn handle_inner(&mut self, cmd: Command, pace: &mut dyn FnMut(u32, Point) -> Result<(), Failure>) -> Reply {
        let r = match cmd {
            Command::Permissions { prompt } => Ok(permissions(prompt)),
            Command::Apps => apps(),
            Command::Observe { app, screenshot, diff } => {
                resolve(&app).and_then(|a| self.observe(&a, screenshot, diff)).map(Reply::Observation)
            }
            Command::Act { app, actions, observe, screenshot, pace: paced, diff } => {
                let pace = if paced { Some(pace) } else { None };
                self.act(&app, &actions, observe.then_some((screenshot, diff)), pace)
            }
            Command::Arrived => Err(fail(ErrorCode::BadRequest, "arrived outside a paced act")),
        };
        r.unwrap_or_else(Reply::Error)
    }

    fn enable(&mut self, pid: i32, ax: &El, w: &El) {
        if !self.enabled.insert(pid) {
            return;
        }
        let yes = CFBoolean::true_value().as_CFType();
        if set_attr(ax, "AXManualAccessibility", &yes) != 0 && set_attr(ax, "AXEnhancedUserInterface", &yes) == 0 {
            self.enhanced.insert(pid);
        }
        for _ in 0..10 {
            if cancellation::cancelled() || !empty_web(w, 0, &mut 0) {
                return;
            }
            cancellation::wait(Duration::from_millis(100));
        }
    }

    fn observe(&mut self, app: &App, shot: bool, diff: bool) -> Result<Observation, Failure> {
        if let Some(at) = self.touched.remove(&app.pid) {
            let (_, w) = window(app)?;
            settle(&w, at);
        }
        let (ax, w) = window(app)?;
        self.enable(app.pid, &ax, &w);
        let win = window_id(&w);
        let f = frame(&w).unwrap_or(Rect { x: 0.0, y: 0.0, w: 0.0, h: 0.0 });
        let mut prev = self.cache.remove(&app.pid).filter(|s| s.window == win);
        let mut walk = Walk {
            ids: prev.as_mut().map(|p| std::mem::take(&mut p.ids)).unwrap_or_default(),
            elements: vec![],
            lines: vec![],
            notes: HashMap::new(),
            chars: 0,
            truncated: false,
            visited: 0,
            window: f,
        };
        let everywhere = Rect { x: -1e9, y: -1e9, w: 2e9, h: 2e9 };
        let others = extras(&ax, &w);
        if !others.is_empty() {
            walk.push(Key::Section(0), 0, "Open menus and other windows of this app:".into());
            for o in &others {
                let n = complete(o, fetch(o));
                walk.visit(o, n, 0, 0, ROOT, everywhere, Locator::ROOT, true);
            }
            let title = str_attr(&w, "AXTitle").unwrap_or_default();
            walk.push(Key::Section(1), 0, format!("Window \"{}\":", tree::clip(&title, 80)));
        }
        let kids = attr(&w, "AXChildren").map(list).unwrap_or_default();
        walk.children(&kids, 0, 0, ROOT, if f.w > 0.0 && f.h > 0.0 { f } else { everywhere }, Locator::ROOT);
        if let Some(focus) = attr(&ax, "AXFocusedUIElement") {
            let what = match walk.elements.iter().find(|(_, e)| *e == focus) {
                Some((id, _)) => format!("[{id}]"),
                None => format!("{} (not in the tree above)", complete(&focus, fetch(&focus)).props.describe().0),
            };
            walk.push(Key::Info(0), 0, format!("Focus: {what}"));
            if let Some(sel) = str_attr(&focus, "AXSelectedText") {
                walk.push(Key::Info(1), 0, format!("Selected text: \"{}\"", tree::clip(&sel, tree::MAX_TEXT)));
            }
        }
        let screenshot = if shot { Some(capture(&w, f)?) } else { None };
        let rendered = tree::render(&walk.lines, prev.as_ref().filter(|_| diff).map(|p| &p.lines));
        let obs = Observation {
            app: app.name.clone(),
            bundle_id: app.bundle.clone(),
            pid: app.pid,
            window: str_attr(&w, "AXTitle").unwrap_or_default(),
            frame: f,
            elements: walk.elements.len() as u32,
            truncated: walk.truncated,
            diffed: rendered.diffed,
            tree: rendered.tree,
            removed: rendered.removed,
            screenshot,
        };
        self.cache.insert(
            app.pid,
            Snapshot {
                window: win,
                window_element: w.clone(),
                origin: (f.x, f.y),
                elements: walk.elements,
                lines: walk.lines.into_iter().collect(),
                ids: walk.ids.carry(),
            },
        );
        Ok(obs)
    }

    fn act(
        &mut self,
        query: &str,
        actions: &[Action],
        observe: Option<(bool, bool)>,
        mut pace: Option<&mut dyn FnMut(u32, Point) -> Result<(), Failure>>,
    ) -> Result<Reply, Failure> {
        let app = resolve(query)?;
        if !self.cache.contains_key(&app.pid) {
            return Err(fail(ErrorCode::BadIndex, "Observe this app before acting; its previous observation is no longer available"));
        }
        let (ax, w) = window(&app)?;
        let win = window_id(&w);
        let mut focus = if actions.iter().any(|a| !matches!(a, Action::Wait { .. } | Action::Raise)) {
            Some(crate::focus::Focus::begin(app.pid, win)?)
        } else {
            None
        };
        let mut completed = 0;
        let mut failure = None;
        for (i, a) in actions.iter().enumerate() {
            if matches!(a, Action::Raise) {
                drop(focus.take());
            }
            let paced =
                focus.as_ref().map_or(Ok(()), |f| f.check()).and_then(|_| self.validate_window(&app)).and_then(|_| match pace.as_mut() {
                    Some(p) => match self.aim(app.pid, &w, a) {
                        Ok(Some(at)) => p(i as u32, Point { x: at.x, y: at.y }),
                        Ok(None) => Ok(()),
                        Err(e) => Err(e),
                    },
                    None => Ok(()),
                });
            if let Err(mut e) = paced
                .and_then(|_| self.validate_window(&app))
                .and_then(|_| self.step(&app, &ax, &w, win, a))
                .and_then(|_| focus.as_ref().map_or(Ok(()), |f| f.check()))
            {
                e.action = Some(i as u32);
                failure = Some(e);
                break;
            }
            completed += 1;
        }
        drop(focus.take());
        let attempted = (completed as usize + 1).min(actions.len());
        if actions[..attempted].iter().any(|a| !matches!(a, Action::Wait { .. })) {
            self.touched.insert(app.pid, Instant::now());
        }
        let (observation, observation_failure) = match observe {
            Some((shot, diff)) => match self.observe(&app, shot, diff) {
                Ok(observation) => (Some(observation), None),
                Err(error) => (None, Some(error)),
            },
            None => (None, None),
        };
        Ok(Reply::Acted { completed, failure, observation, observation_failure })
    }

    fn validate_window(&self, app: &App) -> Result<(), Failure> {
        active()?;
        let (_, current) = window(app)?;
        let snapshot = self.cache.get(&app.pid).ok_or_else(|| fail(ErrorCode::BadIndex, "Observe before acting"))?;
        let origin = frame(&current).map(|f| (f.x, f.y));
        if current != snapshot.window_element || origin != Some(snapshot.origin) {
            return Err(fail(ErrorCode::BadIndex, "The window changed or moved; observe again before acting"));
        }
        Ok(())
    }

    fn element(&self, pid: i32, index: u32) -> Result<El, Failure> {
        let s = self.cache.get(&pid).ok_or_else(|| fail(ErrorCode::BadIndex, "observe first"))?;
        let e = s
            .elements
            .iter()
            .find(|(id, _)| *id == index)
            .map(|(_, e)| e.clone())
            .ok_or_else(|| fail(ErrorCode::BadIndex, format!("no element {index}; observe again")))?;
        if !dead(&e) {
            return Ok(e);
        }
        let gone = || fail(ErrorCode::BadIndex, format!("element {index} is gone and no single replacement was found; observe again"));
        let target = s.ids.locator(index).ok_or_else(gone)?;
        let mut roots: Vec<(El, Locator)> =
            attr(&s.window_element, "AXChildren").map(list).unwrap_or_default().into_iter().map(|c| (c, Locator::ROOT)).collect();
        roots.extend(extras(&app_element(pid), &s.window_element).into_iter().map(|o| (o, Locator::ROOT)));
        relocate(&roots, target).ok_or_else(gone)
    }

    fn point(&self, pid: i32, t: Target) -> Result<CGPoint, Failure> {
        match t {
            Target::Point(p) => {
                let o = self.cache.get(&pid).map(|s| s.origin).unwrap_or((0.0, 0.0));
                Ok(pt(o.0 + p.x, o.1 + p.y))
            }
            Target::Index(i) => {
                let e = self.element(pid, i)?;
                let window = self.cache.get(&pid).and_then(|s| frame(&s.window_element));
                let visible = || {
                    let f = frame(&e).ok_or_else(|| fail(ErrorCode::BadIndex, format!("element {i} has no frame")))?;
                    Ok::<_, Failure>(window.map_or(Some(f), |w| visible_rect(&e, f, w)))
                };
                let r = match visible()? {
                    Some(r) => r,
                    None => {
                        let scrolled = perform(&e, "AXScrollToVisible");
                        cancellation::wait(Duration::from_millis(250));
                        visible()?.ok_or_else(|| {
                            let why = scrolled.err().map(|e| format!(" ({})", e.message)).unwrap_or_default();
                            fail(
                                ErrorCode::ActionFailed,
                                format!(
                                    "element {i} is offscreen and could not be scrolled into view{why}; scroll toward it and observe again"
                                ),
                            )
                        })?
                    }
                };
                Ok(pt(r.x + r.w / 2.0, r.y + r.h / 2.0))
            }
        }
    }

    fn aim(&self, pid: i32, w: &El, a: &Action) -> Result<Option<CGPoint>, Failure> {
        match a {
            Action::Click { target: Target::Index(i), button: Button::Left, count: 1, modifiers, hold_ms: 0 }
                if modifiers.is_empty() && actions(&self.element(pid, *i)?).iter().any(|a| a == "AXPress") =>
            {
                Ok(None)
            }
            Action::Click { target, .. } | Action::Scroll { target: Some(target), .. } => self.point(pid, *target).map(Some),
            Action::Scroll { target: None, .. } => Ok(Some(center(w))),
            Action::Drag { from, .. } => self.point(pid, Target::Point(*from)).map(Some),
            _ => Ok(None),
        }
    }

    fn step(&self, app: &App, ax: &El, w: &El, win: u32, a: &Action) -> Result<(), Failure> {
        let pid = app.pid;
        match a {
            Action::Click { target: Target::Index(i), button: Button::Left, count: 1, modifiers, hold_ms: 0 } if modifiers.is_empty() => {
                let e = self.element(pid, *i)?;
                if actions(&e).iter().any(|a| a == "AXPress") {
                    perform(&e, "AXPress")
                } else {
                    let p = self.point(pid, Target::Index(*i))?;
                    click_at(pid, prepare(pid, ax, win, p)?, p, Button::Left, 1, &[], 0)
                }
            }
            Action::Click { target, button, count, modifiers, hold_ms } => {
                let p = self.point(pid, *target)?;
                click_at(pid, prepare(pid, ax, win, p)?, p, *button, *count, modifiers, *hold_ms)
            }
            Action::TypeText { text } => type_text(pid, text),
            Action::Paste { text, format } => paste(pid, text, *format),
            Action::SelectText { index, text, prefix, suffix, selection } => {
                select(&self.element(pid, *index)?, text, prefix, suffix, *selection)
            }
            Action::PressKey { key: k, hold_ms } => {
                let mut chord = crate::keys::parse(k).ok_or_else(|| fail(ErrorCode::UnknownKey, format!("unknown key {k}")))?;
                if let Some(c) = chord.character {
                    if let Some(stroke) = keyboard_for_flags(CGEventFlags::from_bits_truncate(chord.flags)).get(&c) {
                        chord.code = stroke.code;
                        if stroke.shift {
                            chord.flags |= crate::keys::SHIFT;
                        }
                        if stroke.option {
                            chord.flags |= crate::keys::OPTION;
                        }
                    }
                }
                send_key_events(pid, crate::keys::events_with_modifiers(chord.code, chord.flags, &chord.modifiers), None, *hold_ms)
            }
            Action::Scroll { target, direction, amount } => {
                let p = match target {
                    Some(t) => self.point(pid, *t)?,
                    None => center(w),
                };
                let view = match target {
                    Some(Target::Index(i)) => frame(&self.element(pid, *i)?),
                    _ => frame(w),
                }
                .unwrap_or(Rect { x: 0.0, y: 0.0, w: 600.0, h: 600.0 });
                let scroll_win = prepare(pid, ax, win, p)?.win;
                let vertical = matches!(direction, Direction::Up | Direction::Down);
                let mut left = match amount {
                    Amount::Pixels(n) => *n as i32,
                    Amount::Pages(n) => (n.clamp(0.0, 20.0) * 0.85 * if vertical { view.h } else { view.w }) as i32,
                };
                while left > 0 {
                    active()?;
                    let n = left.min(120);
                    left -= n;
                    let (dy, dx) = match direction {
                        Direction::Up => (n, 0),
                        Direction::Down => (-n, 0),
                        Direction::Left => (0, n),
                        Direction::Right => (0, -n),
                    };
                    let e = CGEvent::new_scroll_event(source()?, ScrollEventUnit::PIXEL, 2, dy, dx, 0)
                        .map_err(|_| fail(ErrorCode::ActionFailed, "scroll event"))?;
                    unsafe { CGEventSetLocation(e.as_ptr() as *mut c_void, p) };
                    in_window(&e, scroll_win);
                    post(e, pid);
                }
                Ok(())
            }
            Action::Drag { from, to } => {
                let (a, b) = (self.point(pid, Target::Point(*from))?, self.point(pid, Target::Point(*to))?);
                let none = CGEventFlags::empty();
                let press = prepare(pid, ax, win, a)?;
                mouse(pid, &press, CGEventType::LeftMouseDown, a, CGMouseButton::Left, 1, none)?;
                let mut last = a;
                let dragged = (|| {
                    cancellation::wait(Duration::from_millis(PRESS_MS));
                    for s in 1..=12 {
                        active()?;
                        let t = s as f64 / 12.0;
                        let point = pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
                        mouse(pid, &press, CGEventType::LeftMouseDragged, point, CGMouseButton::Left, 1, none)?;
                        last = point;
                        cancellation::wait(Duration::from_millis(12));
                    }
                    Ok(())
                })();
                let released = mouse(pid, &press, CGEventType::LeftMouseUp, last, CGMouseButton::Left, 1, none);
                dragged.and(released)
            }
            Action::SetValue { index, value } => match set_attr(&self.element(pid, *index)?, "AXValue", &cfs(value).as_CFType()) {
                0 => Ok(()),
                n => Err(fail(ErrorCode::ActionFailed, format!("setting AXValue failed (AXError {n})"))),
            },
            Action::Perform { index, action } => {
                let name = if action.starts_with("AX") { action.clone() } else { format!("AX{action}") };
                perform(&self.element(pid, *index)?, &name)
            }
            Action::Raise => {
                let status = set_attr(ax, "AXFrontmost", &CFBoolean::true_value().as_CFType());
                if status != 0 {
                    return Err(fail(ErrorCode::ActionFailed, format!("setting AXFrontmost failed (AXError {status})")));
                }
                perform(w, "AXRaise")
            }
            Action::Wait { ms } => {
                cancellation::wait(Duration::from_millis((*ms).min(10_000) as u64));
                Ok(())
            }
        }
    }
}

fn apps() -> Result<Reply, Failure> {
    let apps = running().into_iter().map(|a| AppInfo { name: a.name, bundle_id: a.bundle, pid: a.pid, active: a.active }).collect();
    Ok(Reply::Apps { apps })
}

fn resolve(query: &str) -> Result<App, Failure> {
    if !unsafe { AXIsProcessTrusted() } {
        return Err(fail(ErrorCode::PermissionMissing, "Accessibility not granted; run `desk permissions --prompt`"));
    }
    let find = || {
        running()
            .into_iter()
            .find(|a| a.name.eq_ignore_ascii_case(query) || a.bundle.as_deref().is_some_and(|b| b.eq_ignore_ascii_case(query)))
    };
    let app = match find() {
        Some(app) => app,
        None => {
            let flag = if query.contains('.') && !query.contains(' ') { "-b" } else { "-a" };
            let opened = std::process::Command::new("/usr/bin/open").args(["-g", flag, query]).status().is_ok_and(|s| s.success());
            (0..25)
                .take_while(|_| opened)
                .find_map(|_| {
                    std::thread::sleep(Duration::from_millis(200));
                    find()
                })
                .ok_or_else(|| fail(ErrorCode::AppNotFound, format!("could not open {query}")))?
        }
    };
    Ok(app)
}

fn window(app: &App) -> Result<(El, El), Failure> {
    let ax = unsafe { CFType::wrap_under_create_rule(AXUIElementCreateApplication(app.pid)) };
    unsafe { AXUIElementSetMessagingTimeout(ax.as_CFTypeRef(), 1.5) };
    set_attr(&ax, "AXManualAccessibility", &CFBoolean::true_value().as_CFType());
    let w = window_of(&ax).ok_or_else(|| fail(ErrorCode::NoWindow, format!("{} has no open window", app.name)))?;
    if bool_attr(&ax, "AXHidden") == Some(true) || bool_attr(&w, "AXMinimized") == Some(true) {
        return Err(fail(ErrorCode::NoWindow, "App is hidden or window is minimized; show it and observe again"));
    }
    Ok((ax, w))
}

fn capture(w: &El, f: Rect) -> Result<Screenshot, Failure> {
    if !unsafe { CGPreflightScreenCaptureAccess() } {
        return Err(fail(ErrorCode::PermissionMissing, "Screen Recording not granted; run `desk permissions --prompt`"));
    }
    crate::capture::window(window_id(w), f).map_err(|m| fail(ErrorCode::ActionFailed, m))
}
