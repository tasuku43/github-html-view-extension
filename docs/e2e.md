# Browser E2E smoke test

The repository includes a Playwright-based browser smoke test for the unpacked MV3
extension. It launches an isolated persistent browser context, loads `dist/` as an
extension, configures the target repository in the extension service worker, and checks the
real GitHub page.

The fixture matrix uses the current repository's `origin` remote and the `main` ref by
default. Do not commit a repository URL, account name, or other private browsing context to
the repository.

Playwright is a development dependency. Install its browser once when the local cache does
not already contain Chromium:

```sh
npx playwright install chromium
```

## Run against a ready fixture

Use the repository's canonical self-contained fixture. After pushing the repository, replace
the owner and repository placeholders with the public GitHub URL:

```text
https://github.com/owner/repository/blob/main/docs/sample/index.html
```

```sh
GHPREVIEW_E2E_URL="https://github.com/owner/repository/blob/main/path/to/fixture.html" \
GHPREVIEW_E2E_EXPECT_STATE=ready \
npm run e2e
```

The runner opens the Action Popup in a temporary browser profile, verifies the disabled
first-run state, enables Preview, and then checks the real GitHub page. The normal smoke
path adds the exact `owner/repository` entry from the Popup. The trust-flow path starts with
an empty allowlist and approves the current repository from the Preview surface itself.

```text
Preview -> Code
Code -> Blame
Blame -> Preview
Blame -> Code
```

To verify first-time trust, decline, already-trusted Preview, removal, re-trust, and duplicate
prevention in one isolated browser profile:

```sh
GHPREVIEW_E2E_URL="https://github.com/owner/repository/blob/main/path/to/fixture.html" \
GHPREVIEW_E2E_TRUST_FLOW=1 \
npm run e2e
```

An optional second public HTML Blob or Blame URL verifies that trust does not follow navigation
to another repository. It is supplied at runtime and is never committed:

```sh
GHPREVIEW_E2E_URL="https://github.com/owner/repository/blob/main/path/to/fixture.html" \
GHPREVIEW_E2E_TRUST_FLOW=1 \
GHPREVIEW_E2E_SECOND_URL="https://github.com/another-owner/another-repository/blob/main/path/to/fixture.html" \
npm run e2e
```

For a page that is expected to be rejected by the HTML policy, assert the failure instead:

```sh
GHPREVIEW_E2E_URL="https://github.com/owner/repository/blob/main/path/to/invalid.html" \
GHPREVIEW_E2E_EXPECT_STATE=failed \
GHPREVIEW_E2E_EXPECT_ERROR_CODE=html-policy-violation \
npm run e2e
```

To run the valid fixture, the direct Code- and Blame-start regressions, all policy fixtures,
the runtime-error fixture, and the missing-file regression as one matrix against this repository:

```sh
npm run e2e:fixtures
```

Set `GHPREVIEW_E2E_HEADLESS=1` when running in a headless-capable browser. The optional
`GHPREVIEW_E2E_FIXTURE_ROOT` override is reserved for validating another public fixture copy;
normal project verification should use the current repository automatically.

To reproduce the source-view entry point exactly, keep `?plain=1` instead of letting the
default contract start in Preview:

```sh
GHPREVIEW_E2E_URL="https://github.com/owner/repository/blob/main/path/to/fixture.html?plain=1" \
GHPREVIEW_E2E_PRESERVE_TARGET_VIEW=1 \
npm run e2e
```

This scenario verifies that the initial committed selection remains `Code` and that a direct
`Code -> Blame` interaction has exactly the committed selection sequence `Code -> Blame`.
Transient DOM snapshots with no selected item are ignored while GitHub replaces its view, but
an actual return to Code or Preview fails the test.

For a direct Blame-start regression, use a `/blame/` URL and set the expected initial view:

```sh
GHPREVIEW_E2E_URL="https://github.com/owner/repository/blame/main/path/to/fixture.html" \
GHPREVIEW_E2E_PRESERVE_TARGET_VIEW=1 \
GHPREVIEW_E2E_EXPECT_INITIAL_VIEW=blame \
npm run e2e
```

Both direct-start scenarios record the file-view control from `document-start` and require
Preview never to become the committed selection before the requested native view.

To verify that a GitHub 404 page does not receive a Preview control, use a deliberately
missing HTML path in the same repository:

