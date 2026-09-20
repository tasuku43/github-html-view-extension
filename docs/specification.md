# HTML Preview Product Specification

## Document status

This document is the product contract for the HTML Preview extension. It describes the intended end state and the evidence required to reach it safely.

The target architecture is a destination, not a reason to rewrite a working implementation in one step. Every implementation change must preserve the last verified behavior and close one small, observable gap at a time.

The product name is intentionally provisional. No final brand name is part of this specification.

## Technology and maintenance constraints

- The extension is implemented in TypeScript. Runtime code, shared contracts, and tests must not regress to a pure JavaScript structure.
- The extension targets Chrome Manifest V3, including a Service Worker and the declared MV3 sandbox boundary.
- The existing bundling approach remains the source of truth. `dist/` is generated output and is never edited by hand.
- The project does not introduce React or another UI framework merely to build the extension. Production UI uses typed DOM factories and ordinary CSS.
- No new external runtime library is required for the product scope. Existing development dependencies should be reused unless a later decision explicitly justifies an addition.
- The design review surface follows a Storybook-style workflow: each important production state must be inspectable in isolation, using the same production DOM factories and styles. A framework-specific Storybook integration is optional; component reuse and repeatable visual review are mandatory.
- The repository is maintained as a long-lived project. Clear boundaries, small changes, focused tests, and repeatable browser checks take priority over short-term rewrite speed.
- New or changed user-facing copy, tests, comments, and documentation are written in English.
- Product code, UI, fixtures, logs, and documentation must not contain company names, internal URLs, private repository names, personal names, or internal project names.

## Product promise

On GitHub file views, users can preview an allowlisted, self-contained HTML document without losing GitHub's native Code and Blame navigation. The extension must be safe by default, predictable when it refuses a file, and diagnosable when a preview does not complete.

## Scope

### Supported

- GitHub blob and blame file views.
- `.html`, `.htm`, and `.xhtml` files.
- Branch, tag, and commit references in normal GitHub file URLs.
- GitHub's existing `Preview | Code | Blame` control.
- A Chrome Action Popup for global settings and an exact repository allowlist.
- Self-contained HTML rendered inside an extension-bundled MV3 sandbox page.

### Not supported

- Markdown, SVG, notebooks, or other formats already rendered by GitHub.
- Pull-request file-diff views.
- GitHub Enterprise Server.
- Wildcard, path-based, organization-wide, or repository-side configuration.
- GitHub API calls, extension-managed authentication, tokens, telemetry, or persistent source caching.
- A final product name.

## GitHub navigation behavior

The extension must integrate with GitHub's existing file-view control rather than creating a parallel tab bar.

- Add `Preview` beside the existing `Code` and `Blame` controls for supported HTML files.
- Keep `Preview`, `Code`, and `Blame` available regardless of which one is selected.
- Selecting `Preview` renders in the existing file-content area.
- Selecting `Code` or `Blame` must not remove the `Preview` control.
- On a Blame view, keep the Preview affordance visible. Selecting it navigates to the corresponding blob view and starts the preview there.
- GitHub SPA DOM replacement, history changes, and back/forward navigation must be handled without duplicating controls or leaving stale surfaces behind.
- GitHub's line-number and code presentation must not remain behind the preview surface.
- The preview surface must fit the file-content area and provide one intentional scrolling surface.

## Settings contract

Settings are managed from the Chrome Action Popup opened from the extension icon. The current scope does not require a separate options page.

The stored shape is:

```json
{
  "schemaVersion": 1,
  "previewEnabled": false,
  "capabilities": {
    "javascript": false,
    "forms": false,
    "popups": false,
    "modals": false
  },
  "repositories": []
}
```

### Settings behavior

- `previewEnabled` is the global master switch.
- All capabilities are global and independent.
- The initial value of every switch is off.
- The initial allowlist is empty.
- The Popup must make the disabled-by-default behavior obvious.
- Changes save immediately and show a clear saved state or equivalent feedback.
- The Popup must remain usable at a compact Chrome Action Popup size.
- All user-facing text is English.

### Repository allowlist

- Add exact `owner/repository` entries.
- List registered entries.
- Remove entries.
- Reject malformed entries with an actionable English message.
- Reject duplicates clearly and do not create duplicate stored entries.
- Match owner and repository case-insensitively, following GitHub's repository identity behavior.
- Do not accept wildcards or partial matches.
- Preserve a useful display spelling, but use normalized values for matching.
- There is no legacy data-format compatibility requirement because the extension is unreleased.

## HTML policy

Only a self-contained document may be previewed. Validation happens before any source HTML is sent to the sandbox. A rejected document is never partially rendered.

### Allowed

