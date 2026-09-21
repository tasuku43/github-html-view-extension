# HTML Preview Product Specification

## Document status

This document is the product contract for the HTML Preview extension. It describes the intended end state and the evidence required to reach it safely.

The target architecture is a destination, not a reason to rewrite a working implementation in one step. Every implementation change must preserve the last verified behavior and close one small, observable gap at a time.

The product name is intentionally provisional. No final brand name is part of this specification.

## Technology and maintenance constraints

- TypeScript is optional. The extension may remain JavaScript while the behavior and settings contract stabilize; introduce TypeScript only when it clearly reduces maintenance cost.
- The extension targets Chrome Manifest V3, including a Service Worker and the declared MV3 sandbox boundary.
- The checked-in `dist/` runtime directory remains the source of truth while the baseline is being improved. A build pipeline is optional and must not be introduced merely to rearrange working files.
- The project does not introduce React or another UI framework merely to build the extension. Production UI uses ordinary DOM factories and CSS.
- No new external runtime library is required for the product scope. Development-only browser automation is acceptable when it provides real extension coverage; runtime behavior must remain dependency-light.
- The design review surface follows a Storybook-style workflow: each important production state must be inspectable in isolation, using the same production DOM factories and styles. A framework-specific Storybook integration is optional; component reuse and repeatable visual review are mandatory.
- The repository is maintained as a long-lived project. Clear boundaries, small changes, focused tests, and repeatable browser checks take priority over short-term rewrite speed.
- New or changed user-facing copy, tests, comments, and documentation are written in English.
- Product code, UI, fixtures, logs, and documentation must not contain company names, internal URLs, private repository names, personal names, or internal project names.

## Product promise

On GitHub file views, users can preview an explicitly trusted HTML document together with the repository-relative resources needed to make it useful, without losing GitHub's native Code and Blame navigation. The extension must be safe by default, make trust decisions explicit, and be diagnosable when a preview does not complete.

## Scope

### Supported

- GitHub blob and blame file views.
- `.html`, `.htm`, and `.xhtml` files.
- Branch, tag, and commit references in normal GitHub file URLs.
- GitHub's existing `Preview | Code | Blame` control.
- A Chrome Action Popup for global settings and an exact repository allowlist.
- Repository-backed HTML rendered inside an extension-bundled MV3 sandbox page.
- Repository-relative stylesheets, images, fonts, classic JavaScript, CSS `url(...)` resources,
  and CSS `@import` dependencies when every dependency can be resolved safely.
- Relative references resolved against the exact GitHub repository, ref, and file location
  represented by the current file view. Branch, tag, and commit references use the same
  resolution contract.

### Not supported

