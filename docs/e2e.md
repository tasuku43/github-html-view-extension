# Browser E2E smoke test

The repository includes a Playwright-based browser smoke test for the unpacked MV3
extension. It launches an isolated persistent browser context, loads `dist/` as an
extension, configures the target repository in the extension service worker, and checks the
real GitHub page.

The test uses the URL supplied at runtime. Do not commit a repository URL, account name, or
other private browsing context to the repository.

Playwright is a development dependency. Install its browser once when the local cache does
not already contain Chromium:

```sh
npx playwright install chromium
```

## Run against a ready fixture

Use a public GitHub HTML Blob URL whose document satisfies the self-contained HTML policy:

```sh
GHPREVIEW_E2E_URL="https://github.com/owner/repository/blob/main/path/to/fixture.html" \
GHPREVIEW_E2E_EXPECT_STATE=ready \
npm run e2e
```

The runner opens the Action Popup in a temporary browser profile, verifies the disabled
first-run state, enables Preview, adds the exact `owner/repository` entry, and then checks
the initial Preview state and the following navigation contract:

```text
Preview -> Code
Code -> Blame
Blame -> Preview
Blame -> Code
```

For a page that is expected to be rejected by the HTML policy, assert the failure instead:

```sh
GHPREVIEW_E2E_URL="https://github.com/owner/repository/blob/main/path/to/invalid.html" \
GHPREVIEW_E2E_EXPECT_STATE=failed \
GHPREVIEW_E2E_EXPECT_ERROR_CODE=html-policy-violation \
npm run e2e
```

## What the runner verifies

- the repository is enabled in the extension storage context;
- a terminal Preview state is reached (`ready`, `failed`, or `disabled`);
- `data-preview-state`, `data-preview-error-code`, `data-preview-request-id`, and
  `data-preview-session-id` are observable;
- Preview remains present while Code and Blame are selected;
- Blame -> Code ends at the Blob source URL with `?plain=1`;
- the extension's Preview control remains available after GitHub SPA navigation.

The same run verifies the Popup-to-storage contract before opening GitHub, so a Popup
regression is visible rather than being hidden by direct storage setup.

The default run keeps the browser visible because extension loading is more reliable in a
persistent headed context. Set `GHPREVIEW_E2E_HEADLESS=1` only when the selected browser
supports extension loading in headless mode. Set `GHPREVIEW_E2E_NAVIGATION=0` to inspect
only the initial terminal state. Set `GHPREVIEW_E2E_BROWSER_PATH` or `CHROME_PATH` when a
specific browser executable is required.
