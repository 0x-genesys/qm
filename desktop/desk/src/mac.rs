use crate::cancellation;
use crate::keys;
use crate::protocol::*;
use crate::text::{self, Key as TextKey, Stroke};
use crate::tree::{self, Key, ROOT};
use base64::Engine;
use core_foundation::array::CFArray;
use core_foundation::base::{CFType, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::data::CFData;
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::event::{CGEvent, CGEventFlags, CGEventType, CGMouseButton, EventField, ScrollEventUnit};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use core_graphics::geometry::{CGPoint, CGRect, CGSize};
use core_graphics::window::{
    create_image, kCGWindowImageBoundsIgnoreFraming, kCGWindowImageNominalResolution, kCGWindowListOptionIncludingWindow,
};
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
}

const MAX_TREE_CHARS: usize = 60_000;
const MAX_VISITS: usize = 6_000;
const MAX_BUSY_VISITS: usize = 800;
const MAX_DEPTH: usize = 200;
const MAX_INDENT: usize = 50;
const CLIPS: &[&str] = &["AXScrollArea", "AXWebArea"];
const BORING: &[&str] = &["AXShowMenu", "AXScrollToVisible", "AXShowDefaultUI", "AXShowAlternateUI"];
const BUSY: &[&str] = &["AXBusyIndicator", "AXProgressIndicator"];
const PRESS_MS: u64 = 50;
const RETURN: u16 = 36;
const TAB: u16 = 48;
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
    next: u32,
}