- Inline CSS.
- Inline classic JavaScript when the JavaScript capability is enabled.
- Same-document fragment links.
- Safe passive media encoded as safe `data:` URLs.
- Forms as visible, editable elements.

### Rejected

- Relative resources.
- External resources.
- External scripts.
- Module scripts and dynamic imports.
- `<link>` elements.
- `<iframe>`, `<object>`, and `<embed>`.
- CSS `@import`.
- External CSS `url()` references.
- Meta refresh.
- Network APIs, workers, and other active network paths.
- Dangerous navigation schemes.
- Unsafe data URLs.

When JavaScript is disabled, scripts and inline event handlers are removed before rendering. When it is enabled, only inline classic scripts are permitted by the policy. Runtime errors do not remove an otherwise rendered document; they produce an extension-owned warning.

Forms remain visible in both modes. The Forms capability controls submission. Popups and browser dialogs are independently controlled by their corresponding capabilities.

## Preview surface and error UX

The Preview surface must use the existing GitHub-shaped visual language and avoid a large redesign of the surrounding page.

### Loading

The loading state must communicate that Preview is working and must not look like a broken or empty GitHub file view.

### Success

The ready state shows the rendered document inside the sandbox frame. The frame is sized to its content without allowing the embedded page to escape the preview surface.

### Failure

The Preview control remains selected and available. The error surface must include:

- `Preview unavailable`.
- A short user-facing reason in English.
- A categorized list of detected issues when available.
- `Open Code`.
- `Recheck`.
- A quiet diagnostic code that does not dominate the message.
- `Preview remains active. Code and Blame remain available above.`

The following failure categories must be distinguishable:

- Fetch or Worker failure.
- Repository not allowed.
- HTML policy or validation failure.
- Sandbox communication or startup failure.
- Render failure.
- Height or layout timeout.
- Runtime error after rendering.

`Recheck` must invalidate any in-memory response for the current file and perform a fresh Worker request. It must not depend on a failed response or stale cache entry.

## Preview lifecycle

The content script owns the current operation state. The state is projected onto the Preview surface and must not be inferred only from visible text.

The lifecycle vocabulary is:

```text
idle
detecting
checking-settings
fetching
validating
mounting
waiting-for-sandbox
rendering
waiting-for-height
ready
disabled
failed
stale
```

The Preview surface must expose:

```text
data-preview-state
data-preview-error-code
data-preview-request-id
data-preview-session-id
```

Request IDs identify a Worker request. Session IDs identify one sandbox frame and its parent-child message contract. IDs may be exposed in the DOM, but they must not contain source content or user data.

An operation becomes `stale` when navigation, settings, a newer operation, or a view change makes its result invalid. A stale response must not update the current surface.

The sandbox boundary must make these milestones independently observable:

1. The iframe was created.
2. The bundled sandbox document loaded.
3. The sandbox bootstrap started.
4. The matching session sent `sandbox-ready`.
5. The parent sent the render request.
6. The sandbox started rendering.
7. The sandbox reported render completion.
8. The parent received a height notification.
9. The surface became ready.

Waiting for `sandbox-ready` and waiting for a height notification are different states. A frame load without a matching ready message must identify which startup milestone was last observed.

## Observability contract

Diagnostics use one structured console format:

```text
[html-preview] {
  event,
  phase,
  requestId?,
  sessionId?,
  errorCode?,
  detail?
}
```

Normal lifecycle events use `console.debug`. Failures use `console.warn` or `console.error`.

At minimum, the following events must be available:

```text
page-detected
settings-loaded
preview-disabled
repository-not-allowed
request-started
request-sent
response-received
response-rejected
fetch-failed
validation-started
validation-failed
frame-mounted
sandbox-document-loaded
sandbox-bootstrap
sandbox-ready
sandbox-frame-loaded
render-sent
render-started
render-ready
height-received
runtime-error
stale-operation
preview-failed
preview-destroyed
```

Diagnostics must never include:

- Raw HTML or rendered source.
- Complete GitHub URLs or query parameters.
- Repository names or allowlist values.
- Cookies, tokens, credentials, or exception text that may contain source data.
- Company names, personal names, internal URLs, or internal project names.

URL details may be represented by safe categories such as `html-blob`, `html-blame`, or `unsupported-page`.

Worker error codes and `chrome.runtime.lastError` must remain distinguishable when they cross the content/Worker boundary. Invalid responses must produce a diagnostic failure instead of silently becoming `null`.

## Runtime boundaries

The intended boundary model is:

```text
src/
  core/
    github-url.ts
    protocol.ts
    diagnostics.ts
    settings/
    html/

  content/
    entry.ts
    controller.ts
    github-dom.ts
    preview-session.ts
    sandbox-channel.ts
    worker-client.ts
    ui.css

  worker/
    service-worker.ts

  sandbox/
    bootstrap.ts
    sandbox.html
    sandbox.css
    runtime.ts

  popup/
    popup.ts
    popup-view.ts
    popup.html
    popup.css

  ui/
    file-tabs.ts
    preview-components.ts

  design/
    ui-gallery.ts
    ui-gallery.css
```

