//! Platform-independent parts of an observation: what counts as visible, and how a tree is diffed.

use crate::protocol::Rect;
use std::collections::{HashMap, HashSet};

/// Points of slack when deciding whether a zero-size frame sits on the edge of the visible area.
const EDGE: f64 = 1.0;

/// Identifies a tree line across observations: an element id, or the nth note under an element (`ROOT` for the window).
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Place {
    Visible,
    /// Outside the visible area; `below` when past its bottom edge.
    Hidden {
        below: bool,
    },
}

/// Where an element sits relative to `clip`, the visible part of its window and scroll areas.
/// Chromium reports elements scrolled out of view as zero-height frames pinned to the viewport edge, so a zero-size
/// frame counts as visible only strictly inside the clip, where it is a layout wrapper whose children may show.
pub fn place(frame: Option<Rect>, clip: Rect) -> Place {
    let Some(f) = frame else { return Place::Visible };
    let (right, bottom) = (clip.x + clip.w, clip.y + clip.h);
    let visible = if f.w > 0.0 && f.h > 0.0 {
        intersect(f, clip).is_some()
    } else {
        f.x >= clip.x && f.x <= right && f.y > clip.y + EDGE && f.y < bottom - EDGE
    };
    if visible {
        Place::Visible
    } else {
        Place::Hidden { below: f.y >= bottom - EDGE }
    }
}

pub struct Rendered {
    pub tree: String,
    pub diffed: bool,
    pub removed: Vec<u32>,
}

/// Renders `lines`, or with `base` only what changed: `+ ` new lines, `~ ` changed ones, and the element ids that
/// disappeared. Falls back to the whole tree when more than 60% of it changed, since the diff would cost as much.
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

    #[test]
    fn places_elements_against_the_visible_area() {
        assert_eq!(place(None, VIEW), Place::Visible);
        assert_eq!(place(Some(r(10.0, 120.0, 50.0, 20.0)), VIEW), Place::Visible);
        assert_eq!(place(Some(r(10.0, 590.0, 50.0, 40.0)), VIEW), Place::Visible, "partly visible");
        assert_eq!(place(Some(r(10.0, 700.0, 50.0, 20.0)), VIEW), Place::Hidden { below: true });
        assert_eq!(place(Some(r(10.0, 20.0, 50.0, 20.0)), VIEW), Place::Hidden { below: false });
        assert_eq!(place(Some(r(900.0, 120.0, 50.0, 20.0)), VIEW), Place::Hidden { below: false });
    }

    #[test]
    fn zero_size_frames_on_the_viewport_edge_are_offscreen() {
        assert_eq!(place(Some(r(10.0, 600.0, 120.0, 0.0)), VIEW), Place::Hidden { below: true }, "Chromium below the fold");
        assert_eq!(place(Some(r(10.0, 100.0, 120.0, 0.0)), VIEW), Place::Hidden { below: false }, "Chromium above the fold");
        assert_eq!(place(Some(r(10.0, 300.0, 0.0, 0.0)), VIEW), Place::Visible, "layout wrapper inside the view");
        assert_eq!(place(Some(r(0.0, 300.0, 800.0, 0.0)), VIEW), Place::Visible, "zero-height wrapper at left edge");
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
