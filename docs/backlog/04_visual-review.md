# 04 — Production Visual Review

Status: Planned
Priority: P1 — required for maintainable UI review

## Goal

Provide a Storybook-style review surface for important production UI states without adding a
runtime UI framework or creating a second implementation of the extension UI.

## Scope

- Reuse the production DOM factories and CSS used by the Action Popup and Preview surfaces.
- Make the master switch, capability rows, unsupported limits, allowlist states, validation
  errors, runtime warnings, and loading states inspectable in isolation.
- Keep all state labels, fixture values, comments, and documentation in English.
- Make the gallery usable from a local static server and suitable for repeatable visual review.

## Acceptance criteria

- Every important state in `docs/specification.md` has one deterministic review entry.
- The review entry uses the same production factories and styles as the runtime surface.
- The gallery does not introduce React, a runtime dependency, or a second behavior model.
- Existing unit, check, and browser E2E commands remain green.

## Non-goals

- Adding framework-specific Storybook configuration.
- Changing the product behavior or settings contract.
- Treating exploratory design concepts as production UI.
