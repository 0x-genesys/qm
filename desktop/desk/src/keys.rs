//! Key names for `press_key`: xdotool-style names, keypad, F1–F20, modifier keys, and characters
//! resolved through the current keyboard layout.

use crate::protocol::Modifier;
use crate::text::Stroke;
use std::collections::HashMap;

/// A resolved key press: the main key's code, the modifiers held around it, and, for a lone
/// modifier such as `shift`, which modifier it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chord {
    pub code: u16,
    pub mods: Vec<Modifier>,
    pub lone: Option<Modifier>,
}

const NAMED: &[(&str, u16)] = &[
    ("return", 36),
    ("enter", 36),
    ("linefeed", 36),
    ("tab", 48),
    ("space", 49),
    ("delete", 51),
    ("backspace", 51),
    ("escape", 53),
    ("esc", 53),
    ("forwarddelete", 117),
    ("insert", 114),
    ("help", 114),
    ("home", 115),
    ("end", 119),
    ("pageup", 116),
    ("prior", 116),
    ("pagedown", 121),
    ("next", 121),
    ("left", 123),
    ("right", 124),
    ("down", 125),
    ("up", 126),
    ("capslock", 57),
    ("f1", 122),
    ("f2", 120),
    ("f3", 99),
    ("f4", 118),
    ("f5", 96),
    ("f6", 97),
    ("f7", 98),
    ("f8", 100),
    ("f9", 101),
    ("f10", 109),
    ("f11", 103),
    ("f12", 111),
    ("f13", 105),
    ("f14", 107),
    ("f15", 113),
    ("f16", 106),
    ("f17", 64),
    ("f18", 79),
    ("f19", 80),
    ("f20", 90),
    ("kp0", 82),
    ("kp1", 83),
    ("kp2", 84),
    ("kp3", 85),
    ("kp4", 86),
    ("kp5", 87),
    ("kp6", 88),
    ("kp7", 89),
    ("kp8", 91),
    ("kp9", 92),
    ("kpdecimal", 65),
    ("kpseparator", 65),
    ("kpmultiply", 67),
    ("kpadd", 69),
    ("kpplus", 69),
    ("kpclear", 71),
    ("numlock", 71),
    ("clear", 71),
    ("kpdivide", 75),
    ("kpenter", 76),
    ("kpsubtract", 78),
    ("kpminus", 78),
    ("kpequal", 81),
];

/// Keys on a US layout, used when the current layout cannot be read or lacks the character.
const US: &[(char, u16)] = &[
    ('a', 0),
    ('s', 1),
    ('d', 2),
    ('f', 3),
    ('h', 4),
    ('g', 5),
    ('z', 6),
    ('x', 7),
    ('c', 8),
    ('v', 9),
    ('b', 11),
    ('q', 12),
    ('w', 13),
    ('e', 14),
    ('r', 15),
    ('y', 16),
    ('t', 17),
    ('1', 18),
    ('2', 19),
    ('3', 20),
    ('4', 21),
    ('6', 22),
    ('5', 23),
    ('=', 24),
    ('9', 25),
    ('7', 26),
    ('-', 27),
    ('8', 28),
    ('0', 29),
    (']', 30),
    ('o', 31),
    ('u', 32),
    ('[', 33),
    ('i', 34),
    ('p', 35),
    ('l', 37),
    ('j', 38),
    ('\'', 39),
    ('k', 40),
    (';', 41),
    ('\\', 42),
    (',', 43),
    ('/', 44),
    ('n', 45),
    ('m', 46),
    ('.', 47),
    ('`', 50),
];

/// xdotool keysym names for characters.
const SYMBOLS: &[(&str, char)] = &[
    ("comma", ','),
    ("period", '.'),
    ("slash", '/'),
    ("backslash", '\\'),
    ("semicolon", ';'),
    ("colon", ':'),
    ("apostrophe", '\''),
    ("quoteright", '\''),
    ("quotedbl", '"'),
    ("grave", '`'),
    ("quoteleft", '`'),
    ("asciitilde", '~'),
    ("minus", '-'),
    ("underscore", '_'),
    ("equal", '='),
    ("plus", '+'),
    ("bracketleft", '['),
    ("bracketright", ']'),
    ("braceleft", '{'),
    ("braceright", '}'),
    ("parenleft", '('),
    ("parenright", ')'),
    ("less", '<'),
    ("greater", '>'),
    ("question", '?'),
    ("exclam", '!'),
    ("at", '@'),
    ("numbersign", '#'),
    ("dollar", '$'),
    ("percent", '%'),
    ("asciicircum", '^'),
    ("ampersand", '&'),
    ("asterisk", '*'),
    ("bar", '|'),
];

