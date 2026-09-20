# 02 — Deterministic Fixtures and Browser Acceptance

Status: Planned  
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
- Add a compact runtime-error fixture or a deterministic test seam when the runtime-error
  path is ready to be tested.
- Extend the existing Playwright smoke test after the settings Popup exists.
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
- Each policy fixture reaches a designed failure surface while Preview, Code, and Blame stay
  available.
- E2E assertions use lifecycle data attributes instead of relying only on visible text.
- The test can be run with a runtime URL and does not commit a personal repository URL.
- The preview surface has one intentional scrolling surface and does not leave GitHub line
  numbers or source code behind it.

## Non-goals

- Building a full Storybook installation.
- Adding a second implementation of production UI components.
- Exhaustively simulating every browser failure before the basic fixtures are stable.
