# GitHub HTML Preview

This repository contains a Chrome MV3 extension that previews explicitly trusted, self-contained
HTML files on GitHub. The product contract is [docs/specification.md](docs/specification.md).
The product name is provisional and is intentionally not fixed here.

## Current runtime

The checked-in [`dist/`](dist/) directory is the runtime source of truth for the unpacked
extension. It integrates Preview with GitHub's existing Code / Blame control, renders the
validated document in the bundled opaque-origin sandbox, and keeps the GitHub page and
repository HTML in separate execution boundaries.

The supported file extensions are `.html`, `.htm`, and `.xhtml`. Markdown, GitHub
Enterprise, pull-request file views, wildcard allowlists, and repository-side settings are
outside the product scope. Only self-contained HTML is accepted: relative or external
resources are rejected before rendering.

## Verify the repository

From the repository root:

```sh
npm ci
npm run check
```

`npm run check` validates the MV3 manifest and local runtime references, checks JavaScript
syntax, and runs the unit tests. Browser E2E is separate because it requires a real browser
and a public GitHub URL.

To create a Chrome-loadable release archive after the checks pass:

```sh
npm run package
```

The archive is written to `artifacts/extension-<manifest-version>.zip` by default. It
contains the same checked-in `dist/` directory used by **Load unpacked**, with
`manifest.json` at the archive root. The generated `artifacts/` directory is ignored by
Git.

## Load the extension

1. Open `chrome://extensions` in Chrome.
2. Enable Developer mode.
3. Choose **Load unpacked** and select the repository's `dist/` directory.
4. Open the extension icon to show the Action Popup.
5. Enable HTML Preview.
6. Open an HTML file on GitHub and select Preview.
7. Explicitly trust the current exact repository from the Preview surface, or add it in the
   Popup first.

The master switch and every optional capability start disabled. The allowlist starts empty,
matches owner and repository case-insensitively, and does not accept wildcards. Inline trust
is explicit and adds only the exact current repository; the Popup remains the place to review
or remove trusted repositories.

## Diagnose a stalled preview

Open the GitHub page's DevTools console and filter for `[html-preview]`. The runtime emits
structured lifecycle entries with request ID, session ID, phase, and safe error codes. It
does not log source HTML, complete URLs, repository values, credentials, or private context.

The same lifecycle information is available from the page DOM:

```js
document.documentElement.dataset.previewState
document.documentElement.dataset.previewErrorCode
document.documentElement.dataset.previewRequestId
document.documentElement.dataset.previewSessionId
```

The extension-bundled `dist/sandbox.html` is the iframe entry point. `Recheck` clears the
in-memory response for the current file and starts a fresh Worker request.

## Project guidance

The implementation order is tracked in [docs/backlog/README.md](docs/backlog/README.md).
Make one focused change at a time, run the relevant checks, reload `dist/` in Chrome, and
verify the matching GitHub behavior before continuing. Do not change the canonical
specification merely to preserve stale implementation behavior.
