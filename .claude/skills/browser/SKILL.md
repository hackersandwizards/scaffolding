---
name: browser
description: >-
  Which browser tool does each verb (open a signed-in tab, navigate, run JavaScript in the page,
  read, click or type, wait, close) on each surface: Claude Desktop's in-app browser, T3's server
  browser, the chrome-devtools MCP; how the person signs in on each, and each surface's measured
  quirks. Load before a site skill's first browser call and for any rendered-page, frontend or
  signed-in UI check ("open a tab", "in-app browser", "server browser", "preview_open",
  "chrome devtools", "is it signed in").
---

# Browser

## Which surface this session is on

Read it off the tools the session has. Search deferred tools (`ToolSearch` or equivalent) before
calling a set absent.

| Tools present             | Surface                                                                    | Logins                                        |
| ------------------------- | -------------------------------------------------------------------------- | --------------------------------------------- |
| `mcp__Claude_Browser__*`  | Claude Desktop's in-app browser                                            | the person's, in Desktop's browser profile    |
| `mcp__t3-code__preview_*` | T3's server browser: headless Chrome on the machine the T3 service runs on | the person's, in the server browser's profile |
| `mcp__chrome-devtools__*` | a Chrome the MCP starts with its own fresh profile                         | none                                          |

A terminal Claude session has neither signed-in surface. A page behind a login goes to a signed-in
surface only. Where the session has none, or the site answers with its sign-in page, report the
site as unavailable and stop. A page without a login (a dev server, a public page) goes to the
first of these that works: chrome-devtools, the repository's own automation (such as Playwright).
It goes to a signed-in surface only where the request asks for browser work.

Never enter a password and never sign in: the person signs in.

- **Claude Desktop:** the person signs in in Desktop's Browser pane.
- **T3:** an agent opens the site with `preview_open`, and the person takes control of that tab in
  T3 and signs in there. Later threads of the same T3 service get that login. A login in the T3
  app's own browser panel lands in the desktop app's profile, never the server browser's.

A job that needs a displayed pane, such as a native macOS file panel, is a Claude Desktop job: T3's
browser is headless.

## The verbs

| Verb                            | Claude Desktop (`mcp__Claude_Browser__`)                                | T3 (`mcp__t3-code__`)                                                                                   | chrome-devtools (`mcp__chrome-devtools__`)            |
| ------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Open a tab                      | `preview_start {url}`, or `tabs_create`; `tabs_context` lists open tabs | `preview_status` first, then `preview_open {url}`; `t3_preview_list` lists tabs                         | `new_page`; `list_pages`                              |
| Navigate                        | `navigate`                                                              | `preview_navigate`                                                                                      | `navigate_page`                                       |
| Run JavaScript in the page      | `javascript_tool`                                                       | `preview_evaluate`, returns `{value}` up to 64 KB                                                       | `evaluate_script`                                     |
| Read text                       | `get_page_text`                                                         | `preview_snapshot` (visible text cut at 2,000 characters in one measured read), else `preview_evaluate` | `evaluate_script`                                     |
| Read the accessibility tree     | `read_page`, `find`                                                     | `preview_snapshot`                                                                                      | `take_snapshot`                                       |
| Screenshot                      | `computer` `screenshot`                                                 | `preview_snapshot` with `save=true`                                                                     | `take_screenshot`                                     |
| Click, type, hover, select, key | `computer`, by screenshot coordinate                                    | `preview_act`, by `locator='aria-ref=<ref>'` from `preview_snapshot`                                    | `click`, `fill`, `hover`, `press_key` by snapshot uid |
| Wait                            | `computer` `action: "wait"`                                             | `preview_wait_for` (locator, selector, text, URL)                                                       | `wait_for`                                            |
| Resize                          | `resize_window`                                                         | `preview_resize`                                                                                        | `resize_page`                                         |
| Network log                     | `read_network_requests`                                                 | none                                                                                                    | `list_network_requests`                               |
| Close                           | `tabs_close`                                                            | `t3_preview_close`; every tab also closes when its thread ends                                          | `close_page`                                          |

A site skill's `allowed-tools` lists the tools of both signed-in surfaces, and its steps name the
verb. Where a site skill names a tool of one surface, use that verb's row for the other.

## Claude Desktop in-app browser

- **An element `ref` does not survive the session**: never store one. A `ref` on `computer`
  `left_click` resolves to a stale coordinate: take click coordinates from a screenshot.
  `hover` by `ref` is reliable: it scrolls the target into view, lands on its centre and reports
  that landing in CSS pixels, 1.6x the tool coordinate for the same point. Re-read any rect taken
  before it.
- **`preview_start {url}` returns tab `seed` carrying whatever session the profile holds**; no
  preview open is no evidence the site is unavailable. A `preview_start` timeout is no evidence
  that no tab exists: read `tabs_context`.
