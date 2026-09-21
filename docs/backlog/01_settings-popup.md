# 01 — Action Popup and Settings

Status: In Progress
Priority: P0 — required for the product contract

## Goal

Let users control Preview directly from the Chrome Action Popup. The extension must be safe
and inactive by default, while still making the exact repository approval model easy to use.

## Scope

- Add an Action Popup entry to the MV3 manifest.
- Store one normalized settings object in `chrome.storage.local` under `settings`:

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

- Make `previewEnabled` the global master switch.
- Keep all capability switches off by default.
- Add exact `owner/repository` entries.
- List and remove registered repositories.
- Reject malformed entries, duplicates, and wildcards with clear English feedback.
- Match owner and repository names case-insensitively without changing the useful display
  spelling.
- Save changes immediately and show a compact saved state.
- Keep the Popup usable at Chrome Action Popup dimensions with keyboard-accessible controls.
- Show form submission and new-window behavior as read-only `Not supported` limits rather than
  presenting them as configurable switches.
- Reuse the existing product visual language; do not introduce React or a framework-specific
  component system.

## Runtime behavior

- When `previewEnabled` is false, the content script must not fetch or mount a Preview.
- When the repository is not allowlisted, the content script must not fetch or mount a
  Preview.
- The Worker must recheck the normalized settings before serving a fetch request.
- The sandbox must receive only the optional capability that is enabled: `allow-modals`.
  Its bundled bootstrap always requires `allow-scripts`; the JavaScript capability controls
  repository scripts and inline event handlers before the document is sent to the sandbox.
- Form submission and popup creation remain disabled by design.
- JavaScript-disabled rendering must remove scripts and inline event handlers according to
  the existing HTML policy.

## Acceptance criteria

- A fresh profile shows every switch off and an empty repository list.
- Toggling the master switch changes whether the Preview control appears on a supported
  GitHub HTML file.
- A valid repository can be added, displayed, and removed without a page reload.
- Invalid and duplicate entries remain visible as actionable errors and are not stored.
- Case differences do not change repository matching.
- Capability changes are observable in the sandbox behavior and do not weaken the opaque
  origin boundary.
- Popup-to-GitHub browser E2E verifies the settings contract through DOM state attributes,
  not only visible copy.

## Non-goals

- Migrating the extension to TypeScript.
- Adding a separate options page.
- Supporting wildcard or organization-wide entries.
- Adding account, token, telemetry, or GitHub API configuration.
- Redesigning the surrounding GitHub file page.
