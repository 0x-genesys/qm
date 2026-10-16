# desk

A small Rust program that lets an agent see and drive Mac apps: list running apps, read a window's accessibility tree as numbered elements (plus an optional screenshot), and run batches of clicks, typing, keys, scrolls and drags. It speaks JSON lines on stdio; see `PROTOCOL.md`. It copies the _shape_ of Codex's Computer Use: AX tree first, indexed targets, events posted to the target pid. No Codex code or prompt text is used.

The QM desktop app bundles the release binary at `QM.app/Contents/Resources/desk` and spawns `desk serve` on first use, so macOS attributes Accessibility and Screen Recording to QM. `npm run package` in `desktop/` builds it with Cargo first.

**Status:** exercised in the signed macOS desktop trial for permission setup, app observation, and Calculator interaction.

## Build and try it alone

```sh
cargo build --release
./target/release/desk permissions --prompt
open -a Calculator
./target/release/desk apps
./target/release/desk observe Calculator --png /tmp/calc.png
./target/release/desk act Calculator '[{"type":"click","target":{"index":12}}]'
```

Run alone, macOS grants permissions to the terminal that launches desk, so switch your terminal on under System Settings > Privacy & Security > Accessibility and Screen Recording, then restart it.

All running apps can be observed and controlled, subject to macOS permissions.

## Platform considerations

- **Background input is experimental.** Desk sends target-only synthetic activation and input without raising the app, but some apps may ignore it. `{"type":"raise"}` is an explicit foreground action. Live Mac verification is still required.
- **Screenshots.** On macOS 14+ they use ScreenCaptureKit's `SCScreenshotManager`. The app's own menus, popovers and sheets in front of the target window are composited in, and the image grows to include any part outside the window, across displays if needed; `frame` says which screen area it covers. macOS 12.3–13 falls back to `CGWindowListCreateImage`. desk links ScreenCaptureKit, so it needs macOS 12.3 or later. `pixels_per_point` still needs checking on a Retina screen.
- **`_AXUIElementGetWindow`** (private, widely used) maps the AX window to a window id for capture and event targeting.
- **Clipboard.** `paste` replaces the general pasteboard, presses Cmd+V and restores the previous contents only once the focused field visibly contains the pasted text. When it cannot confirm that (canvas or terminal views without readable text, password fields, slow apps), it leaves the pasted text on the clipboard and says so, rather than risk the app pasting the user's clipboard. It waits by running the run loop on desk's main thread, where the pasteboard calls its data provider; this has not yet been exercised on a Mac.
- **Keyboard layout.** `type_text` reads the current layout with `TISCopyCurrentKeyboardLayoutInputSource` and `UCKeyTranslate` on desk's main thread (TIS calls are main-thread only on recent macOS).
- **`AXManualAccessibility`** is set on each app so Electron and Chrome apps expose their trees.
- **Speed.** Each element costs about 7 AX round trips, so big windows may take seconds. Skipping offscreen subtrees and the 6,000-element read cap bound this.
- **Universal binary:** `cargo build --release --target aarch64-apple-darwin --target x86_64-apple-darwin`, then `lipo`.