- Markdown, top-level SVG files, notebooks, or other formats already rendered by GitHub.
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
  "schemaVersion": 2,
  "previewEnabled": false,
  "capabilities": {
    "javascript": false,
    "modals": false
  },
  "repositories": []
}
```

### Settings behavior

- `previewEnabled` is the global master switch.
- The available capabilities are global and independent: inline or repository-relative classic
  JavaScript and browser dialogs.
- The initial value of every switch is off.
- The initial allowlist is empty.
- The Popup must make the disabled-by-default behavior obvious.
- Changes save immediately and show a clear saved state or equivalent feedback.
- The Popup must remain usable at a compact Chrome Action Popup size.
- When Preview is enabled but the current repository is not trusted, selecting Preview must
  show an inline trust decision instead of treating the repository as an ordinary Preview
  failure.
- The trust surface must identify the exact current `owner/repository` and offer an explicit
  action to trust it. Trusting it continues to Preview without requiring a Popup visit or a
  second manual Preview selection.
- The Popup must show form submission and new-window behavior as read-only `Not supported`
  limits rather than misleading disabled switches.
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
- The Popup remains the place to review and remove trusted repositories; it is not required
  before the first Preview attempt.
- A trust action is idempotent. Repeated selection, refresh, back/forward navigation, and
  concurrent settings updates must never create duplicate entries.
- The trust surface offers `Trust repository` and `Open Code`. Choosing `Open Code` leaves
  the repository unchanged and returns to GitHub's native Code view; Preview and Blame
  remain available from there.
- There is no legacy data-format compatibility requirement because the extension is unreleased.

## HTML policy

HTML is validated and its supported repository-relative dependencies are resolved before any
source HTML is sent to the sandbox. Supported dependencies are rewritten into the document as
inline CSS/JavaScript or safe passive data URLs. A rejected or partially unresolved document is
never rendered as a misleading partial result.

### Allowed

- Inline CSS.
- Repository-relative stylesheets, including nested CSS `@import`, when they can be fetched
  from the same exact repository ref.
- Repository-relative images, fonts, and passive media, including CSS `url(...)` references.
- Repository-relative classic JavaScript when the JavaScript capability is enabled. These
  scripts are fetched and inlined before they enter the sandbox; they never fetch dependencies
  directly from the network.
- Same-document fragment links.
- Safe passive media encoded as safe `data:` URLs.
- Forms as visible, editable elements.

### Rejected

- Root-relative resources whose repository ref cannot be determined unambiguously.
- External network resources, including external stylesheets, images, fonts, media, and scripts.
- Repository resources that cannot be fetched, exceed the preview resource limits, or have an
  unsupported content type.
- Module scripts and dynamic imports.
- Non-stylesheet `<link>` elements.
- `<iframe>`, `<object>`, and `<embed>`.
- CSS `@import` or `url(...)` references that are external, root-relative, unsafe, or cannot be
  resolved from the repository.
- `<base>` elements, because they could change dependency and navigation resolution.
- Meta refresh.
- Network APIs, workers, and other active network paths.
- Dangerous navigation schemes.
- Unsafe data URLs.

When JavaScript is disabled, repository scripts and inline event handlers are removed before
rendering; an unused repository script does not need to be fetched. When it is enabled, only
classic scripts are permitted by the policy, whether they originated inline or from a supported
repository-relative `src`. Runtime errors do not remove an otherwise rendered document; they
produce an extension-owned warning.

The Worker is the only network path. The content script resolves the dependency graph and sends
only the fully rewritten document to the opaque sandbox. The implementation may use bounded
resource count, byte, and CSS import-depth limits. If any required dependency fails, the whole
Preview enters a designed resource-resolution failure state.

Forms remain visible and editable in both modes, but native form submission is intentionally
disabled by the sandbox policy. Popup creation is also disabled. Browser dialogs are
independently controlled by the optional dialogs capability.

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
- Repository trust required before fetch.
- HTML policy or validation failure.
- Repository resource resolution failure.
- Sandbox communication or startup failure.
- Render failure.
- Height or layout timeout.
- Runtime error after rendering.

`Recheck` must invalidate any in-memory response for the current file and perform a fresh Worker request. It must not depend on a failed response or stale cache entry.

### Repository trust

The untrusted-repository state is a separate Preview lifecycle state, not a generic failure
surface. It must communicate:

- `Trust this repository for Preview?`.
- The exact current `owner/repository` shown in the page UI.
- That only this exact repository will be added and no source is fetched before approval.
- An explicit `Trust repository` action and an `Open Code` action. `Open Code` returns to
  the native Code view without changing the allowlist.
- That trusted repositories can be reviewed or removed from the Action Popup.

The Worker derives the repository from the sending GitHub file page and rechecks the global
Preview switch before persisting the exact entry. The content script must not trust a
repository name supplied only by page markup or by an arbitrary message. A successful trust
action invalidates the current untrusted operation and naturally starts a fresh Preview
operation. A failed trust write remains retryable and does not fetch or mount the document.

## Preview lifecycle

The content script owns the current operation state. The state is projected onto the Preview surface and must not be inferred only from visible text.

The lifecycle vocabulary is:

```text
idle
detecting
checking-settings
trust-required
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
trust-requested
repository-trusted
trust-declined
trust-failed
request-started
request-sent
response-received
response-rejected
fetch-failed
validation-started
validation-failed
resource-resolution-started
resource-resolution-completed
resource-resolution-failed
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
The `.ts` suffixes in the example are illustrative; the boundaries matter more than a
mandatory language migration.

### Core

Pure platform-independent contracts and functions: GitHub URL parsing, settings
normalization, repository matching, HTML validation, transformation, protocol messages, and
safe diagnostics. Core code must not depend on Chrome APIs or GitHub DOM details.

### Content script

The content script owns GitHub DOM integration, navigation observation, the current preview operation, surface state, and user actions. It must not fetch arbitrary URLs directly.

