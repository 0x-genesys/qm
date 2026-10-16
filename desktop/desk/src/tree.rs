use crate::protocol::Rect;
use std::collections::{HashMap, HashSet};

const EDGE: f64 = 1.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Key {
    Element(u32),
    Note(u32, u32),
    Section(u32),
    Info(u32),
}

pub const ROOT: u32 = u32::MAX;

pub fn intersect(a: Rect, b: Rect) -> Option<Rect> {
    let (x, y) = (a.x.max(b.x), a.y.max(b.y));
    let (right, bottom) = ((a.x + a.w).min(b.x + b.w), (a.y + a.h).min(b.y + b.h));
    (right > x && bottom > y).then_some(Rect { x, y, w: right - x, h: bottom - y })
}

pub fn visible(f: Rect, clip: Rect) -> Option<Rect> {
    if f.w > 0.0 && f.h > 0.0 {
        return intersect(f, clip);
    }
    let inside = f.x >= clip.x && f.x <= clip.x + clip.w && f.y > clip.y + EDGE && f.y < clip.y + clip.h - EDGE;
    inside.then_some(f)
}

pub struct Rendered {
    pub tree: String,
    pub diffed: bool,
    pub removed: Vec<u32>,
}

pub fn render(lines: &[(Key, String)], base: Option<&HashMap<Key, String>>) -> Rendered {
    let full = || Rendered { tree: lines.iter().map(|(_, l)| format!("{l}\n")).collect(), diffed: false, removed: vec![] };
    let Some(base) = base else { return full() };
    let mut tree = String::new();
    let mut changed = 0;
    for (key, line) in lines {
        let mark = match base.get(key) {
            Some(old) if old == line => continue,
            Some(_) => "~",
            None => "+",
        };
        changed += 1;
        tree += &format!("{mark} {line}\n");
    }
    if changed * 5 > lines.len() * 3 {
        return full();
    }
    let present: HashSet<&Key> = lines.iter().map(|(k, _)| k).collect();
    let mut removed: Vec<u32> = base
        .keys()
        .filter(|k| !present.contains(k))
        .filter_map(|k| match k {
            Key::Element(id) => Some(*id),
            _ => None,
        })
        .collect();
    removed.sort_unstable();
    Rendered { tree, diffed: true, removed }
}

const TEXT_ROLES: &[&str] = &["AXStaticText", "AXTextArea", "AXTextField", "AXHeading"];
const TOGGLES: &[&str] = &["AXCheckBox", "AXRadioButton", "AXSwitch", "AXToggle", "AXMenuItem"];
const QUIET_SUBROLES: &[&str] = &["AXUnknown", "AXStandardWindow", "AXTextAttachment"];
pub const MAX_TEXT: usize = 1000;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Props {
    pub role: String,
    pub subrole: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub label: Option<String>,
    pub value: Option<String>,
    pub placeholder: Option<String>,
    pub url: Option<String>,
    pub identifier: Option<String>,
    pub expanded: Option<bool>,
    pub focused: bool,
    pub disabled: bool,
    pub selected: bool,
    pub settable: bool,
    pub actions: Vec<String>,
}

pub fn clip(s: &str, n: usize) -> String {
    let s = s.replace('\n', "⏎");
    if s.chars().count() > n {
        format!("{}…", s.chars().take(n).collect::<String>())
    } else {
        s
    }
}

fn short(role: &str) -> &str {
    role.strip_prefix("AX").unwrap_or(role)
}

impl Props {
    pub fn name(&self) -> Option<&str> {
        self.title.as_deref().or(self.label.as_deref())
    }

