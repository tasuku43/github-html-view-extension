# GitHub HTML preview extension

This unpacked Chrome MV3 extension previews HTML documents stored on GitHub. It is the
known-good JavaScript baseline that will be kept as a reference while the maintainable
TypeScript implementation is developed incrementally.

## What it does

- Previews allowlisted `.html`, `.htm`, and `.xhtml` files on GitHub.
- Adds `Preview` beside GitHub's `Code` and `Blame` controls.
- Keeps Code and Blame available when Preview is selected.
- Can run classic inline JavaScript inside an opaque-origin sandbox iframe when enabled.
- Inlines supported relative CSS, JavaScript, images, and other binary resources.
- Uses `?plain=1` for the source view and accepts `#preview` links from the earlier baseline.

Markdown and GitHub hosts other than `github.com` are not supported.

## Load the baseline

1. Open `chrome://extensions` in Chrome.
2. Enable Developer mode.
3. Select **Load unpacked** and choose this directory.
4. Click the extension icon to open the Action Popup.
5. Enable HTML Preview and add an exact `owner/repository` entry.
6. Open an allowlisted HTML file on a GitHub blob page.

Preview is disabled until the master switch is enabled. An empty allowlist enables no
repository. Wildcards such as `owner/*` are rejected. Matching ignores letter case but
requires every other character to match exactly.

## Diagnose a stalled preview

Open the GitHub page's DevTools console and filter for `[html-preview]`. Lifecycle entries
are structured JSON, so the `event`, `phase`, `requestId`, `sessionId`, and `errorCode`
fields can be followed without exposing the HTML source or repository details.

The current state is also available from the page DOM:

```js
document.documentElement.dataset.previewState
document.documentElement.dataset.previewErrorCode
document.documentElement.dataset.previewRequestId
document.documentElement.dataset.previewSessionId
```

The same `data-preview-*` attributes are copied to `#ghpreview-frame` or
`#ghpreview-error` when that surface exists. Useful checkpoints are:

- `waiting-for-sandbox`: the bundled iframe is mounted, but the matching sandbox handshake
  has not completed.
- `rendering`: the parent sent the prepared document; look for `render-started` next.
- `waiting-for-height`: the sandbox finished rendering, but the parent is still waiting for
  a usable height notification.
- `failed`: inspect `data-preview-error-code` and the matching `preview-failed` entry.

`Recheck` clears the in-memory response cache and starts a fresh Worker request.

Browser E2E uses the `[html-preview]` console stream as its primary evidence. It follows the
transition facts (`native-navigation-started`, `view-transition-host-settled`,
`preview-transition-committed`, and `view-selection-applied`) instead of treating a post-load
selected-tab class or a screenshot as a contract. A lightweight animation-frame trace is used
only for the narrow no-intermediate-tab assertion; the extension keeps one GitHub-owned view
switch and does not paint a cloned overlay during navigation.

## Security notes

Adding a repository allows JavaScript from its HTML files to run when previewed. The code
runs in the extension's opaque-origin sandbox and cannot access the GitHub page DOM,
cookies, or extension APIs. Keep the allowlist narrow and intentional.

The iframe entry point is the extension-bundled `sandbox.html`; do not replace it with
`about:blank`, `srcdoc`, or dynamically injected scripts without a separate security and
handshake review.

## Baseline limitations

- Module scripts, dynamic imports, page-origin `fetch`, and root-absolute paths are not
  supported.
- `@import` and resources nested beyond the supported inlining pass are left unresolved.
- A file or resource larger than the worker's 8 MB limit is rejected.
- Pull-request file views and GitHub Enterprise hosts are outside the baseline.

For the detailed behavior contract, read `SPEC.md`. For selector evidence, read
`DOM-HOOKS.md`. For the architecture rationale, read `MODEL.md`.
