# HTML Preview extension runtime

This directory is the checked-in Chrome MV3 runtime. Load this directory directly as an
unpacked extension while developing and testing the product described in the repository
root's [product specification](../docs/specification.md).

## Supported behavior

- Preview explicitly trusted `.html`, `.htm`, and `.xhtml` files on GitHub Blob and Blame pages.
- Keep `Preview`, `Code`, and `Blame` available in GitHub's existing file-view control.
- Render only self-contained HTML in the extension-bundled `sandbox.html` page.
- Run inline classic JavaScript only when the Popup capability is enabled.
- Keep forms visible and editable while native submission and popup creation remain disabled.
- Show designed English failure surfaces without exposing source HTML or private context.

Markdown, SVG, notebooks, pull-request file views, GitHub Enterprise, wildcard allowlists,
and repository-side configuration are outside the product scope.

## Load the extension

1. Open `chrome://extensions` in Chrome.
2. Enable Developer mode.
3. Select **Load unpacked** and choose this directory.
4. Open the Action Popup from the extension icon.
5. Enable HTML Preview.
6. Open an HTML file on GitHub and select Preview.
7. Trust the exact current repository from the Preview surface, or add it in the Popup first.

Preview is disabled until the master switch is enabled. An empty allowlist shows an explicit
trust decision when Preview is selected; it does not fetch or render until the user trusts
the exact current repository. Wildcards such as `owner/*` are rejected. Matching ignores
letter case while requiring every other character to match exactly.

## Diagnose a stalled preview

Open the GitHub page's DevTools console and filter for `[html-preview]`. Structured entries
include the event, phase, request ID, session ID, and safe error code without exposing source
HTML, complete URLs, repository values, or credentials.

The current state is also available from the page DOM:

```js
document.documentElement.dataset.previewState
document.documentElement.dataset.previewErrorCode
document.documentElement.dataset.previewRequestId
document.documentElement.dataset.previewSessionId
```

The same `data-preview-*` attributes are copied to the iframe, failure surface, or runtime
warning when that surface exists. Useful checkpoints are:

- `waiting-for-sandbox`: the bundled iframe is mounted, but the matching sandbox handshake
  has not completed.
- `trust-required`: Preview is enabled for the extension, but the exact current repository
  has not been trusted. No source fetch or sandbox frame should exist in this state.
- `rendering`: the parent sent the prepared document; look for `render-started` next.
- `waiting-for-height`: rendering completed, but the parent is still waiting for a usable
  height notification.
- `ready` with `data-preview-error-code="sandbox-runtime-error"`: the document rendered,
  but its runtime warning is visible without removing the document.
- `failed`: inspect the error code and the matching `preview-failed` entry.

`Recheck` clears the in-memory response cache and starts a fresh Worker request.

## Security boundary

Repository HTML is rendered only in the opaque-origin sandbox iframe. The iframe entry is
the extension-bundled `sandbox.html` page with a session query parameter; it is not
`about:blank`, `srcdoc`, or a content-script-generated bootstrap. The iframe never receives
`allow-same-origin`.

The HTML policy rejects relative and external resources, module scripts, embedded frames,
network APIs, unsafe navigation schemes, and other active network paths before rendering.
Only safe passive `data:` media is accepted. The Worker rechecks the exact repository
allowlist before every fetch.
