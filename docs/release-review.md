# Minimal Release Review

Status: Reviewed for the current checked-in runtime

This review covers the checked-in `dist/` directory. The unpacked extension and the
packaged archive use the same files; no compiler or generated source tree is involved.

## Local gates

Run these commands from the repository root:

```sh
npm ci
npm run check
npm run package
```

The browser gate is intentionally separate because it needs a real Chromium-based browser
and a public GitHub URL:

```sh
GHPREVIEW_E2E_URL=https://github.com/owner/repository/blob/main/path/to/file.html \\
  npm run e2e
npm run e2e:fixtures
```

## Permission decision

| Surface | Current grant | Decision |
| --- | --- | --- |
| `permissions` | `storage` | Required for the local settings contract; keep. |
| GitHub page host | `https://github.com/*` | Required for the content script and page integration; keep. |
| GitHub content hosts | `raw.githubusercontent.com`, `objects.githubusercontent.com`, and `media.githubusercontent.com` | Required for Worker fetches and supported GitHub resource responses; keep these exact hosts only. |
| Broad browser access | No `<all_urls>`, `tabs`, `cookies`, or `scripting` permission | No expansion approved. |

The Worker accepts fetch requests only from a GitHub content script, only for the same
repository, and only after the normalized local settings allow that repository.

## Security-boundary decision

- The content script remains in the extension isolated world and does not inject code into
  GitHub's page world.
- Repository HTML is rendered only in the extension-bundled `sandbox.html` entry point.
- The iframe keeps `allow-scripts` for the bootstrap and never receives `allow-same-origin`.
- Repository JavaScript is removed unless the user enables the JavaScript capability.
- The sandbox communicates through a session-bound `postMessage` handshake; it cannot use
  extension APIs, GitHub cookies, or the GitHub page DOM.
- `web_accessible_resources` exposes only the sandbox assets and extension UI stylesheet to
  GitHub pages.
- The HTML policy rejects external resources, module scripts, active embeds, unsafe URLs,
  and other network-capable constructs before rendering.

Result: the current permission set and sandbox boundary are acceptable for this milestone.
Any new host, permission, sandbox token, or external resource must receive a separate
security review before it is added.

## Public-context review

The checked-in user-facing copy, fixtures, diagnostics, and documentation were reviewed for
private organization context. They use generic GitHub, repository, and fixture terminology.
No account-specific URL, token, company name, internal project name, or personal name is
required by the release procedure.

## Packaging result

`npm run package` packages the complete checked-in `dist/` directory with `manifest.json` at
the archive root. The packaging script verifies that the sandbox entry, popup assets, content
scripts, styles, Worker, and test/reference files present in `dist/` are not omitted from the
archive. The generated `artifacts/` directory is ignored by Git.

The product name remains provisional and is intentionally not decided by this technical gate.
