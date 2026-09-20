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
`postMessage`. The sandbox announces `ghpreview:sandbox-bootstrap` and
`ghpreview:sandbox-ready` before it accepts one render message. After iframe load, the
parent can send `ghpreview:sandbox-ping` to request another ready signal. The sandbox then
opens the document with `document.open()`, `document.write()`, and `document.close()` so
classic inline scripts execute.

The parent removes any unexpected `srcdoc` attribute before using the frame. `srcdoc` takes
precedence over `src`, so leaving an empty attribute in place would load `about:srcdoc`
instead of the bundled sandbox page.

The parent validates `event.source === frame.contentWindow`. The sandbox validates both
`event.source === window.parent` and `event.origin === 'https://github.com'`. The sandbox
origin itself is opaque, so its origin string is not used as proof of identity.

Each preview request has a generated request ID and each sandbox mount has a generated
session ID. The IDs are attached to the Preview surface as `data-preview-request-id` and
`data-preview-session-id`, and to lifecycle logs. They are correlation identifiers only;
they never contain a URL, repository name, document text, or credential.

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
simple. Lifecycle state is exposed through `data-preview-state` on the active Preview
surface (and on the page root during transitions). The state values include `idle`,
`detecting`, `checking-settings`, `fetching`, `validating`, `mounting`,
`waiting-for-sandbox`, `rendering`, `waiting-for-height`, `ready`, `disabled`, `failed`,
and `stale`.
