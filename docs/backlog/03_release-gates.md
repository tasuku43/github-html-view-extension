# 03 — Minimal Release Gates

Status: Planned  
Priority: P1 — required before public release

## Goal

Make it obvious whether the checked-in extension is testable and ready to package, without
introducing a large build system.

## Scope

- Define a small root-level check command for manifest, JavaScript syntax, and unit tests.
- Keep the browser E2E command separate because it needs a real browser and a runtime GitHub
  URL.
- Define the repeatable way to load `dist/` as an unpacked extension.
- Define a repeatable packaging step for the current checked-in runtime directory.
- Review MV3 permissions, host permissions, web-accessible resources, and sandbox entries
  before release.
- Confirm that user-facing copy, fixtures, diagnostics, and documentation contain no private
  context.
- Decide the product name only after the behavior and settings UX are stable.

## Acceptance criteria

- A fresh checkout can run the local checks using documented commands.
- A fresh browser profile can load the same `dist/` directory used by the checks.
- Packaging does not silently omit the sandbox entry, popup, styles, or content scripts.
- The release review has an explicit permission and security-boundary result.
- No release step requires TypeScript, React, Storybook, or an untracked local script.

## Non-goals

- Introducing a source-to-distribution compiler solely for this milestone.
- Setting up CI/CD before the local gates are stable.
- Finalizing a product name as part of a technical release check.
