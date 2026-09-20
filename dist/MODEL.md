# Baseline architecture model

This file explains why the working baseline is arranged as it is. `README.md` describes
usage, `GOAL.md` defines scope, and `SPEC.md` contains the fuller product direction.

## Trust and execution

The extension trusts only repositories that the user explicitly adds to the allowlist.
GitHub remains responsible for determining whether the current viewer can read a file;
the extension does not store credentials or reimplement authorization.

Preview code runs in an opaque-origin sandbox rather than on `github.com`. This prevents
repository HTML from accessing the GitHub DOM, cookies, or extension APIs. `allow-same-
origin` is intentionally absent from both the iframe and the sandbox policy.

## Sandbox entry point

`manifest.json` lists `sandbox.html` in the MV3 sandbox section. The content script mounts
that extension-owned page as the iframe entry point and sends the prepared HTML through
`postMessage`. The sandbox sends `ghpreview:sandbox-ready` before it accepts one render
message, then opens the document with `document.open()`, `document.write()`, and
`document.close()` so classic inline scripts execute.

The parent validates `event.source === frame.contentWindow`. The sandbox validates both
`event.source === window.parent` and `event.origin === 'https://github.com'`. The sandbox
origin itself is opaque, so its origin string is not used as proof of identity.

## Fetching and inlining

The service worker fetches `https://github.com/{owner}/{repository}/raw/{refAndPath}` with
the viewer's cookies. It is the only outbound fetch path because GitHub's raw response can
redirect to another host and a content-script fetch would be subject to page CORS rules.

The URL parser keeps the portion after `blob/` or `blame/` intact. Branch names can contain
slashes, so splitting ref and path from the URL alone would be guesswork. Relative
resources are resolved against the raw URL and supported resources are folded into the
detached document before it reaches the sandbox.

## Module responsibilities

| Module | Responsibility |
| --- | --- |
| `src/lib/blob-url.js` | Parse GitHub file URLs and build view/raw URLs. |
| `src/lib/allowlist.js` | Parse, validate, and match exact repository entries. |
| `src/lib/inline.js` | Classify references and rewrite CSS/srcset values. |
| `src/github/dom.js` | Insert controls, mount the frame, inline detached HTML, and resize it. |
| `src/preview.js` | Coordinate settings, navigation, fetches, and sandbox handoff. |
| `src/worker.js` | Validate requests and fetch GitHub content. |
| `sandbox.html` / `sandbox.js` | Provide the isolated render surface and handshake. |
| `options.html` / `options.js` | Edit the baseline allowlist. |

## GitHub navigation

GitHub uses SPA-style DOM replacement. The baseline observes DOM mutations and compares the
current URL rather than relying on undocumented transition event names. This is deliberately
simple and is one of the first areas to receive stronger lifecycle observability in the
future implementation.
