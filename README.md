# GitHub HTML Preview

This repository starts from a known-good unpacked Chrome MV3 extension in `dist/`. The
directory was originally supplied as the working `ghpreview` baseline; the product name is
still provisional and will be decided separately.

The first milestone is deliberately small: keep the working baseline loadable and
reproducible before replacing any part of it. Stronger observability, the final settings
experience, and any future source/build tooling will be introduced incrementally with a
working browser checkpoint after each change.

## Baseline behavior

- Preview allowlisted `.html`, `.htm`, and `.xhtml` files on GitHub blob pages.
- Keep `Preview`, `Code`, and `Blame` available as a single native-looking switch.
- Use an extension-bundled `sandbox.html` iframe with an opaque origin.
- Keep repository JavaScript away from the GitHub page origin.
- Store only explicit, case-insensitive `owner/repository` allowlist entries.

Markdown, GitHub Enterprise hosts, pull-request file views, and module scripts are outside
this baseline.

## Verify the baseline

From the repository root:

```sh
npm test
```

To load it in Chrome:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select the repository's `dist/` directory.
5. Open the extension options and add an exact `owner/repository` entry.

The baseline documentation and tests live under `dist/`. The extension uses
`dist/sandbox.html` as its iframe entry point; do not change that startup path while using
the baseline as the reference implementation.

## Product direction

The long-term contract is documented in [docs/specification.md](docs/specification.md).
That document is the destination, not a request to rewrite the working baseline in one
step. Future work should make one small change, run the tests, reload `dist/` in Chrome,
and verify the relevant GitHub behavior before continuing.

The implementation order is tracked in [docs/backlog/README.md](docs/backlog/README.md).
