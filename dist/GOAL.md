# Baseline scope

This document describes the behavior preserved by the known-good baseline. It is not the
destination architecture for the later TypeScript implementation.

## Included

- Render allowlisted `.html`, `.htm`, and `.xhtml` files on GitHub blob pages.
- Keep `Preview | Code | Blame` available on blob and blame views.
- Use Preview by default and `?plain=1` for source, following GitHub's Markdown behavior.
- Inline supported relative CSS, classic JavaScript, and binary resources into one HTML
  document before loading it in the sandbox.
- Provide a compact Action Popup for editing settings and exact `owner/repository` entries.

## Explicit exclusions

### Authorization

- Do not store login credentials, tokens, or sessions.
- Do not use the GitHub API for authorization or ref/path resolution.
- Do not accept wildcard allowlist entries.
- Do not enable a repository through a repository-owned configuration file.
- Do not add organization-wide or team-wide implicit trust.

### Rendering

- Never execute preview code on the `github.com` origin.
- Do not render Markdown, SVG, notebooks, or other file types already handled by GitHub.
- Do not create a parallel source panel or replace GitHub's native view controls.
- Do not support module scripts, dynamic imports, or page-origin network APIs in the
  baseline.

### Resource resolution

- Root-absolute paths remain unsupported because repository and site roots are ambiguous.
- Only one level of nested CSS `url()` rewriting is performed; `@import` is not followed.
- Files above the worker's 8 MB limit are rejected.

### Navigation and hosting

- Pull requests, changed-files views, and GitHub Enterprise hosts are not baseline targets.
- The only supported page origin is `https://github.com`.

Any future addition must preserve the opaque-origin sandbox and must not widen the fetch
boundary without an explicit security review.
