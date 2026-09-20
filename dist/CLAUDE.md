# Baseline maintenance notes

This directory is the known-good JavaScript baseline for the extension. It is kept
behaviorally stable while a later TypeScript implementation is built beside it.

## Product

The extension previews allowlisted `.html`, `.htm`, and `.xhtml` files on GitHub. It
adds `Preview` beside `Code` and `Blame`, keeps those native controls available, and
uses `?plain=1` for the source view. Markdown is outside this extension's scope.

The allowlist is explicit `owner/repository` entries. Wildcards are rejected and matching
is case-insensitive. An empty allowlist enables nothing.

## Security boundaries

- Never add `allow-same-origin` to the sandbox iframe or sandbox page.
- Keep repository JavaScript inside the extension-bundled `sandbox.html` entry point.
- Validate both `event.source` and the expected parent origin for postMessage traffic.
- Keep all extension fetches restricted to `github.com`.
- Do not store GitHub tokens, cookies, or sessions in extension storage.
- Do not treat the Code/Preview switch as a security boundary; the allowlist and opaque
  sandbox origin provide that boundary.

## Module boundaries

- `src/github/dom.js` is the only module that touches GitHub page DOM.
- `src/lib/` contains pure URL, allowlist, and resource-classification logic.
- `src/worker.js` is the only outbound fetch path.
- `src/preview.js` coordinates GitHub navigation, fetching, inlining, and sandbox handoff.
- `sandbox.html` and `sandbox.js` are the isolated execution surface.
- `options.html` and `options.js` are the baseline settings surface.

## Tests

Run `npm test` from this directory. The tests cover the pure modules without adding a
runtime dependency or a bundler. DOM-heavy behavior remains a browser verification task.

When changing behavior, update `SPEC.md` and the relevant tests in the same change. Keep
new or changed comments, documentation, test names, and UI copy in English.

## Known verification gaps

The live GitHub DOM selectors and authenticated `/raw/` behavior still require browser
verification after loading this directory through `chrome://extensions`.