    fn toggle(&self) -> Option<&'static str> {
        if !TOGGLES.contains(&self.role.as_str()) && self.subrole.as_deref() != Some("AXSwitch") {
            return None;
        }
        match self.value.as_deref() {
            Some("1") => Some("checked"),
            Some("2") => Some("mixed"),
            Some("0") if self.role != "AXMenuItem" => Some("unchecked"),
            _ => None,
        }
    }

    pub fn plain_text(&self) -> bool {
        self.role == "AXStaticText" && self.actions.is_empty() && !self.focused && !self.selected && self.text().is_some()
    }

    pub fn text(&self) -> Option<&str> {
        self.value.as_deref().or(self.title.as_deref()).or(self.description.as_deref())
    }

    pub fn describe(&self) -> (String, bool) {
        let toggle = self.toggle();
        let name = self.name();
        let value = self.value.as_deref().filter(|v| Some(*v) != name && toggle.is_none());
        let description = self.description.as_deref().filter(|d| Some(*d) != name);
        let placeholder = self.placeholder.as_deref().filter(|_| value.is_none());
        let keep = name.is_some()
            || description.is_some()
            || value.is_some()
            || placeholder.is_some()
            || self.url.is_some()
            || toggle.is_some()
            || self.expanded.is_some()
            || self.focused
            || self.selected
            || self.settable
            || !self.actions.is_empty();
        let mut s = short(&self.role).to_string();
        if let Some(sub) = self.subrole.as_deref().filter(|s| !QUIET_SUBROLES.contains(s)) {
            s += &format!(":{}", short(sub));
        }
        if let Some(n) = name {
            s += &format!(" \"{}\"", clip(n, 80));
        }
        if let Some(d) = description {
            s += &format!(" ({})", clip(d, 80));
        }
        if let Some(v) = value {
            let n = if TEXT_ROLES.contains(&self.role.as_str()) { MAX_TEXT } else { 120 };
            s += &format!(" = \"{}\"", clip(v, n));
        }
        if let Some(p) = placeholder {
            s += &format!(" placeholder \"{}\"", clip(p, 80));
        }
        if let Some(u) = &self.url {
            s += &format!(" url \"{}\"", clip(u, 160));
        }
        let mut tags = vec![];
        if self.focused {
            tags.push("focused");
        }
        if self.disabled {
            tags.push("disabled");
        }
        if self.selected {
            tags.push("selected");
        }
        tags.extend(toggle);
        match self.expanded {
            Some(true) => tags.push("expanded"),
            Some(false) => tags.push("collapsed"),
            None => {}
        }
        if self.settable {
            tags.push("settable");
        }
        if !tags.is_empty() {
            s += &format!(" [{}]", tags.join(" "));
        }
        if !self.actions.is_empty() {
            let a: Vec<&str> = self.actions.iter().map(|a| short(a)).collect();
            s += &format!(" <{}>", a.join(","));
        }
        (s, keep)
    }
}

