# 90 — Deferred Architecture Work

Status: Deferred
Priority: P2 — revisit only when maintenance cost justifies it

These items are intentionally not prerequisites for the next product milestone.

## TypeScript migration

The extension may remain JavaScript while the behavior and settings contract stabilize.
TypeScript is optional, not a product requirement. Revisit it when the codebase has enough
shared contracts or refactoring pressure that static types clearly reduce maintenance cost.

## Full protocol typing

Keep protocol constants, runtime checks, request IDs, session IDs, and error codes explicit.
Do not add generated schemas or a comprehensive typed protocol layer until message drift is a
measured maintenance problem.

## Framework-based UI tooling

Do not add React or a full Storybook installation. A small static design gallery or focused
browser checks are sufficient for the current number of surfaces. If a gallery is added, it
must reuse the production DOM factories and styles.

## Source/build rewrite

Do not replace the working `dist/` baseline with a new `src/` and bundler architecture as a
precondition for settings. Preserve the known sandbox startup path and make one observable
change at a time.

## CI and advanced failure injection

CI, deterministic Worker fault injection, sandbox startup fault injection, and exhaustive
branch/tag/commit matrices can follow the local settings and fixture milestones. The existing
observability and Playwright smoke test are the baseline for deciding which additional seams
are worth maintaining.