```sh
GHPREVIEW_E2E_URL="https://github.com/owner/repository/blob/main/docs/sample/missing-file.html" \
GHPREVIEW_E2E_EXPECT_NO_PREVIEW=1 \
npm run e2e
```

## What the runner verifies

- the repository is enabled in the extension storage context;
- a terminal Preview state is reached (`ready`, `failed`, `disabled`, or `trust-required`);
- an untrusted repository reaches `trust-required` without a fetch or sandbox frame, and an
  explicit trust action continues into `ready`;
- declining trust leaves the Popup allowlist empty; removing trust returns the current page to
  `trust-required`; repeated trust and Preview selection keep exactly one entry and one control;
- when `GHPREVIEW_E2E_SECOND_URL` is provided, navigation to that repository gets its own trust
  decision and returning to the original repository restores its existing trust;
- `data-preview-state`, `data-preview-error-code`, `data-preview-request-id`, and
  `data-preview-session-id` are observable;
- the valid fixture reaches a long Preview surface without an unexpected inner scrollbar;
- the runtime-error fixture reaches `ready` with a non-destructive
  `sandbox-runtime-error` warning when inline JavaScript is enabled;
- Preview remains present while Code and Blame are selected;
- Blame -> Code ends at the Blob source URL with `?plain=1`;
- Blame -> Code keeps the GitHub `Files` tree present through the transition;
- the extension's Preview control remains available exactly once after GitHub SPA navigation;
- a GitHub missing-file response does not receive a Preview control.

The same run verifies the Popup-to-storage contract before opening GitHub, including invalid
repository feedback, duplicate rejection, removal, the master-switch-off state, and re-enable.
A Popup regression is visible rather than being hidden by direct storage setup.

## What counts as evidence

Navigation checks use the extension's structured diagnostics as the primary oracle. The runner
captures `[html-preview]` console entries and verifies the lifecycle facts for each transition:

```text
native-navigation-started   # when the host route changes
view-transition-host-settled   # when a native Code/Blame transition is stable
preview-transition-committed   # when Preview is projected before transient native Code
view-selection-applied
```

The `Blame -> Preview` path intentionally uses `preview-transition-committed` instead of
waiting for GitHub's transient native Code selection. This keeps that intermediate Code
selection out of the committed sequence. `Blame -> Code` delegates the route change to
GitHub's native SPA handler so the repository shell and file tree remain mounted. Once the
host reaches the Blob view, the extension canonicalizes the destination to `?plain=1` with
`history.replaceState` rather than starting a second document navigation.

The runner also checks the destination URL and the `data-preview-*` lifecycle metadata. It does
not use a screenshot or a post-load CSS class as proof that a transition succeeded. It does
sample the selected view at animation-frame boundaries during the transition specifically to
catch a visibly committed intermediate tab; this is a narrow flicker assertion, not the main
Preview lifecycle oracle. Mutation-level selection history is retained as diagnostic output.

For a browser-specific transition issue, the structured diagnostics include `view-intent`,
`view-transition-observed`, and `view-selection-applied`. Their details contain only the
requested view and the native Code/Blame selection state; they do not include source HTML,
repository URLs, or credentials.

The extension keeps one GitHub-owned view switch in the document. It does not clone or
overlay the switch during navigation; the host-selected item is observed first, then
Preview is reconciled as a peer item.

To inspect the optional detailed visual trace while diagnosing a browser-specific flicker, set:

```sh
GHPREVIEW_E2E_TRACE_TRANSITIONS=1 \
GHPREVIEW_E2E_HEADLESS=1 \
GHPREVIEW_E2E_URL="https://github.com/owner/repository/blob/main/path/to/fixture.html" \
npm run e2e
```

The trace is supplementary and does not replace the structured diagnostic assertions.

The default run keeps the browser visible because extension loading is more reliable in a
persistent headed context. Set `GHPREVIEW_E2E_HEADLESS=1` only when the selected browser
supports extension loading in headless mode. Set `GHPREVIEW_E2E_NAVIGATION=0` to inspect
only the initial terminal state. Set `GHPREVIEW_E2E_EXPECT_NO_PREVIEW=1` for the missing-file
regression check. Set `GHPREVIEW_E2E_TRACE_STARTUP=1` to print the compact document-start
selection trace. Set `GHPREVIEW_E2E_BROWSER_PATH` or `CHROME_PATH` when a specific browser
executable is required.
