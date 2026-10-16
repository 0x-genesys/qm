use crate::protocol::Rect;
use std::collections::{HashMap, HashSet};

const EDGE: f64 = 1.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Key {
    Element(u32),
    Note(u32, u32),
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
            Key::Note(..) => None,
        })
        .collect();
    removed.sort_unstable();
    Rendered { tree, diffed: true, removed }
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
}