/// Modifier names, including xdotool's left/right forms. The code is the key that is pressed
/// when the modifier is the whole chord (`shift`, `Control_R`).
const MODIFIERS: &[(&str, Modifier, u16)] = &[
    ("cmd", Modifier::Command, 55),
    ("command", Modifier::Command, 55),
    ("meta", Modifier::Command, 55),
    ("super", Modifier::Command, 55),
    ("metal", Modifier::Command, 55),
    ("superl", Modifier::Command, 55),
    ("metar", Modifier::Command, 54),
    ("superr", Modifier::Command, 54),
    ("shift", Modifier::Shift, 56),
    ("shiftl", Modifier::Shift, 56),
    ("shiftr", Modifier::Shift, 60),
    ("opt", Modifier::Option, 58),
    ("option", Modifier::Option, 58),
    ("alt", Modifier::Option, 58),
    ("altl", Modifier::Option, 58),
    ("altr", Modifier::Option, 61),
    ("ctrl", Modifier::Control, 59),
    ("control", Modifier::Control, 59),
    ("controll", Modifier::Control, 59),
    ("controlr", Modifier::Control, 62),
];

/// The key code used for a modifier's own key-down and key-up events.
pub fn modifier_code(m: Modifier) -> u16 {
    match m {
        Modifier::Command => 55,
        Modifier::Shift => 56,
        Modifier::Option => 58,
        Modifier::Control => 59,
    }
}

fn norm(name: &str) -> String {
    name.chars().filter(|c| *c != '_').flat_map(char::to_lowercase).collect()
}

fn modifier(name: &str) -> Option<(Modifier, u16)> {
    let n = norm(name);
    MODIFIERS.iter().find(|(k, _, _)| *k == n).map(|(_, m, c)| (*m, *c))
}

fn character(c: char, layout: &HashMap<char, Stroke>) -> Option<(u16, Vec<Modifier>)> {
    let mods = |s: &Stroke| {
        let mut m = vec![];
        if s.shift {
            m.push(Modifier::Shift);
        }
        if s.option {
            m.push(Modifier::Option);
        }
        m
    };
    if let Some(s) = layout.get(&c) {
        return Some((s.code, mods(s)));
    }
    let lower = c.to_lowercase().next().unwrap_or(c);
    if let Some(s) = layout.get(&lower) {
        return Some((s.code, mods(s)));
    }
    let code = US.iter().find(|(k, _)| *k == lower).map(|(_, code)| *code)?;
    Some((code, if lower != c { vec![Modifier::Shift] } else { vec![] }))
}

fn main_key(name: &str, layout: &HashMap<char, Stroke>) -> Option<(u16, Vec<Modifier>)> {
    let mut chars = name.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        return character(c, layout);
    }
    let n = norm(name);
    if let Some((_, code)) = NAMED.iter().find(|(k, _)| *k == n) {
        return Some((*code, vec![]));
    }
    SYMBOLS.iter().find(|(k, _)| *k == n).and_then(|(_, c)| character(*c, layout))
}