This is a separation of responsibility, not a requirement to create every file before the behavior is stable.

### Core

Pure TypeScript contracts and functions: GitHub URL parsing, settings normalization, repository matching, HTML validation, transformation, protocol messages, and safe diagnostics. Core code must not depend on Chrome APIs or GitHub DOM details.

### Content script

The content script owns GitHub DOM integration, navigation observation, the current preview operation, surface state, and user actions. It must not fetch arbitrary URLs directly.

### Service Worker

The Worker is the only network fetch boundary. It derives the raw file URL from the sender's current GitHub page, rechecks the extension settings and exact repository allowlist, and returns typed success or failure codes.

### Sandbox

The iframe entry point is the extension-bundled `sandbox.html` with a session query parameter. It must not be replaced by `about:blank`, `srcdoc`, content-script-generated bootstrap markup, or dynamic script injection. The manifest must declare the sandbox page and the required web-accessible resources.

The iframe uses an opaque origin: `allow-scripts` is required, while `allow-same-origin` is not allowed. `allow-forms`, `allow-popups`, and `allow-modals` are added only when their capabilities are enabled. Parent and child validate message source, origin expectations, protocol version, and session ID.

### Popup and design gallery

The Action Popup is the production settings surface. The design gallery is a local evaluation surface and must reuse production DOM factories where practical. It must not become a second implementation of runtime behavior.

The gallery is the lightweight Storybook-style review loop for this vanilla TypeScript extension. It should show the Popup, file tabs, loading, ready, policy-error, runtime-warning, and communication-failure states with realistic content and controls. It is used before GitHub E2E so visual and interaction regressions are found without a live GitHub page.

## Verification contract

### Fixtures

`docs/sample/index.html` is the deterministic valid acceptance fixture. It must remain self-contained and should exercise realistic layout, scrolling, controls, and an optional runtime-error path without depending on external assets.

`docs/sample/invalid/` contains policy fixtures such as external resources, relative resources, and module scripts. Each fixture must lead to a designed validation error while preserving the Preview, Code, and Blame controls.

### Browser acceptance

The browser check must verify:

- A valid fixture reaches `data-preview-state="ready"`.
- A policy fixture reaches `data-preview-error-code="html-policy-violation"` or its more specific policy code.
- Preview, Code, and Blame remain available through GitHub navigation.
- Blob and Blame flows do not duplicate controls or leave stale frames.
- The preview surface owns the intended scrolling behavior and hides GitHub code-line artifacts behind it.
- A runtime error is associated with the current session and does not discard the document.
- Recheck creates a new request and session and performs a fresh fetch.
- Worker failure, sandbox startup failure, render failure, and height timeout are distinguishable by state, error code, and structured logs.
- Branch, tag, and commit-reference pages follow the same contract.

E2E assertions must prefer `data-preview-state` and `data-preview-error-code` over matching only visible copy. Visible English text is still part of the UX contract.

### Automated checks

The repository gates are:

```text
npm run typecheck
npm test
npm run build
npm run check
```

Tests must cover pure policy and URL behavior, settings and allowlist behavior, protocol validation, state projection, Worker failure propagation, stale operations, sandbox handshake ordering, recheck invalidation, and data-attribute updates.

## Incremental delivery rules

The initial implementation is the behavioral baseline. It is not to be copied blindly, but it is the first known-good reference for GitHub DOM behavior, iframe placement, scrolling, sizing, sandbox communication, and failure cases.

The implementation sequence is:

1. Restore the initial implementation in an isolated branch or worktree and prove the valid fixture works in Chrome.
2. Record baseline behavior for Preview, Code, Blame, SPA navigation, scrolling, sizing, settings, and policy fixtures.
3. Improve one user-visible defect at a time without changing the sandbox startup method and the message contract in the same change.
4. Add thin lifecycle diagnostics and DOM state attributes without changing behavior.
5. Extract or refine one runtime boundary at a time, keeping the baseline browser check green after every step.
6. Improve the Popup and design gallery using the same production behavior and English copy.
7. Add deterministic E2E seams and failure coverage after the real browser path is stable.
8. Only then consolidate architecture and remove obsolete code.

Every iteration must answer four questions:

- What single gap to the ideal specification does this change close?
- What existing behavior must remain unchanged?
- Which automated and browser checks prove it?
- What is the next smallest gap?

No broad reset, sandbox startup rewrite, security relaxation, or compatibility layer is justified merely by an observability goal.
