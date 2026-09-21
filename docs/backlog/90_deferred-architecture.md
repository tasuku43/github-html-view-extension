# 90 — Deferred Architecture Work

Status: Deferred
Priority: P2 — revisit only when maintenance cost justifies it

These items are intentionally not prerequisites for the current release gates.

## TypeScript migration

The extension may remain JavaScript while the behavior and settings contract stabilize.
TypeScript is optional, not a product requirement. Revisit it when the codebase has enough
shared contracts or refactoring pressure that static types clearly reduce maintenance cost.

## Full protocol typing

Keep protocol constants, runtime checks, request IDs, session IDs, and error codes explicit.
Do not add generated schemas or a comprehensive typed protocol layer until message drift is a
measured maintenance problem.

## Framework choice

Do not add React or a full Storybook installation merely for framework adoption. The required
production-state visual review surface is tracked in backlog item 04; its implementation may
remain a small static gallery as long as it reuses the production DOM factories and styles.

## Source/build rewrite

Do not replace the maintained `dist/` runtime with a new source tree and bundler as a
precondition for product work. Preserve the known sandbox startup path and make one
observable change at a time.

## CI and advanced failure injection

CI, deterministic Worker fault injection, sandbox startup fault injection, and exhaustive
branch/tag/commit matrices can follow the local settings and fixture milestones. The existing
observability and Playwright smoke test are the evidence for deciding which additional seams
are worth maintaining.
