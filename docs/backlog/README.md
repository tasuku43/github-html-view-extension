# Backlog

The backlog is ordered by the smallest product gaps that provide the most user value.
Each numbered item should produce a browser-verifiable checkpoint before the next item
starts.

- `01_settings-popup.md` is the next product milestone.
- `02_fixtures-and-acceptance.md` makes the behavior reproducible and reviewable.
- `03_release-gates.md` prepares the project for a public release.
- `90_deferred-architecture.md` records ideas that are intentionally out of scope until
  the product needs them.

The current JavaScript baseline, sandbox boundary, and browser E2E check are the starting
point. A backlog item must not turn into a broad rewrite unless its acceptance criteria
prove that the current boundary cannot support the requested behavior.
