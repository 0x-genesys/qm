use crate::protocol::PasteFormat;
use std::collections::HashMap;

const KEYPAD: &[u16] = &[65, 67, 69, 71, 75, 76, 78, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stroke {
    pub code: u16,
    pub shift: bool,
    pub option: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Key {
    Return,
    Tab,
    Mapped(char, Stroke),
    Unicode(char),
}

pub fn layout(translate: impl Fn(u16, bool, bool) -> Option<char>) -> HashMap<char, Stroke> {
    let mut map = HashMap::new();
    for (shift, option) in [(false, false), (true, false), (false, true), (true, true)] {
        for code in 0..128u16 {
            if KEYPAD.contains(&code) {
                continue;
            }
            if let Some(c) = translate(code, shift, option).filter(|c| !c.is_control() && !('\u{f700}'..='\u{f8ff}').contains(c)) {
                map.entry(c).or_insert(Stroke { code, shift, option });
            }
        }
    }
    map
}

pub fn plan(text: &str, layout: &HashMap<char, Stroke>) -> Vec<Key> {
    let mut keys = vec![];
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        keys.push(match c {
            '\r' => {
                chars.next_if_eq(&'\n');
                Key::Return
            }
            '\n' => Key::Return,
            '\t' => Key::Tab,
            c => layout.get(&c).map_or(Key::Unicode(c), |s| Key::Mapped(c, *s)),
        });
    }
    keys
}

pub fn payload(text: &str, format: PasteFormat) -> (String, Option<String>) {
    match format {
        PasteFormat::Text => (text.to_string(), None),
        PasteFormat::Markdown => {
            let mut html = String::from("<meta charset=\"utf-8\">");
            pulldown_cmark::html::push_html(&mut html, pulldown_cmark::Parser::new_ext(text, pulldown_cmark::Options::all()));
            (text.to_string(), Some(html))
        }
        PasteFormat::Html => (strip_html(text), Some(format!("<meta charset=\"utf-8\">{text}"))),
    }
}

/// The plain texts a paste of `text` may leave in a field: the plain payload, and for formatted
/// pastes also the text of the HTML.
pub fn expected(text: &str, format: PasteFormat) -> Vec<String> {
    let (plain, html) = payload(text, format);
    let mut out = vec![plain];
    if let Some(rendered) = html.map(|h| strip_html(&h)).filter(|r| !out.contains(r)) {
        out.push(rendered);
    }
    out
}

fn norm(s: &[u16]) -> String {
    String::from_utf16_lossy(s).replace("\r\n", "\n").replace(['\r', '\u{2028}', '\u{2029}'], "\n").replace('\u{a0}', " ")
}

fn squeeze(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace()).collect()
}

fn insertion(before: &[char], pasted: &[char], after: &[char]) -> bool {
    if after.len() != before.len() + pasted.len() {
        return false;
    }
    let common = before.iter().zip(after).take_while(|(x, y)| x == y).count();
    (common.saturating_sub(pasted.len())..=common).any(|i| {
        after[..i] == before[..i] && after[i..i + pasted.len()] == *pasted && after[i + pasted.len()..] == before[i..]
    })
}

/// Whether `after` is exactly `before` with one of `pasted` inserted at the selection (UTF-16
/// `[start, length]`), or anywhere when the selection is unknown. Line endings and non-breaking
/// spaces are normalised; whitespace is ignored only when the inserted text has other content.
/// This is the evidence desk needs before it restores the user's clipboard.
pub fn inserted(before: &str, selection: Option<(usize, usize)>, after: &str, pasted: &[String]) -> bool {
    let b: Vec<u16> = before.encode_utf16().collect();
    let (head, tail) = match selection {
        Some((start, len)) if start + len <= b.len() => (norm(&b[..start]), norm(&b[start + len..])),
        Some(_) => return false,
        None => (norm(&b), String::new()),
    };
    let after = norm(&after.encode_utf16().collect::<Vec<_>>());
    if squeeze(&norm(&b)) == squeeze(&after) {
        return false;
    }
    let chars = |s: &str| s.chars().collect::<Vec<_>>();
    pasted.iter().map(|p| norm(&p.encode_utf16().collect::<Vec<_>>())).filter(|p| !p.is_empty()).any(|p| {
        let loose = !squeeze(&p).is_empty();
        if selection.is_some() {
            let exact = format!("{head}{p}{tail}") == after;
            let (sh, sp, st, sa) = (squeeze(&head), squeeze(&p), squeeze(&tail), squeeze(&after));
            exact || (loose && format!("{sh}{sp}{st}") == sa)
        } else {
            insertion(&chars(&head), &chars(&p), &chars(&after))
                || (loose && insertion(&chars(&squeeze(&head)), &chars(&squeeze(&p)), &chars(&squeeze(&after))))
        }
    })
}

