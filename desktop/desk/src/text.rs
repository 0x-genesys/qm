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
}
