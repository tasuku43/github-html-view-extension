# Backlog

The backlog is ordered by the smallest product gaps that provide the most user value.
Each numbered item should produce a browser-verifiable checkpoint before the next item
starts.

- `01_settings-popup.md`, `02_fixtures-and-acceptance.md`, and `03_release-gates.md` are
  complete product milestones.
- `04_visual-review.md` tracks the remaining Storybook-style production-state review surface.
- `90_deferred-architecture.md` records ideas that are intentionally out of scope until
  the product needs them.

The current checked-in runtime, sandbox boundary, and browser E2E check are the maintained
starting point. A backlog item must not turn into a broad rewrite unless its acceptance
criteria prove that the current boundary cannot support the requested behavior.

## Status model

Each item has one `Status` line near the top of the document. Update that line in the same
commit that changes the work state.

| Status | Meaning |
| --- | --- |
| `Planned` | Defined and ready to start. |
| `In Progress` | Active implementation or validation is underway. |
| `Blocked` | Progress requires a specific external decision or fix. |
| `Done` | Acceptance criteria and the relevant checks are complete. |
| `Deferred` | Intentionally postponed; not part of the current delivery path. |

## Current board

| Item | Priority | Status | Next evidence |
| --- | --- | --- | --- |
| [01 — Action Popup and Settings](01_settings-popup.md) | P0 | Done | Completed |
| [02 — Deterministic Fixtures and Browser Acceptance](02_fixtures-and-acceptance.md) | P1 | Done | Completed |
| [03 — Minimal Release Gates](03_release-gates.md) | P1 | Done | Completed |
| [04 — Production Visual Review](04_visual-review.md) | P1 | Planned | Production DOM/state gallery |
| [90 — Deferred Architecture Work](90_deferred-architecture.md) | P2 | Deferred | A measured maintenance need |