#[derive(Default)]
pub struct Desk {
    cache: HashMap<i32, Snapshot>,
    touched: HashMap<i32, Instant>,
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

fn text_of(v: &CFType) -> Option<String> {
    if let Some(s) = v.downcast::<CFString>() {
        return Some(s.to_string());
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

fn clip(s: &str, n: usize) -> String {
    let s = s.replace('\n', "⏎");
    if s.chars().count() > n {
        format!("{}…", s.chars().take(n).collect::<String>())
    } else {
        s
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

fn prepare(pid: i32, ax: &El, win: u32, p: CGPoint, activate: bool) -> Result<Press, Failure> {
    active()?;
    let (win, web) = match hit(ax, p) {
        Some((w, web)) if window_id(&w) != 0 => (window_id(&w), web),
        _ => (win, false),
    };
    if activate && web && bool_attr(ax, "AXFrontmost") == Some(false) {
        let status = set_attr(ax, "AXFrontmost", &CFBoolean::true_value().as_CFType());
        if status != 0 {
            return Err(fail(ErrorCode::ActionFailed, format!("bringing the app forward for a web click failed (AXError {status})")));
        }
        for _ in 0..20 {
            if bool_attr(ax, "AXFrontmost") == Some(true) {
                break;
            }
            cancellation::wait(Duration::from_millis(25));
        }
    }
    mouse(pid, &Press { win, number: 0 }, CGEventType::MouseMoved, p, CGMouseButton::Left, 0, CGEventFlags::empty())?;
    cancellation::wait(Duration::from_millis(HOVER_MS));
    Ok(Press { win, number: EVENT_NUMBER.fetch_add(1, Ordering::Relaxed) })
}

fn click_at(pid: i32, mut press: Press, p: CGPoint, button: Button, count: u8, mods: &[Modifier], hold: u32) -> Result<(), Failure> {
    let hold = if hold == 0 { PRESS_MS } else { hold.min(10_000) as u64 };
    let (down, up, b) = match button {
        Button::Left => (CGEventType::LeftMouseDown, CGEventType::LeftMouseUp, CGMouseButton::Left),
        Button::Right => (CGEventType::RightMouseDown, CGEventType::RightMouseUp, CGMouseButton::Right),
        Button::Middle => (CGEventType::OtherMouseDown, CGEventType::OtherMouseUp, CGMouseButton::Center),
    };
    holding(pid, mods, || {
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
    })
}

fn key(pid: i32, code: u16, flags: CGEventFlags, text: Option<&str>, hold: u32) -> Result<(), Failure> {
    active()?;
    for down in [true, false] {
        if !down {
            cancellation::wait(Duration::from_millis(hold.min(10_000) as u64));
        }
        let e = CGEvent::new_keyboard_event(source()?, code, down).map_err(|_| fail(ErrorCode::ActionFailed, "key event"))?;
        e.set_flags(flags);
        if let Some(t) = text {
            e.set_string(t);
        }
        post(e, pid);
    }
    Ok(())
}

/// Presses or releases one modifier key as a flags-changed event; `held` is every modifier down
/// after this event.
fn modifier_key(pid: i32, m: Modifier, code: Option<u16>, held: &[Modifier]) -> Result<(), Failure> {
    let down = held.contains(&m);
    let e = CGEvent::new_keyboard_event(source()?, code.unwrap_or(keys::modifier_code(m)), down)
        .map_err(|_| fail(ErrorCode::ActionFailed, "key event"))?;
    e.set_type(CGEventType::FlagsChanged);
    e.set_flags(flags(held));
    post(e, pid);
    Ok(())
}

/// Holds `mods` as real modifier key presses around `inner`, releasing them even if it fails.
fn holding(pid: i32, mods: &[Modifier], inner: impl FnOnce() -> Result<(), Failure>) -> Result<(), Failure> {
    let mut held = vec![];
    let mut result = Ok(());
    for m in mods {
        held.push(*m);
        if let Err(e) = modifier_key(pid, *m, None, &held) {
            held.pop();
            result = Err(e);
            break;
        }
    }
    if result.is_ok() {
        result = inner();
    }
    while let Some(m) = held.pop() {
        let released = modifier_key(pid, m, None, &held);
        result = result.and(released);
    }
    result
}

fn press_chord(pid: i32, c: &keys::Chord, hold: u32) -> Result<(), Failure> {
    holding(pid, &c.mods, || match c.lone {
        Some(m) => {
            let mut held = c.mods.clone();
            held.push(m);
            modifier_key(pid, m, Some(c.code), &held)?;
            cancellation::wait(Duration::from_millis(hold.min(10_000) as u64));
            modifier_key(pid, m, Some(c.code), &c.mods)
        }
        None => key(pid, c.code, flags(&c.mods), None, hold),
    })
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
    let Some(data) = layout_data(unsafe { TISCopyCurrentKeyboardLayoutInputSource() })
        .or_else(|| layout_data(unsafe { TISCopyCurrentASCIICapableKeyboardLayoutInputSource() }))
    else {
        return HashMap::new();
    };
    let kind = unsafe { LMGetKbdType() } as u32;
    text::layout(|code, shift, option| {
        let modifiers = if shift { 2 } else { 0 } | if option { 8 } else { 0 };
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
            TextKey::Return => key(pid, RETURN, CGEventFlags::empty(), None, 0)?,
            TextKey::Tab => key(pid, TAB, CGEventFlags::empty(), None, 0)?,
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
    let v = keys::resolve("v", &keyboard()).map_err(|m| fail(ErrorCode::UnknownKey, m))?.code;
    let cmd_v = || key(pid, v, CGEventFlags::CGEventFlagCommand, Some("v"), 0);
    crate::pasteboard::paste(s, format, cmd_v, &cancellation::cancelled)
}

fn active() -> Result<(), Failure> {
    if cancellation::cancelled() {
        Err(fail(ErrorCode::ActionFailed, "Computer action cancelled"))
    } else {
        Ok(())
    }
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
    attr(app, "AXFocusedWindow")
        .or_else(|| attr(app, "AXMainWindow"))
        .or_else(|| attr(app, "AXWindows").and_then(|w| list(w).into_iter().next()))
}

fn window_id(w: &El) -> u32 {
    let mut id = 0;
    unsafe { _AXUIElementGetWindow(w.as_CFTypeRef(), &mut id) };
    id
}

fn line(e: &El) -> (String, bool, String) {
    let role = str_attr(e, "AXRole").unwrap_or_else(|| "AXUnknown".into());
    let title = str_attr(e, "AXTitle");
    let desc = str_attr(e, "AXDescription").or_else(|| str_attr(e, "AXHelp"));
    let value = str_attr(e, "AXValue");
    let can_set = settable(e, "AXValue");
    let acts: Vec<String> = actions(e).into_iter().filter(|a| !BORING.contains(&a.as_str())).collect();
    let keep = title.is_some() || desc.is_some() || value.is_some() || can_set || !acts.is_empty();
    let mut s = role.trim_start_matches("AX").to_string();
    if let Some(t) = &title {
        s += &format!(" \"{}\"", clip(t, 80));
    }
    if let Some(d) = desc.filter(|d| Some(d) != title.as_ref()) {
        s += &format!(" ({})", clip(&d, 80));
    }
    if let Some(v) = value.filter(|v| Some(v) != title.as_ref()) {
        s += &format!(" = \"{}\"", clip(&v, 120));
    }
    let mut tags = vec![];
    for (attr_name, want, tag) in [("AXFocused", true, "focused"), ("AXEnabled", false, "disabled"), ("AXSelected", true, "selected")] {
        if bool_attr(e, attr_name) == Some(want) {
            tags.push(tag);
        }
    }
    if can_set {
        tags.push("settable");
    }
    if !tags.is_empty() {
        s += &format!(" [{}]", tags.join(" "));
    }
    if !acts.is_empty() {
        let a: Vec<&str> = acts.iter().map(|a| a.trim_start_matches("AX")).collect();
        s += &format!(" <{}>", a.join(","));
    }
    (s, keep, role)
}

struct Walk {
    known: HashMap<usize, Vec<(u32, El)>>,
    taken: HashSet<u32>,
    next: u32,
    elements: Vec<(u32, El)>,
    lines: Vec<(Key, String)>,
    notes: HashMap<u32, u32>,
    chars: usize,
    truncated: bool,
    visited: usize,
}

impl Walk {
    fn id(&mut self, e: &El) -> u32 {
        let found = self
            .known
            .get(&unsafe { CFHash(e.as_CFTypeRef()) })
            .and_then(|c| c.iter().find(|(id, k)| !self.taken.contains(id) && k == e))
            .map(|(id, _)| *id);
        let id = found.unwrap_or_else(|| {
            self.next += 1;
            self.next - 1
        });
        self.taken.insert(id);
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

    fn visit(&mut self, e: &El, f: Option<Rect>, depth: usize, indent: usize, anchor: u32, clip: Rect) {
        if depth > MAX_DEPTH || indent > MAX_INDENT {
            self.truncated = true;
            return;
        }
        let (s, keep, role) = line(e);
        let clip = narrow(clip, &role, f);
        let (indent, anchor) = if keep {
            let id = self.id(e);
            self.push(Key::Element(id), indent, format!("[{id}] {s}"));
            self.elements.push((id, e.clone()));
            (indent + 1, id)
        } else {
            (indent, anchor)
        };
        self.children(e, depth + 1, indent, anchor, clip);
    }

    fn children(&mut self, parent: &El, depth: usize, indent: usize, anchor: u32, clip: Rect) {
        let kids = attr(parent, "AXChildren").map(list).unwrap_or_default();
        let mut hidden = 0;
        for c in &kids {
            if self.full() {
                self.truncated = true;
                break;
            }
            self.visited += 1;
            let f = frame(c);
            if f.is_none_or(|f| tree::visible(f, clip).is_some()) {
                self.visit(c, f, depth, indent, anchor, clip);
            } else {
                hidden += 1;
            }
        }
        if hidden > 0 {
            let seq = self.notes.entry(anchor).or_default();
            let key = Key::Note(anchor, *seq);
            *seq += 1;
            self.push(key, indent, format!("… {hidden} more offscreen; scroll to reveal"));
        }
    }
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

fn png(img: &core_graphics::image::CGImage) -> Option<(String, u32, u32)> {
    let (w, h, row) = (img.width(), img.height(), img.bytes_per_row());
    if img.bits_per_pixel() != 32 {
        return None;
    }
    let data = img.data();
    let bytes = data.bytes();
    let mut rgba = Vec::with_capacity(w * h * 4);
    for y in 0..h {
        for x in 0..w {
            let i = y * row + x * 4;
            rgba.extend_from_slice(&[bytes[i + 2], bytes[i + 1], bytes[i], bytes[i + 3]]);
        }
    }
    let mut buf = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut buf, w as u32, h as u32);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.write_header().ok()?.write_image_data(&rgba).ok()?;
    }
    Some((base64::engine::general_purpose::STANDARD.encode(buf), w as u32, h as u32))
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

    fn observe(&mut self, app: &App, shot: bool, diff: bool) -> Result<Observation, Failure> {
        if let Some(at) = self.touched.remove(&app.pid) {
            let (_, w) = window(app)?;
            settle(&w, at);
        }
        let (_, w) = window(app)?;
        let win = window_id(&w);
        let f = frame(&w).unwrap_or(Rect { x: 0.0, y: 0.0, w: 0.0, h: 0.0 });
        let prev = self.cache.remove(&app.pid).filter(|s| s.window == win);
        let mut walk = Walk {
            known: HashMap::new(),
            taken: HashSet::new(),
            next: prev.as_ref().map_or(0, |p| p.next),
            elements: vec![],
            lines: vec![],
            notes: HashMap::new(),
            chars: 0,
            truncated: false,
            visited: 0,
        };
        for (id, e) in prev.iter().flat_map(|p| p.elements.iter()) {
            walk.known.entry(unsafe { CFHash(e.as_CFTypeRef()) }).or_default().push((*id, e.clone()));
        }
        let everywhere = Rect { x: -1e9, y: -1e9, w: 2e9, h: 2e9 };
        walk.children(&w, 0, 0, ROOT, if f.w > 0.0 && f.h > 0.0 { f } else { everywhere });
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
                next: walk.next,
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
        let mut completed = 0;
        let mut failure = None;
        for (i, a) in actions.iter().enumerate() {
            let paced = self.validate_window(&app).and_then(|_| match pace.as_mut() {
                Some(p) => match self.aim(app.pid, &w, a) {
                    Ok(Some(at)) => p(i as u32, Point { x: at.x, y: at.y }),
                    Ok(None) => Ok(()),
                    Err(e) => Err(e),
                },
                None => Ok(()),
            });
            if let Err(mut e) = paced.and_then(|_| self.validate_window(&app)).and_then(|_| self.step(&app, &ax, &w, win, a)) {
                e.action = Some(i as u32);
                failure = Some(e);
                break;
            }
            completed += 1;
        }
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
        s.elements
            .iter()
            .find(|(id, _)| *id == index)
            .map(|(_, e)| e.clone())
            .ok_or_else(|| fail(ErrorCode::BadIndex, format!("no element {index}; observe again")))
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
                    click_at(pid, prepare(pid, ax, win, p, true)?, p, Button::Left, 1, &[], 0)
                }
            }
            Action::Click { target, button, count, modifiers, hold_ms } => {
                let p = self.point(pid, *target)?;
                click_at(pid, prepare(pid, ax, win, p, true)?, p, *button, *count, modifiers, *hold_ms)
            }
            Action::TypeText { text } => type_text(pid, text),
            Action::Paste { text, format } => paste(pid, text, *format),
            Action::SelectText { index, text, prefix, suffix, selection } => {
                select(&self.element(pid, *index)?, text, prefix, suffix, *selection)
            }
            Action::PressKey { key: k, hold_ms } => {
                let c = keys::resolve(k, &keyboard()).map_err(|m| fail(ErrorCode::UnknownKey, m))?;
                press_chord(pid, &c, *hold_ms)
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
                let scroll_win = prepare(pid, ax, win, p, false)?.win;
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
                let press = prepare(pid, ax, win, a, true)?;
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
    Ok((ax, w))
}

fn capture(w: &El, f: Rect) -> Result<Screenshot, Failure> {
    if !unsafe { CGPreflightScreenCaptureAccess() } {
        return Err(fail(ErrorCode::PermissionMissing, "Screen Recording not granted; run `desk permissions --prompt`"));
    }
    let rect = CGRect::new(&pt(f.x, f.y), &CGSize::new(f.w, f.h));
    let img = create_image(
        rect,
        kCGWindowListOptionIncludingWindow,
        window_id(w),
        kCGWindowImageBoundsIgnoreFraming | kCGWindowImageNominalResolution,
    )
    .ok_or_else(|| fail(ErrorCode::ActionFailed, "window capture returned nothing"))?;
    let (png_base64, width, height) = png(&img).ok_or_else(|| fail(ErrorCode::ActionFailed, "unexpected pixel format"))?;
    Ok(Screenshot { png_base64, width, height, pixels_per_point: if f.w > 0.0 { width as f64 / f.w } else { 1.0 } })
}
