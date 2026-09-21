# Runtime boundary notes

The repository root's `docs/specification.md` is the product contract. This file records
the current runtime boundaries that implement that contract; it is not a second product
specification.

## Trust and execution

The user explicitly trusts repositories either from the Preview surface or in the Action
Popup. The Popup remains the review and removal surface. GitHub remains responsible for
deciding whether the current viewer can read a file. The extension does not store credentials
or reimplement GitHub authorization.

Preview HTML runs in an opaque-origin sandbox rather than on `github.com`. This prevents the
rendered document from accessing the GitHub DOM, cookies, or extension APIs. The iframe keeps
`allow-scripts` for the bundled bootstrap and never receives `allow-same-origin`.

## Sandbox entry point and protocol

The manifest declares the extension-bundled `sandbox.html` page. The content script mounts
that page with a `session` query parameter and sends the already validated document through
`postMessage`. It never uses `about:blank`, `srcdoc`, dynamically injected bootstrap markup,
or dynamic script injection.

The parent and sandbox validate:

- the expected message source;
- the expected parent or opaque origin;
- protocol version `1`;
- the matching session ID.

The sandbox reports bootstrap, ready, render-started, render-ready, runtime-error, and
render-failed milestones. The parent reports frame creation, frame load, message rejection,
height receipt, and lifecycle state changes through the structured diagnostics contract.

## Fetch boundary and HTML policy

The service worker is the only network fetch boundary. It derives the GitHub raw file URL
from the sender's current page, rechecks the global setting and exact repository allowlist,
and returns a typed success or failure code. The content script never fetches arbitrary URLs
directly.

The fetched source is validated before it reaches the sandbox. Repository-relative stylesheets,
images, fonts, CSS `url(...)` references, CSS imports, and classic scripts are resolved by the
content script through Worker responses and rewritten into the document. External and
root-relative resources, module scripts, embedded frames, network APIs, unsafe navigation
schemes, and unsafe data URLs are rejected. Safe passive media data URLs and same-document
fragment links are allowed. Resolution is bounded and a required dependency failure rejects
the complete document; no misleading partial render is allowed.

When JavaScript is disabled, repository scripts and inline event handlers are removed before
rendering. When it is enabled, only inline or resolved repository-relative classic scripts are
allowed. Forms remain visible
and editable, but the sandbox policy does not grant form submission or popup creation.

## Module responsibilities

| Module | Responsibility |
| --- | --- |
| `src/lib/protocol.js` | Version and validate parent/sandbox messages. |
| `src/lib/blob-url.js` | Parse GitHub file URLs and build view/raw URLs. |
| `src/lib/view-transition.js` | Describe supported Blob, Blame, Code, and Preview states. |
| `src/lib/view-coordinator.js` | Coordinate user intent with GitHub's native view replacement. |
| `src/lib/preview-session.js` | Own request/session identity, lifecycle phase, and stale invalidation. |
| `src/lib/settings.js` | Normalize settings shared by Popup, content script, and Worker. |
| `src/lib/inline.js` | Validate the HTML policy and resolve supported repository dependencies. |
| `src/github/dom.js` | Insert controls, mount the sandbox frame, render failure/warning surfaces, and resize it. |
| `src/preview.js` | Coordinate settings, navigation, fetches, lifecycle, and sandbox handoff. |
| `src/worker.js` | Validate trust/fetch requests, persist exact trust, and fetch GitHub content. |
| `sandbox.html` / `sandbox.js` | Provide the isolated render surface and versioned handshake. |
| `popup.html` / `popup.js` | Edit settings and review or remove exact trusted repositories. |

## Navigation and lifecycle

GitHub uses SPA-style DOM replacement. The content script observes DOM mutations and URL
changes, preserves one native-looking Preview peer, and removes stale surfaces before the
next operation. An untrusted repository uses a dedicated `trust-required` Preview surface;
no source fetch or sandbox frame starts until the user explicitly approves the exact current
repository. The lifecycle state is projected onto the page root and active Preview surface
through `data-preview-*` attributes. Runtime warnings preserve the frame and its `ready`
state; fetch, policy, communication, render, and height failures use the designed failure
surface.