fn strip_html(html: &str) -> String {
    let mut out = String::new();
    let mut rest = html;
    while let Some(start) = rest.find('<') {
        out += &rest[..start];
        let Some(end) = rest[start..].find('>') else {
            rest = &rest[start..];
            break;
        };
        let tag = rest[start + 1..start + end].trim_start_matches('/').to_ascii_lowercase();
        let name = tag.split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("");
        if matches!(name, "br" | "p" | "div" | "li" | "tr" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6")
            && !out.ends_with('\n')
            && !out.is_empty()
        {
            out.push('\n');
        }
        rest = &rest[start + end + 1..];
    }
    out += rest;
    let decoded = out
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&");
    decoded.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn us(code: u16, shift: bool, option: bool) -> Option<char> {
        let base = match code {
            0 => 'a',
            9 => 'v',
            18 => '1',
            29 => '0',
            24 => '=',
            49 => ' ',
            83 => '1',
            14 if option => return None,
            14 => 'e',
            _ => return None,
        };
        Some(match (base, shift, option) {
            ('1', true, false) => '!',
            ('=', true, false) => '+',
            ('a', false, true) => 'å',
            ('a', true, true) => 'Å',
            (c, true, false) => c.to_ascii_uppercase(),
            (c, _, _) => c,
        })
    }

    #[test]
    fn layout_prefers_fewest_modifiers_and_main_keys() {
        let map = layout(us);
        assert_eq!(map[&'a'], Stroke { code: 0, shift: false, option: false });
        assert_eq!(map[&'A'], Stroke { code: 0, shift: true, option: false });
        assert_eq!(map[&'!'], Stroke { code: 18, shift: true, option: false });
        assert_eq!(map[&'å'], Stroke { code: 0, shift: false, option: true });
        assert_eq!(map[&'1'].code, 18, "the main-row 1, not the keypad 1");
        assert_eq!(map[&'+'], Stroke { code: 24, shift: true, option: false });
        assert!(!map.values().any(|s| s.code == 14 && s.option), "dead keys are never used");
    }

    #[test]
    fn plan_uses_real_keys_and_presses_return_and_tab() {
        let map = layout(us);
        let keys = plan("Ab\tA\r\n!\n😀", &map);
        assert_eq!(
            keys,
            vec![
                Key::Mapped('A', Stroke { code: 0, shift: true, option: false }),
                Key::Unicode('b'),
                Key::Tab,
                Key::Mapped('A', Stroke { code: 0, shift: true, option: false }),
                Key::Return,
                Key::Mapped('!', Stroke { code: 18, shift: true, option: false }),
                Key::Return,
                Key::Unicode('😀'),
            ]
        );
        assert_eq!(plan("a\r\rb", &map).iter().filter(|k| **k == Key::Return).count(), 2);
        assert_eq!(plan("x", &HashMap::new()), vec![Key::Unicode('x')], "an unreadable layout falls back to text");
    }

    #[test]
    fn payload_formats() {
        assert_eq!(payload("a\nb", PasteFormat::Text), ("a\nb".into(), None));
        let (plain, html) = payload("**hi** there", PasteFormat::Markdown);
        assert_eq!(plain, "**hi** there");
        assert!(html.unwrap().contains("<strong>hi</strong> there"));
        let (plain, html) = payload("<p>One &amp; <b>two</b></p><p>three<br>four</p>", PasteFormat::Html);
        assert_eq!(plain, "One & two\nthree\nfour");
        assert!(html.unwrap().ends_with("<p>One &amp; <b>two</b></p><p>three<br>four</p>"));
    }

    #[test]
    fn paste_format_defaults_to_text() {
        let a: crate::protocol::Action = serde_json::from_str(r#"{"type":"paste","text":"x"}"#).unwrap();
        assert!(matches!(a, crate::protocol::Action::Paste { format: PasteFormat::Text, .. }));
    }
    #[test]
    fn insertion_must_match_the_pasted_text_at_the_selection() {
        let t = |s: &str| vec![s.to_string()];
        assert!(inserted("ab", Some((1, 0)), "aXYb", &t("XY")));
        assert!(inserted("a old b", Some((2, 3)), "a new b", &t("new")), "replaces the selection");
        assert!(inserted("ab", None, "aXYb", &t("XY")), "unknown selection: anywhere");
        assert!(inserted("", Some((0, 0)), "line1\rline2", &t("line1\nline2")), "line endings normalised");
        assert!(inserted("x", Some((1, 0)), "x one\n two", &t("one two")), "whitespace-only differences");
        assert!(!inserted("ab", Some((1, 0)), "ab", &t("XY")), "nothing changed");
        assert!(!inserted("ab", Some((1, 0)), "aZb", &t("XY")), "something else changed");
        assert!(!inserted("ab", Some((0, 0)), "aXYb", &t("XY")), "inserted at the wrong place");
        assert!(!inserted("aXb", Some((1, 1)), "aXb", &t("X")), "replacing a selection with itself is no evidence");
        assert!(!inserted("aXb", Some((1, 0)), "aXb", &t("X")), "unchanged text that already contains the paste");
        assert!(!inserted("ab", None, "aXYbZ", &t("XY")), "unknown selection still needs nothing else to change");
        assert!(!inserted("a", Some((1, 0)), "a\n", &t("\t")), "whitespace pastes need an exact match");
        assert!(!inserted("ab", Some((5, 0)), "aXYb", &t("XY")), "stale selection");
        assert!(!inserted("ab", Some((1, 0)), "aXYb", &[]), "nothing expected");
        let md = expected("**hi** there", PasteFormat::Markdown);
        assert!(inserted("", Some((0, 0)), "hi there", &md), "rich paste of markdown");
        assert!(inserted("", Some((0, 0)), "**hi** there", &md), "plain paste of markdown");
    }
}
