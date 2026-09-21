# 03 — Minimal Release Gates

Status: Done
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

## Implemented gate commands

From a fresh checkout:

```sh
npm ci
npm run check
npm run package
```

`npm run check` validates the MV3 manifest and its local file references, parses the
checked-in JavaScript files, and runs the unit tests. `npm run package` runs that gate
first, then creates `artifacts/extension-<manifest-version>.zip` with the complete contents
of `dist/` and verifies that every runtime file is present in the archive.

Browser E2E remains separate:

```sh
GHPREVIEW_E2E_URL=https://github.com/owner/repository/blob/main/path/to/file.html \\
  npm run e2e
npm run e2e:fixtures
```

The E2E commands require a real Chromium-based browser and a public GitHub URL. They are
not part of the local `check` command.

The permission and sandbox review result is recorded in
[docs/release-review.md](../release-review.md).

## Non-goals

- Introducing a source-to-distribution compiler solely for this milestone.
- Setting up CI/CD before the local gates are stable.
- Finalizing a product name as part of a technical release check.