### Service Worker

The Worker is the only network fetch boundary. It derives and validates raw repository targets
from the sender's current GitHub page, rechecks the extension settings and exact repository
allowlist for every dependency, and returns typed text or bounded binary data together with
typed success or failure codes. It never returns credentials or stores source content.

### Sandbox

The iframe entry point is the extension-bundled `sandbox.html` with a session query parameter. It must not be replaced by `about:blank`, `srcdoc`, content-script-generated bootstrap markup, or dynamic script injection. The manifest must declare the sandbox page and the required web-accessible resources.

The iframe uses an opaque origin: `allow-scripts` is required, while `allow-same-origin` is not allowed. `allow-modals` is added only when the optional dialogs capability is enabled. Form submission and popup creation remain disabled. Parent and child validate message source, origin expectations, protocol version, and session ID.

### Popup and design gallery

The Action Popup is the production settings surface. The design gallery is a local evaluation surface and must reuse production DOM factories where practical. It must not become a second implementation of runtime behavior.

The gallery is the lightweight Storybook-style review loop for this vanilla TypeScript extension. It should show the Popup, file tabs, loading, ready, policy-error, runtime-warning, and communication-failure states with realistic content and controls. It is used before GitHub E2E so visual and interaction regressions are found without a live GitHub page.

## Verification contract

### Fixtures

`docs/sample/index.html` is the deterministic inline acceptance fixture. It exercises realistic
layout, scrolling, controls, and an optional runtime-error path without depending on repository
assets.

`docs/sample/repository-backed/` is the repository dependency fixture. It must exercise a
relative stylesheet, nested CSS imports, a relative image, a CSS `url(...)`, a relative font,
a relative classic script, and nested `../` references.

`docs/sample/invalid/` contains designed failure fixtures such as an unresolved repository
resource, an external resource, and a module script. Each fixture must preserve the Preview,
Code, and Blame controls while explaining the specific failure category.

### Browser acceptance

The browser check must verify:

- A valid fixture reaches `data-preview-state="ready"`.
- The repository-backed fixture reaches `data-preview-state="ready"`, and its rewritten CSS,
  image, font, and classic script behavior is observable inside the sandbox.
- An unresolved or external resource reaches `data-preview-error-code="resource-resolution-failed"`.
- A module fixture reaches `data-preview-error-code="html-policy-violation"`.
- An untrusted repository reaches `data-preview-state="trust-required"` and
  `data-preview-error-code="repository-not-allowed"` without a Worker fetch or sandbox
  frame, then reaches `ready` after the explicit trust action.
- Choosing `Open Code` leaves the allowlist unchanged. Removing trust from the Popup causes
  the same repository to return to `trust-required` on the next Preview selection.
- Repeated trust actions remain idempotent, and navigating between repositories does not
  reuse or duplicate the previous repository's trust decision.
- Preview, Code, and Blame remain available through GitHub navigation.
- Blob and Blame flows do not duplicate controls or leave stale frames.
- The preview surface owns the intended scrolling behavior and hides GitHub code-line artifacts behind it.
- A runtime error is associated with the current session and does not discard the document.
- Recheck creates a new request and session and performs a fresh fetch.
- Worker failure, sandbox startup failure, render failure, and height timeout are distinguishable by state, error code, and structured logs.
- Branch, tag, and commit-reference pages resolve the repository-backed fixture against the
  viewed ref. Public repositories use normal GitHub access, and private repositories use the
  viewer's existing GitHub session without extension-managed credentials.

E2E assertions must prefer `data-preview-state` and `data-preview-error-code` over matching only visible copy. Visible English text is still part of the UX contract.

### Automated checks

The minimum repository gates are:

```text
npm test
npm run e2e
npm run check
```

Typecheck and build commands are added only if a TypeScript or source-build workflow is
adopted later.

Tests must cover pure policy and URL behavior, settings and allowlist behavior, protocol validation, state projection, Worker failure propagation, stale operations, sandbox handshake ordering, recheck invalidation, and data-attribute updates.

The repository-backed resource tests must also cover nested relative resolution, CSS imports,
CSS `url(...)`, binary transfer, classic-script capability gating, missing dependencies, and the
same resource contract across branch, tag, and commit references.

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
