# desk protocol

`desk serve` reads one JSON request per line on stdin and writes one JSON response per line on stdout, in order. Requests run one at a time. Every type is a closed serde type with `deny_unknown_fields`, tagged by `"type"`. Source of truth: `src/protocol.rs`.

## Requests

```
Request  { id: u64, cmd: Command }

Command  = permissions { prompt?: bool = false }
         | apps
         | observe     { app: string, screenshot?: bool = false, diff?: bool = true }
         | act         { app: string, actions: [Action], observe?: bool = true, screenshot?: bool = false, pace?: bool = false, diff?: bool = true }
         | arrived                                           // only as the answer to a pointer reply, with the same id

Action   = click       { target: Target, button?: left|right|middle = left, count?: u8 = 1,
                         modifiers?: [command|shift|option|control], hold_ms?: u32 = 0 }
         | type_text   { text: string }
         | paste       { text: string, format?: text|markdown|html = text }
         | press_key   { key: string, hold_ms?: u32 = 0 }           // a chord such as "cmd+shift+t"
         | scroll      { target?: Target, direction: up|down|left|right, amount?: Amount = { "pages": 1 } }
         | select_text { index: u32, text: string, prefix?: string, suffix?: string,
                         selection?: text|cursor_before|cursor_after = text }
         | drag        { from: Point, to: Point }
         | set_value   { index: u32, value: string }
         | perform     { index: u32, action: string }        // any AX action the element lists, e.g. "ShowMenu", "Increment"
         | raise                                             // bring the app's window to the front (steals focus)
         | wait        { ms: u32 }                            // capped at 10000

Target   = { "index": u32 } | { "point": Point }
Amount   = { "pages": f64 } | { "pixels": u32 }
Point    = { x: f64, y: f64 }
```

`app` matches a running app's name or bundle id, case-insensitive. An installed app that is not running is opened in the background (`open -g`) first. A `press_key` chord is modifiers (`cmd`, `shift`, `opt`/`alt`, `ctrl`) joined by `+` and ending in a key, which is a letter, digit, punctuation, `return`, `tab`, `space`, `delete`, `escape`, `forwarddelete`, `home`, `end`, `pageup`, `pagedown`, arrows (`left` …), or `f1`–`f12`.

Example:

```json
{"id":1,"cmd":{"type":"observe","app":"Calculator"}}
{"id":2,"cmd":{"type":"act","app":"Calculator","actions":[{"type":"click","target":{"index":12}},{"type":"type_text","text":"*3="}]}}
```

## Responses

```
Response { id: u64, reply: Reply }          // id 0 when the line could not be parsed

Reply    = permissions { accessibility: bool, screen_recording: bool, binary: string, help: string }
         | apps        { apps: [AppInfo] }
         | observation { ...Observation }
         | acted       { completed: u32, failure: Failure?, observation: Observation?, observation_failure: Failure? }
         | pointer     { action: u32, point: Point }        // paced act only; point is in global screen points
         | error       { ...Failure }

AppInfo     { name, bundle_id?, pid: i32, active: bool }
Observation { app, bundle_id?, pid, window: string, frame: Rect, elements: u32, truncated: bool,
              diffed: bool, tree: string, removed: [u32], screenshot: Screenshot? }
Rect        { x, y, w, h }                   // global screen points, top-left origin
Screenshot  { png_base64, width, height, pixels_per_point, frame: Rect }   // frame = global screen points the image covers
Failure     { code: ErrorCode, message: string, action: u32? }   // action = index of the failed action in a batch
ErrorCode   = bad_request | unsupported_platform | permission_missing | app_not_found
            | no_window | bad_index | unknown_key | action_failed | paste_conflict
```

## Observation semantics

- The tree covers the visible part of the app's focused window (else main, else first). One line per kept element:
  `[id] Role:Subrole "name" (description) = "value" placeholder "…" url "…" [focused disabled selected checked|unchecked|mixed expanded|collapsed settable] <Actions>`.
  The name is `AXTitle`, else the text of the element's `AXTitleUIElement` label. Checkbox, radio and switch values are
  shown as `checked`/`unchecked`/`mixed`, not `= "1"`. Text roles keep values up to 1,000 characters, others 120.
  Unlabelled containers are folded away; indentation shows nesting.
- Neighbouring plain static texts (no actions, not focused or selected) merge into one `StaticText` line carrying the
  first one's id; a fragment that starts on a lower line than the previous one is joined with `⏎`, others verbatim.
- Open menus (context menus and menu-bar menus) and the app's other sheets, popovers, drawers and dialog or floating
  windows come first, under `Open menus and other windows of this app:`, followed by `Window "title":` and the
  window's tree. Without any, the tree starts directly.
- After the tree, `Focus: [id]` names the app's focused element (or describes it when it is not in the tree), and
  `Selected text: "…"` quotes its selection when there is one.
- Children outside the window, or outside an enclosing `AXScrollArea` or `AXWebArea`, are not walked. Each container
  that had some gets one note line, `… N more offscreen; scroll to reveal`. Zero-size frames count as offscreen unless
  strictly inside the visible area (Chromium pins scrolled-out elements to the viewport edge with zero height).
- The tree is capped at about 60,000 characters of lines and 6,000 AX elements read (`truncated: true`). Every container
  cut short by the cap gets `… N more not shown; the observation size limit was reached`.