- **The permission classifier refuses single calls**, usually transiently: a `fetch`, a
  `navigate`, `preview_start` itself (7 of 92 `preview_start` calls on one site's page, under a
  different stated reason each time), a `computer` `type` or a `javascript_tool` call ("Blocked
  by classifier"). Re-issue once, then try an explicit `navigate`, before writing the run off.
  After a blocked read-back of typed text, retry the read: never act on the typed-character count.
  Re-test a refusal or a browser that will not open in your own run before recording either.
- **`javascript_tool` dies at 30 seconds.** Keep an accumulator on `window` and page work into
  calls well under that, so a refusal or a timeout costs one call.
- **A result above the inline limit is saved to a file** under the session's `tool-results/`
  directory and the tool answers with its path. Read it with `jq -r '.[0].text'`, drop the
  trailing `(captured at origin ...)` line, and parse the rest.
- **AdGuard filters this browser.** Its cosmetic rules reach no stylesheet the page can list, so a
  control that exists but computes `display: none` with no inline style is a cosmetic rule until
  shown otherwise. Stop and report the element, the matching rule and the `<site>#@#<selector>`
  exception that would restore it. Never change AdGuard's rules.
- **`tabs_context` ends with `The Browser pane is currently displayed` or `hidden`.** While it
  is hidden, `document.visibilityState` reads `hidden`, rAF is throttled and no list auto-loads
  on scroll from JS. A `computer` call repaints the pane and pulls the next rows in; a `wait` or a
  `hover` does not. The same holds for whatever a click builds: a dropdown's or a dialog's contents
  are not queryable until a `computer` screenshot has repainted the pane. Click, screenshot, then
  read. Neither `tabs_select` nor `preview_start` brings a hidden pane up: a person shows it.
- **`computer` `scroll` times out after 30 s** with "The Browser pane is currently hidden" and
  leaves the page where it was. Scroll in JS, 1500 px a step, wait 2 s, take a `computer`
  screenshot, and repeat until `scrollHeight` stops growing.
- **`navigate` can set the URL without waking a single-page app**: `location.href` reads back
  correct while the page stays as it was. `location.replace(<the URL>)` from inside the page, then
  a `wait` and a `computer` screenshot, renders it.
- **`computer` `zoom` ignores its `region`** and returns the whole frame. Re-screenshot at a
  larger `scale` instead.
- **A `navigate` clears the cached screenshot frame**, so the next `hover` or `left_click` by
  coordinate fails with "requires a prior computer{action:\"screenshot\"}", and a `browser_batch`
  drops its remaining steps. Take one `screenshot` after every navigation before any pointer call.
- **A gating read and the write it authorizes go in separate calls, with the write second.** A
  `browser_batch` stops on an error and not on a `null` or an empty result. An expansion and the
  query that reads it back split the same way.
- **A `hover` on the coordinate the pointer already occupies fires nothing.** Hover somewhere
  neutral first. `hover` the target and re-screenshot to check the aim.

### Geometry

- **An unsized pane, and any frame after a `navigate`, can answer `innerWidth` 0**, with
  `innerHeight` and `scrollHeight` 0 too and every rect stale: most read zero, some plausible and
  wrong. Element lists still come back correctly. Test `window.innerWidth`, never the rect.
  Re-running the JS does not clear it; one `resize_window` with an explicit width and height does:
  resize, confirm `innerWidth` is non-zero, then measure, and reset with preset `desktop`
  afterwards.
- **Scale x and y separately, off the frame each screenshot reports**: x by
  `frame_width / innerWidth`, y by `frame_height / innerHeight`. At 1280 wide x read `0.625`
  while y read both `0.6324` and `0.625`; scaling y by `0.625` instead of `0.6324` lands
  `0.0117 * css_y` short.
- Where a page is whole in the DOM, size the viewport to its own `scrollHeight` and read every
  rect at `scrollTop` 0.
- **Where a click misses**, arm a one-shot capture-phase `click` listener reading
  `e.clientX/clientY` that calls `preventDefault`, click once, compare against
  `getBoundingClientRect()`, and correct the coordinate. `elementFromPoint` cannot stand in for
  it: it divides the tool coordinate by the same factor that produced it.
- **The whole frame can go stale**, which looks like a control that will not respond: the listener
  puts the pointer at a uniform multiple of the intended point on both axes (10.4x measured), with
  `innerWidth`, `innerHeight` and `zoom` all reading normal. Call `preview_start` again on the
  same tab, which restores the factor.
- **The rendered image can be stale while the coordinates are not**: after two `resize_window`
  calls in a row the frame came back blank, or showed the page twice at a vertical offset, while
  the listener put the pointer on target. Fire the listener before reaching for `preview_start`;
  where it lands on target, click and trust the DOM read. Pick a viewport before the writes and
  leave it.

## T3 server browser

Measured so far: signed-in reads from a Claude Haiku thread and a Codex Sol thread on the default profile.

- Call `preview_status` first: it lists this thread's tabs, a pending dialog (answer it with
  `preview_dialog`), who controls each tab, and the profiles `default` and `incognito`. The person's
  logins sit in `default`; the status shows no login state, so only the site's page shows whether
  it is signed in. Act only on your own tab or
  an unclaimed one no person controls; read a tab a person drives with `preview_snapshot` only.
- `preview_open` reuses the thread's current tab. Parallel subagents of one session each pass
  `reuseExistingTab=false` and then their own returned `tabId` on every call.
- An `aria-ref` dies on navigation, on a new snapshot and on a handoff: take a fresh
  `preview_snapshot` before each `preview_act`.
- A `preview_evaluate` result over 64 KB does not come back: keep the value on `window` and read
  it in slices.
- At most 8 tabs per agent session and 32 per server: close your own with `t3_preview_close`.
