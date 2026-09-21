# 02 — Deterministic Fixtures and Browser Acceptance

Status: Done
Priority: P1 — required for confident maintenance

## Goal

Make the product behavior easy to verify from the repository and from a real GitHub page,
without depending on an undocumented manual setup.

## Scope

- Keep `docs/sample/index.html` as a genuinely self-contained valid fixture.
- Add small English policy fixtures under `docs/sample/invalid/` for:
  - relative resources;
  - external resources;
  - module scripts.
- Add a compact runtime-error fixture for the sandbox failure path.
- Extend the existing Playwright smoke test after the settings Popup exists.
- Add a first-time trust path that starts with an empty allowlist, supports decline, and
  continues after an explicit inline approval.
- Provide one fixture-matrix command that runs the valid, policy-rejected, and missing-file
  cases without storing a repository URL in the source.
- Assert `data-preview-state`, `data-preview-error-code`, request ID, and session ID.
- Verify the navigation contract:

  ```text
  Preview -> Code
  Preview -> Blame
  Blame -> Preview
  Blame -> Code
  ```

- Verify that Preview remains available after GitHub SPA DOM replacement.
- Keep fixture content free of external assets and private context.

## Acceptance criteria

- One valid fixture reaches `ready` in a public GitHub Blob page.
- An untrusted repository reaches `trust-required` without fetching or mounting a sandbox;
  approval adds exactly one trusted entry and continues to `ready`.
- Each policy fixture reaches a designed failure surface while Preview, Code, and Blame stay
  available.
- The runtime-error fixture reaches `ready` with a designed sandbox warning when inline
  JavaScript is enabled, while the rendered document remains visible.
- E2E assertions use lifecycle data attributes instead of relying only on visible text.
- The valid fixture has no unexpected inner scrollbar after height synchronization.
- The test can be run with a runtime URL and does not commit a personal repository URL.
- The preview surface has one intentional scrolling surface and does not leave GitHub line
  numbers or source code behind it.

## Non-goals

- Building a full Storybook installation.
- Adding a second implementation of production UI components.
- Exhaustively simulating every browser failure before the basic fixtures are stable.
