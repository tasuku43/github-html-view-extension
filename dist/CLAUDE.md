# Runtime maintenance notes

The product contract is the repository root's `docs/specification.md`. Keep this checked-in
JavaScript runtime aligned with that document and make each behavior change browser
verifiable.

## Product

The extension previews explicitly trusted `.html`, `.htm`, and `.xhtml` files on GitHub Blob
and Blame views. It adds `Preview` beside GitHub's `Code` and `Blame` controls and keeps all
three available. Markdown is outside this extension's scope.

Settings are disabled by default. The allowlist contains exact `owner/repository` entries;
wildcards are rejected and matching is case-insensitive. When Preview is enabled, an
untrusted repository shows an explicit trust action in the Preview surface; the Popup can
still review or remove trusted entries. Relative and external resources are policy
violations, not resources to inline.

## Security boundaries

- Never add `allow-same-origin` to the sandbox iframe or sandbox page.
- Keep repository JavaScript inside the extension-bundled `sandbox.html` entry point.
- Validate message source, expected origin, protocol version, and session ID.
- Keep the Worker as the only network fetch path and recheck the exact allowlist.
- Do not store GitHub tokens, cookies, sessions, telemetry, or source cache data.
- Do not use `about:blank`, `srcdoc`, or dynamic bootstrap injection.

## Module boundaries

- `src/github/dom.js` is the only module that touches the GitHub page DOM.
- `src/lib/` contains pure URL, protocol, settings/allowlist, and HTML-policy logic.
- `src/worker.js` is the only outbound fetch path.
- `src/preview.js` coordinates navigation, lifecycle state, fetching, and sandbox handoff.
- `sandbox.html` and `sandbox.js` are the isolated execution surface.
- `popup.html`, `popup.css`, and `popup.js` are the Action Popup settings surface.

## Tests

Run `npm test` from the repository root. The release gate is `npm run check`; browser
acceptance is kept separate as `npm run e2e` and `npm run e2e:fixtures`.

When changing behavior, update the canonical specification only when the product decision
itself changes. Otherwise update the relevant implementation notes and tests in the same
change. Keep new or changed comments, documentation, test names, and UI copy in English.