- A web area, or a childless group or scroll area, covering at least 40% of the window with nothing readable inside gets
  `… nothing readable inside; the app may draw this area itself (for example a canvas). Use the screenshot and point targets`.
- Each element's attributes are read in one batched call; actions and settability only for elements that are walked.
  On the first observation of an app desk sets `AXManualAccessibility`, falls back to `AXEnhancedUserInterface` (turned
  off again when desk exits), and waits up to 1 s for an empty web area to fill.
- `point` targets are **window-relative points** (origin = window top-left).
  The screenshot covers its own `frame`: the window plus the app's menus, popovers and sheets in front of it, so it can reach past the window.
  It is captured at nominal resolution, so one PNG pixel is about one point; `pixels_per_point` says what it really was.
  To send a `point`, divide PNG pixels by `pixels_per_point`, then add the screenshot `frame` origin minus the observation `frame` origin.
- Observe before acting; absent snapshots are rejected. Ids are stable: an element keeps its id across observations of the same window for as long as it is the same AX object, including while it is scrolled out of view for up to 30 observations. When the app replaces an object (a re-render), the new one inherits the id if exactly one old object had the same role, subrole, identifier, name and ancestry and that old object is gone. Acting on an id whose object is gone looks for that single replacement first and fails with `bad_index` if there is none. A different window starts ids again. `index` in actions means this id, from the latest observation of that app.
- With `diff` (the default) and an earlier observation of the same window, `tree` holds only new lines, prefixed `+ `, and changed ones, prefixed `~ `; `removed` lists ids that disappeared and `diffed` is true. When more than 60% of the lines are new or changed, or otherwise, `tree` is the whole tree, unprefixed, and `diffed` is false.
- `act` returns as soon as its actions are sent. The next observation of that app (`observe`, or `act` with `observe`) first waits until 1 s has passed since the last action, then up to 5 s more while the window shows a busy or progress indicator. An observation with no action since the previous one does not wait. A batch of only `wait` actions does not count as an action.
- A batch stops at the first failed action. `acted.completed` counts what ran; the observation or `observation_failure` comes back without losing the completion count.

## Pacing

With `pace: true`, before each `click`, `scroll` and `drag`, desk writes `pointer` with the request's id, the action's index and the global screen point it is about to use (element centre, window centre for an untargeted scroll, `from` for a drag). It then reads exactly one line, which must be `{"id": <same id>, "cmd": {"type": "arrived"}}`, and only then performs the action. Anything else fails that action with `bad_request`. The QM desktop app uses this to fly its cursor overlay to the point first. Send nothing else while a paced act is running.

## How actions are delivered

- `click` on an index, left button, single: `AXPress` if the element offers it (no pointer, no focus change); otherwise a synthetic click at the center of the element's visible part.
- A synthetic-click index target that is offscreen (outside the window or an enclosing scroll or web area) is first sent `AXScrollToVisible`; if it is still offscreen 250 ms later, the action fails with `action_failed`.
- Other clicks, `drag`, `scroll`, `type_text`, `press_key`, and the Cmd+V of `paste`: CGEvents posted to the app's pid (`CGEventPostToPid`). The real pointer does not move. For a click in web content, desk brings an inactive app forward first; other background actions may be ignored.
- `type_text` sends each character with the key code and Shift/Option flags that type it on the user's current keyboard layout, plus the character itself. `\n`, `\r\n` and `\r` press Return and `\t` presses Tab. Characters the layout cannot type (emoji, other scripts, dead-key accents) are sent as text on key code 0.
- `paste` puts the text on the general pasteboard (plain text, plus HTML for `markdown` and `html`; markdown is converted to HTML), marked `org.nspasteboard.TransientType` so clipboard managers skip it, and presses Cmd+V. The data is promised lazily, but a read of it is not taken as proof, because the pasteboard does not say which app read it. desk restores the previous clipboard only after the app's focused field shows its previous text with the pasted text (the plain text, or for `markdown` and `html` also the text of the HTML) inserted exactly at the selection; only line endings and non-breaking spaces are normalised. If the clipboard holds a concealed item (`org.nspasteboard.ConcealedType`, which password managers use), `paste` fails without touching the clipboard. Otherwise (no read within 3 s, the field never shows the text within 1.5 s of the read, the focused field's text cannot be read, or cancellation after Cmd+V) the action fails with `action_failed`, desk's text stays on the clipboard and the previous clipboard is not restored, so a late paste cannot insert the user's clipboard. If the clipboard changes for another reason meanwhile, desk keeps that new content and fails with `paste_conflict`, because the app may have pasted it instead.
- `click` holds `modifiers` and keeps the button down for `hold_ms`. `press_key` holds the key for `hold_ms`.
- `scroll` sends pixel wheel events in 120 px steps; a page is 85% of the target element's height (or width), else the window's.
- `select_text` finds `text` in the element's `AXValue` (the occurrence preceded by `prefix` and followed by `suffix`), focuses the element and sets `AXSelectedTextRange` to the text or a caret before or after it.
- `set_value` writes `AXValue`. `perform` runs any listed AX action.

## App access

All installed apps are available subject to macOS permissions. Observation and control require Accessibility; screenshots also require Screen Recording.
