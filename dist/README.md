# GitHub HTML preview extension

This unpacked Chrome MV3 extension previews HTML documents stored on GitHub. It is the
known-good JavaScript baseline that will be kept as a reference while the maintainable
TypeScript implementation is developed incrementally.

## What it does

- Previews allowlisted `.html`, `.htm`, and `.xhtml` files on GitHub.
- Adds `Preview` beside GitHub's `Code` and `Blame` controls.
- Keeps Code and Blame available when Preview is selected.
- Runs classic inline JavaScript inside an opaque-origin sandbox iframe.
- Inlines supported relative CSS, JavaScript, images, and other binary resources.
- Uses `?plain=1` for the source view and accepts `#preview` links from the earlier baseline.

Markdown and GitHub hosts other than `github.com` are not supported.

## Load the baseline

1. Open `chrome://extensions` in Chrome.
2. Enable Developer mode.
3. Select **Load unpacked** and choose this directory.
4. Open the extension's options page.
5. Add exact `owner/repository` entries, one per line, and save.
6. Open an allowlisted HTML file on a GitHub blob page.

The empty allowlist enables nothing. Wildcards such as `owner/*` are rejected. Matching
ignores letter case but requires every other character to match exactly.

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
