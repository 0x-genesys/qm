# Browser-driving capability ledger

The baseline is Playwright 1.64.0's Chromium API and the browser-driving interfaces observed
in Codex app 26.1007.30912. The latter was a static interface inspection, not a claim about
all Codex backends or later releases. No proprietary implementation was copied.

The implementation exposes actual upstream `Browser` and `Page` objects through
`browser.playwright` and `tab.playwright`. It does not enumerate permitted methods. This
inherits the versioned API; it does not establish that every provider behavior works.

## Concrete behavior coverage

| Capability                                                  | Implementation                                                | Behavioral evidence                                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Persistent JavaScript, values and ordinary errors           | Node REPL in a separate worker                                | `browse-skill.test.ts`: multiple calls, thrown values, awaited errors, output bounds                                                    |
| Full Page/Browser object surface                            | Native Playwright protocol and `Browser.bind`                 | `browse-client.test.ts`, `browse-parity.test.ts`: identity, prototypes, events, functions and handles                                   |
| Tabs, popups, selection and navigation                      | Native pages plus tab conveniences                            | Parity suite: popup waits, tab selection, back/forward/reload and beforeunload                                                          |
| History preserving page state                               | Scoped native BFCache restoration adapter                     | `browse-history.test.ts`: retained page state, seven restored frames, one navigation event; hosted nested-frame proof                   |
| Semantic/CSS selectors, regex, composition and state        | Native locators                                               | Parity suite: all builders, filters, shadow roots, visibility/enabled/detached state                                                    |
| Same-origin, cross-origin, nested and out-of-process frames | Native frames/locators                                        | Parity suite: seven frame documents, transformed/scrolled owners, reload/swap and cross-frame files                                     |
| Mouse buttons, modifiers, hover, drag and wheel             | Native mouse/locators; CUA convenience                        | Parity suite and client tests: trusted input, right/middle clicks, numeric back/forward and held-key cleanup                            |
| Keyboard, focus, shortcuts and Unicode                      | Native keyboard/locators                                      | Parity suite: key events, beforeinput, focus traversal and text insertion                                                               |
| Text/password/date/number/rich input, selects and checks    | Native control actions                                        | Parity suite: native forms and state, including invalid/hidden/disabled targets                                                         |
| DOM reference actions                                       | Native AI snapshot references and `getByRef`                  | Parity suite: actions in all seven frame documents                                                                                      |
| Editable-value snapshot masking                             | Read-only DOM identity metadata, not ARIA-role trust          | Client tests: spoofed roles, password/textarea, nested/shadow/flattened editors, concurrent reads and stale references                  |
| Viewport/full-page/clip/element screenshots                 | Native screenshot API                                         | Parity suite: PNG dimensions and nonempty bytes                                                                                         |
| Functions, arguments and handles                            | Native evaluation and handle lifetimes                        | Parity suite: object/element handles and typed arguments                                                                                |
| Dialogs and event ordering                                  | Native event subscriptions                                    | Parity suite: popup, download, chooser, alert/confirm/prompt/beforeunload; wait armed before action                                     |
| Text and rich clipboard                                     | Browser Clipboard API under native permissions                | Client/parity suites: text, HTML and PNG round trips                                                                                    |
| Cookies, storage, viewport, permissions and network         | Native contexts, routes and request/response APIs             | Parity suite: observable state and real routed responses                                                                                |
| Ordinary uploads, clearing and file choosers                | Native upload path                                            | File/parity suites: exact contents and input clearing                                                                                   |
| Large uploads across the remote boundary                    | Chunked transfer into genuine File objects                    | `browse-upload.test.ts`: 51 MiB through four API paths, exact hash/metadata/structuredClone, multipart submission, abort and events     |
| Download artifacts                                          | Actual completed remote file streamed into native Artifact    | `browse-files.test.ts`: GET/POST/blob bytes, repeated names, streams/saveAs/delete/cancel, truncation and ambiguity rejection           |
| Cloud lifecycle and uncertain outcomes                      | Explicit provider stop; no mutation replay                    | Skill/service tests: credits, duplicate opens, stale recovery, stop retry, busy health, abandoned queue and asynchronous worker failure |
| Proxy-restricted sandboxes                                  | Fixed-target relay using maintained WebSocket/proxy libraries | Proxy tests: CONNECT, binary payload, backpressure and cleanup; actual Sprite end-to-end proof                                          |

The native test suites are opt-in where they require a browser. A skipped test is not a
successful browser run. Run them with their documented `BROWSE_TEST_CDP` endpoint and, for
the full hosted fixture, `BROWSE_TEST_BASE` and `BROWSE_TEST_CROSS_ORIGIN`. Those origins must
serve the synthetic fixture over HTTPS and produce actual separate renderer targets.

## Known provider boundaries

These are observed incompatibilities, not deliberately omitted driver commands:

- **Console representation:** Browser Use supplies legacy `Console.messageAdded` but does
  not emit `Runtime.consoleAPICalled` in the tested browsers. Genuine legacy events repair
  `setContent` and supply console text/location. Original argument handles, exact console
  method and browser timestamps are absent. Returned capability metadata states this;
  a JavaScript console emulator is not substituted.
- **Native directory uploads:** the tested provider flattens CDP download paths and Chrome
  extension filename suggestions, including `onDeterminingFilename`/`uniquify`. V2 browser
  and session uploads and V3/V4 workspace uploads also sanitize nested paths to basenames.
  OPFS files expose no native path; dragging the downloads directory itself is refused.
  No supported hierarchical staging operation has been established. File properties are
  not spoofed to make a directory test appear to pass.
- **Concurrent download-name collisions:** the provider can overwrite the same remote
  filename. Sequential repeats work; overlapping collisions whose identity cannot be
  established fail instead of returning another download's bytes.

Ordinary upstream remote-client semantics also remain: for example, `Download.path()` is
not available through `chromium.connect`; `saveAs()` and `createReadStream()` transfer the
artifact. A headless browser may not identify one focused tab, so explicit tab IDs remain
unambiguous. Browser-engine restrictions such as closed shadow roots are not bypassed.

## Scope of the comparison

Codex's available browser-driving surface includes tab/navigation controls, semantic and
frame locators, coordinate and DOM-reference input, files, dialogs, clipboard and console
logs. Its inspected manifest also contains backend-disabled and application-specific
features. Native OS accessibility, application handoff markers, Google document export,
YouTube transcript export, browser selection across unrelated providers, other browser
engines and Playwright Test's runner are not interchangeable with Chromium driving.

This ledger does not claim exhaustive Playwright API equivalence while the provider
incompatibilities above remain. The relevant public API references are
[Page](https://playwright.dev/docs/api/class-page),
[Locator](https://playwright.dev/docs/api/class-locator),
[BrowserContext](https://playwright.dev/docs/api/class-browsercontext), and
[the documented CDP fidelity boundary](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp).