pub fn merged_text(parts: &[(String, Option<Rect>)]) -> String {
    let mut out = String::new();
    let mut last: Option<Rect> = None;
    for (text, f) in parts {
        let wrapped = matches!((last, f), (Some(a), Some(b)) if b.y >= a.y + a.h - EDGE);
        if wrapped && !out.is_empty() && !out.ends_with(char::is_whitespace) && !text.starts_with(char::is_whitespace) {
            out.push('\n');
        }
        out += text;
        last = f.or(last);
    }
    format!("StaticText = \"{}\"", clip(out.trim(), MAX_TEXT))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Locator(pub u64);

impl Locator {
    pub const ROOT: Locator = Locator(0xcbf2_9ce4_8422_2325);

    pub fn child(self, p: &Props) -> Locator {
        let mut h = self.0;
        let mut eat = |s: &str| {
            for b in s.bytes().chain([0xff]) {
                h ^= b as u64;
                h = h.wrapping_mul(0x0100_0000_01b3);
            }
        };
        eat(&p.role);
        eat(p.subrole.as_deref().unwrap_or(""));
        eat(p.identifier.as_deref().unwrap_or(""));
        eat(p.name().unwrap_or(""));
        if p.name().is_none() && p.identifier.is_none() {
            eat(p.description.as_deref().unwrap_or(""));
        }
        Locator(h)
    }
}

const PARK_OBSERVATIONS: u32 = 30;
const MAX_PARKED: usize = 5000;

struct Entry<T> {
    id: u32,
    el: T,
    hash: usize,
    locator: Locator,
    idle: u32,
    now: bool,
}

pub struct Ids<T> {
    known: Vec<Entry<T>>,
    by_hash: HashMap<usize, Vec<usize>>,
    by_locator: HashMap<Locator, Vec<usize>>,
    taken: HashSet<u32>,
    pub next: u32,
}

impl<T: PartialEq + Clone> Ids<T> {
    pub fn new() -> Self {
        Ids { known: vec![], by_hash: HashMap::new(), by_locator: HashMap::new(), taken: HashSet::new(), next: 0 }
    }

    fn add(&mut self, e: Entry<T>) {
        let i = self.known.len();
        self.by_hash.entry(e.hash).or_default().push(i);
        self.by_locator.entry(e.locator).or_default().push(i);
        self.known.push(e);
    }

    pub fn assign(&mut self, el: &T, hash: usize, locator: Locator, dead: impl Fn(&T) -> bool) -> u32 {
        let same = self
            .by_hash
            .get(&hash)
            .and_then(|c| c.iter().copied().find(|&i| !self.taken.contains(&self.known[i].id) && self.known[i].el == *el));
        let reborn = || {
            let open: Vec<usize> =
                self.by_locator.get(&locator)?.iter().copied().filter(|&i| !self.taken.contains(&self.known[i].id)).collect();
            match open[..] {
                [i] if dead(&self.known[i].el) => Some(i),
                _ => None,
            }
        };
        let id = match same.or_else(reborn) {
            Some(i) => self.known[i].id,
            None => {
                self.next += 1;
                self.next - 1
            }
        };
        self.taken.insert(id);
        self.add(Entry { id, el: el.clone(), hash, locator, idle: 0, now: true });
        id
    }

    pub fn carry(self) -> Ids<T> {
        let mut next = Ids::new();
        next.next = self.next;
        let mut seen = HashSet::new();
        let (fresh, old): (Vec<_>, Vec<_>) = self.known.into_iter().partition(|e| e.now);
        for mut e in fresh {
            e.now = false;
            if seen.insert(e.id) {
                next.add(e);
            }
        }
        for mut e in old {
            if next.known.len() >= MAX_PARKED {
                break;
            }
            if self.taken.contains(&e.id) || !seen.insert(e.id) || e.idle >= PARK_OBSERVATIONS {
                continue;
            }
            e.idle += 1;
            next.add(e);
        }
        next
    }

    pub fn seen(&self, el: &T, hash: usize) -> bool {
        self.by_hash.get(&hash).is_some_and(|c| c.iter().any(|&i| self.known[i].now && self.known[i].el == *el))
    }

    pub fn locator(&self, id: u32) -> Option<Locator> {
        self.known.iter().find(|e| e.id == id).map(|e| e.locator)
    }
}

impl<T: PartialEq + Clone> Default for Ids<T> {
    fn default() -> Self {
        Self::new()
    }
}

pub fn sparse(region: Rect, window: Rect, lines_inside: usize) -> bool {
    let area = |r: Rect| r.w.max(0.0) * r.h.max(0.0);
    lines_inside == 0 && area(window) > 0.0 && area(region) >= 0.4 * area(window)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(x: f64, y: f64, w: f64, h: f64) -> Rect {
        Rect { x, y, w, h }
    }

    const VIEW: Rect = Rect { x: 0.0, y: 100.0, w: 800.0, h: 500.0 };

    fn shown(x: f64, y: f64, w: f64, h: f64) -> bool {
        visible(r(x, y, w, h), VIEW).is_some()
    }

    #[test]
    fn finds_the_visible_part_of_a_frame() {
        assert!(shown(10.0, 120.0, 50.0, 20.0));
        let part = visible(r(10.0, 590.0, 50.0, 40.0), VIEW).unwrap();
        assert_eq!((part.y, part.h), (590.0, 10.0), "partly visible");
        assert!(!shown(10.0, 700.0, 50.0, 20.0));
        assert!(!shown(10.0, 20.0, 50.0, 20.0));
        assert!(!shown(900.0, 120.0, 50.0, 20.0));
    }

    #[test]
    fn zero_size_frames_on_the_viewport_edge_are_offscreen() {
        assert!(!shown(10.0, 600.0, 120.0, 0.0), "Chromium below the fold");
        assert!(!shown(10.0, 100.0, 120.0, 0.0), "Chromium above the fold");
        assert_eq!(visible(r(10.0, 300.0, 0.0, 0.0), VIEW).map(|v| (v.x, v.y)), Some((10.0, 300.0)), "layout wrapper inside the view");
        assert!(shown(0.0, 300.0, 800.0, 0.0), "zero-height wrapper at left edge");
    }

    #[test]
    fn intersects_rectangles() {
        let i = intersect(r(0.0, 0.0, 100.0, 100.0), r(50.0, 50.0, 100.0, 100.0)).unwrap();
        assert_eq!((i.x, i.y, i.w, i.h), (50.0, 50.0, 50.0, 50.0));
        assert!(intersect(r(0.0, 0.0, 10.0, 10.0), r(10.0, 0.0, 10.0, 10.0)).is_none(), "touching edges");
    }

    fn lines(items: &[(Key, &str)]) -> Vec<(Key, String)> {
        items.iter().map(|(k, l)| (*k, l.to_string())).collect()
    }

    #[test]
    fn renders_the_whole_tree_without_a_base() {
        let out = render(&lines(&[(Key::Element(0), "[0] Button \"OK\"")]), None);
        assert_eq!(out.tree, "[0] Button \"OK\"\n");
        assert!(!out.diffed);
    }

    #[test]
    fn marks_added_and_changed_lines_and_lists_removed_ids() {
        let before = lines(&[
            (Key::Element(0), "[0] A"),
            (Key::Element(1), "[1] B"),
            (Key::Element(2), "[2] C"),
            (Key::Element(3), "[3] D"),
            (Key::Element(4), "[4] E"),
            (Key::Note(ROOT, 0), "… 3 offscreen"),
        ]);
        let base: HashMap<Key, String> = before.into_iter().collect();
        let after = lines(&[
            (Key::Element(0), "[0] A"),
            (Key::Element(1), "[1] B changed"),
            (Key::Element(2), "[2] C"),
            (Key::Element(4), "[4] E"),
            (Key::Element(5), "  [5] F"),
        ]);
        let out = render(&after, Some(&base));
        assert!(out.diffed);
        assert_eq!(out.tree, "~ [1] B changed\n+   [5] F\n");
        assert_eq!(out.removed, vec![3]);
    }

    #[test]
    fn falls_back_to_the_whole_tree_when_most_lines_changed() {
        let base: HashMap<Key, String> = lines(&[(Key::Element(0), "[0] A"), (Key::Element(1), "[1] B")]).into_iter().collect();
        let after = lines(&[(Key::Element(0), "[0] A2"), (Key::Element(1), "[1] B2"), (Key::Element(2), "[2] C")]);
        let out = render(&after, Some(&base));
        assert!(!out.diffed);
        assert_eq!(out.tree, "[0] A2\n[1] B2\n[2] C\n");
        assert!(out.removed.is_empty());
    }

    #[test]
    fn reports_no_change_as_an_empty_diff() {
        let after = lines(&[(Key::Element(0), "[0] A")]);
        let base: HashMap<Key, String> = after.iter().cloned().collect();
        let out = render(&after, Some(&base));
        assert!(out.diffed);
        assert_eq!(out.tree, "");
    }

    fn props(role: &str) -> Props {
        Props { role: role.into(), ..Default::default() }
    }

    #[test]
    fn describes_richer_element_state() {
        let mut field = props("AXTextField");
        field.subrole = Some("AXSearchField".into());
        field.label = Some("Search mail".into());
        field.placeholder = Some("Search".into());
        field.settable = true;
        field.focused = true;
        assert_eq!(field.describe(), ("TextField:SearchField \"Search mail\" placeholder \"Search\" [focused settable]".into(), true));

        let mut link = props("AXLink");
        link.title = Some("Docs".into());
        link.url = Some("https://example.com/docs".into());
        link.actions = vec!["AXPress".into()];
        assert_eq!(link.describe().0, "Link \"Docs\" url \"https://example.com/docs\" <Press>");

        let mut check = props("AXCheckBox");
        check.title = Some("Remember me".into());
        check.value = Some("1".into());
        assert_eq!(check.describe().0, "CheckBox \"Remember me\" [checked]");
        check.value = Some("0".into());
        assert_eq!(check.describe().0, "CheckBox \"Remember me\" [unchecked]");

        let mut disclosure = props("AXDisclosureTriangle");
        disclosure.expanded = Some(false);
        disclosure.disabled = true;
        assert_eq!(disclosure.describe(), ("DisclosureTriangle [disabled collapsed]".into(), true));

        let mut window = props("AXWindow");
        window.subrole = Some("AXStandardWindow".into());
        assert_eq!(window.describe(), ("Window".into(), false), "unremarkable containers fold away");
    }

    #[test]
    fn keeps_long_text_values() {
        let mut text = props("AXStaticText");
        text.value = Some("x".repeat(500));
        assert_eq!(text.describe().0.len(), "StaticText = \"\"".len() + 500);
        let mut button = props("AXPopUpButton");
        button.value = Some("y".repeat(500));
        assert!(button.describe().0.ends_with("…\""), "short limit for non-text roles");
    }

    #[test]
    fn placeholder_only_shows_when_empty() {
        let mut field = props("AXTextField");
        field.value = Some("hello".into());
        field.placeholder = Some("Type here".into());
        assert_eq!(field.describe().0, "TextField = \"hello\"");
    }

    #[test]
    fn merges_neighbouring_text_runs() {
        let line = |y: f64| Some(r(0.0, y, 50.0, 20.0));
        let parts: Vec<(String, Option<Rect>)> =
            [("Read the ", 0.0), ("docs", 0.0), (", then ", 0.0), ("Hel", 0.0), ("lo", 0.0), ("Next line", 20.0)]
                .iter()
                .map(|(s, y)| (s.to_string(), line(*y)))
                .collect();
        assert_eq!(merged_text(&parts), "StaticText = \"Read the docs, then Hello⏎Next line\"");
        let mut t = props("AXStaticText");
        t.value = Some("hi".into());
        assert!(t.plain_text());
        t.actions = vec!["AXPress".into()];
        assert!(!t.plain_text(), "actionable text stays its own line");
    }

    fn loc(name: &str) -> Locator {
        let mut p = props("AXButton");
        p.title = Some(name.into());
        Locator::ROOT.child(&p)
    }

    #[test]
    fn locators_follow_role_name_and_ancestry() {
        assert_eq!(loc("OK"), loc("OK"));
        assert_ne!(loc("OK"), loc("Cancel"));
        let mut group = props("AXGroup");
        group.identifier = Some("toolbar".into());
        let mut ok = props("AXButton");
        ok.title = Some("OK".into());
        assert_ne!(Locator::ROOT.child(&group).child(&ok), loc("OK"));
    }

    #[test]
    fn ids_survive_offscreen_pruning() {
        let mut ids: Ids<&str> = Ids::new();
        let a = ids.assign(&"a", 1, loc("a"), |_| false);
        let b = ids.assign(&"b", 2, loc("b"), |_| false);
        let mut ids = ids.carry();
        assert_eq!(ids.assign(&"a", 1, loc("a"), |_| false), a);
        let mut ids = ids.carry();
        let c = ids.assign(&"c", 3, loc("c"), |_| false);
        let mut ids = ids.carry();
        assert_eq!(ids.assign(&"b", 2, loc("b"), |_| false), b, "scrolled back: same id");
        assert_eq!(ids.assign(&"c", 3, loc("c"), |_| false), c);
        assert_eq!(ids.next, 3);
        assert!(ids.seen(&"b", 2) && !ids.seen(&"a", 1), "only this walk counts as seen");
    }

    #[test]
    fn parked_ids_expire() {
        let mut ids: Ids<&str> = Ids::new();
        ids.assign(&"a", 1, loc("a"), |_| false);
        for _ in 0..=PARK_OBSERVATIONS + 1 {
            ids = ids.carry();
        }
        assert_eq!(ids.assign(&"a", 1, loc("a"), |_| false), 1, "forgotten after too long");
    }

    #[test]
    fn rebuilt_elements_inherit_ids_by_locator() {
        let mut ids: Ids<&str> = Ids::new();
        let send = ids.assign(&"send-v1", 10, loc("Send"), |_| false);
        let mut ids = ids.carry();
        assert_eq!(ids.assign(&"send-v2", 11, loc("Send"), |e| *e == "send-v1"), send, "old object is dead");
        let mut ids = ids.carry();
        assert_eq!(ids.assign(&"send-v2", 11, loc("Send"), |_| false), send, "the new object is what is remembered");
        let mut ids = ids.carry();
        assert_ne!(ids.assign(&"send-v3", 12, loc("Send"), |_| false), send, "old object still alive: a second button");
    }

    #[test]
    fn ambiguous_locators_get_new_ids() {
        let mut ids: Ids<&str> = Ids::new();
        let row1 = ids.assign(&"row1", 1, loc("Row"), |_| false);
        ids.assign(&"row2", 2, loc("Row"), |_| false);
        let mut ids = ids.carry();
        let fresh = ids.assign(&"row3", 3, loc("Row"), |_| true);
        assert!(fresh >= 2 && fresh != row1);
        assert_eq!(ids.assign(&"row1", 1, loc("Row"), |_| true), row1, "same object still matches directly");
    }

    #[test]
    fn spots_large_regions_with_nothing_readable() {
        let window = r(0.0, 0.0, 1000.0, 800.0);
        assert!(sparse(r(0.0, 80.0, 1000.0, 700.0), window, 0));
        assert!(!sparse(r(0.0, 80.0, 1000.0, 700.0), window, 3));
        assert!(!sparse(r(0.0, 0.0, 100.0, 100.0), window, 0));
    }
}