/// Resolves a chord such as `cmd+shift+t`, `Page_Down`, `KP_Enter`, `ctrl+A` or a lone `shift`.
/// Characters that need Shift or Option on the current layout get those modifiers added.
pub fn resolve(spec: &str, layout: &HashMap<char, Stroke>) -> Result<Chord, String> {
    let unknown = || format!("unknown key {spec}");
    let parts: Vec<&str> = match spec.strip_suffix("++") {
        Some(rest) => rest.split('+').chain(["+"]).collect(),
        None if spec == "+" => vec!["+"],
        None => spec.split('+').collect(),
    };
    if parts.iter().any(|p| p.is_empty()) {
        return Err(unknown());
    }
    let mut mods: Vec<Modifier> = vec![];
    let mut main: Option<(u16, Vec<Modifier>)> = None;
    let mut lone = None;
    for (i, part) in parts.iter().enumerate() {
        let last = i + 1 == parts.len();
        if let Some((m, code)) = modifier(part).filter(|_| part.chars().count() > 1) {
            if last && main.is_none() && !mods.contains(&m) {
                lone = Some((m, code));
            } else if !mods.contains(&m) {
                mods.push(m);
            }
            continue;
        }
        if main.is_some() {
            return Err(format!("{spec} names more than one non-modifier key; press them one at a time"));
        }
        main = Some(main_key(part, layout).ok_or_else(unknown)?);
    }
    match (main, lone) {
        (Some((code, extra)), _) => {
            for m in extra {
                if !mods.contains(&m) {
                    mods.push(m);
                }
            }
            Ok(Chord { code, mods, lone: None })
        }
        (None, Some((m, code))) => Ok(Chord { code, mods, lone: Some(m) }),
        (None, None) => Err(unknown()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Modifier::*;

    fn us() -> HashMap<char, Stroke> {
        crate::text::layout(|code, shift, option| {
            if option {
                return None;
            }
            let c = US.iter().find(|(_, k)| *k == code).map(|(c, _)| *c)?;
            Some(match (c, shift) {
                ('1', true) => '!',
                ('=', true) => '+',
                (',', true) => '<',
                ('-', true) => '_',
                (c, true) => c.to_ascii_uppercase(),
                (c, false) => c,
            })
        })
    }

    fn r(s: &str) -> Chord {
        resolve(s, &us()).unwrap()
    }

    #[test]
    fn xdotool_names_and_keypad() {
        assert_eq!(r("Page_Down").code, 121);
        assert_eq!(r("Next").code, 121);
        assert_eq!(r("Prior").code, 116);
        assert_eq!(r("KP_Enter").code, 76);
        assert_eq!(r("KP_0").code, 82);
        assert_eq!(r("kp_add").code, 69);
        assert_eq!(r("Insert").code, 114);
        assert_eq!(r("F13").code, 105);
        assert_eq!(r("F20").code, 90);
        assert_eq!(r("BackSpace").code, 51);
        assert_eq!(r("Delete").code, 51, "delete is the Mac Delete key (backspace)");
        assert_eq!(r("forwarddelete").code, 117);
    }

    #[test]
    fn characters_use_the_layout_and_add_shift() {
        assert_eq!(r("a"), Chord { code: 0, mods: vec![], lone: None });
        assert_eq!(r("A"), Chord { code: 0, mods: vec![Shift], lone: None });
        assert_eq!(r("!"), Chord { code: 18, mods: vec![Shift], lone: None });
        assert_eq!(r("exclam"), Chord { code: 18, mods: vec![Shift], lone: None });
        assert_eq!(r("comma").code, 43);
        assert_eq!(r("ctrl+A"), Chord { code: 0, mods: vec![Control, Shift], lone: None });
        assert_eq!(r("cmd+shift+t"), Chord { code: 17, mods: vec![Command, Shift], lone: None });
        assert_eq!(r("cmd++"), Chord { code: 24, mods: vec![Command, Shift], lone: None });
        assert_eq!(r("+"), Chord { code: 24, mods: vec![Shift], lone: None });
        assert_eq!(resolve("A", &HashMap::new()).unwrap(), Chord { code: 0, mods: vec![Shift], lone: None }, "US fallback");
    }

    #[test]
    fn modifiers_alone_and_errors() {
        assert_eq!(r("shift"), Chord { code: 56, mods: vec![], lone: Some(Shift) });
        assert_eq!(r("Control_R"), Chord { code: 62, mods: vec![], lone: Some(Control) });
        assert_eq!(r("cmd+shift"), Chord { code: 56, mods: vec![Command], lone: Some(Shift) });
        assert_eq!(r("Super_L+a").mods, vec![Command]);
        assert!(resolve("a+b", &us()).unwrap_err().contains("more than one"));
        assert!(resolve("hyperdrive", &us()).unwrap_err().contains("unknown key"));
        assert!(resolve("cmd+", &us()).is_err());
        assert!(resolve("", &us()).is_err());
    }
}
