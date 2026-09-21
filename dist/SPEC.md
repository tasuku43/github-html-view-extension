# HTML Preview — Specification

A snapshot of what the extension does today. No history, no roadmap.

Companion documents: `README.md` (how to use it), `MODEL.md` (how it is built),
`GOAL.md` (what is deliberately left out), `DOM-HOOKS.md` (evidence for selectors).

---

## 1. Purpose

Render HTML files stored in a GitHub repository as documents rather than as source,
inside the GitHub blob view. Design docs, analysis reports, charts, and mockups saved
as HTML become readable where the discussion already happens.

---

## 2. Activation

The extension acts on a page only when **all** of the following hold.

| Condition | Value |
| --- | --- |
| Host | `github.com` |
| Path | `/{owner}/{repo}/blob/{ref}/{path}` or `/{owner}/{repo}/blame/{ref}/{path}` |
| Extension | `.html`, `.htm`, or `.xhtml`, case-insensitive |
| Global setting | `previewEnabled` is `true` |
| Repository | listed in the viewer's allowlist |

On every other page the extension inserts nothing and fetches nothing.

Content scripts are registered for `https://github.com/*` and run at `document_start`.

### 2.1 Settings and allowlist

Settings are edited in the Chrome Action Popup and stored in `chrome.storage.local` under
the `settings` key:

```json
{
  "schemaVersion": 2,
  "previewEnabled": false,
  "capabilities": {
    "javascript": false,
    "modals": false
  },
  "repositories": []
}
```

- The Popup uses an exact `owner/repository` input and lists registered entries.
- Entries can be removed and are saved immediately.
- An entry must match `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$`.
- Matching is exact apart from case.
- **Wildcards and duplicates are rejected** with English feedback.
- The Worker normalizes and rechecks settings before every fetch.
- `previewEnabled` is the master switch. Capability switches are disabled in the Popup
  while the master switch is off, and all switches start off.
- The Popup also shows form submission and new-window behavior as read-only `Not supported`
  limits; they are not persisted settings.

Adding a repository means: *HTML in this repository may execute as soon as it is opened.*
That includes code written by anyone who can open a pull request against it.

---

## 3. View switching

### 3.1 The control

A `Preview` item is inserted as the **first** item of GitHub's *File view* segmented
control, producing:

```
Preview | Code | Blame
```

The item is built by cloning an existing unselected item in the control, so it inherits
GitHub's styling without depending on class names. Both the label text and the item's
`data-text` attribute are set.

If the segmented control cannot be found, a plain `Preview` link is inserted next to
the `Raw` button instead. If that also fails, nothing is inserted and a warning is
logged.

### 3.2 URL contract

View state lives in the URL, matching what GitHub itself does for `.md`.

| URL | View |
| --- | --- |
| `…/blob/…/file.html` | Preview |
| `…/blob/…/file.html?plain=1` | Source |
| `…/blame/…/file.html` | Blame (source); `Preview` shown but not selected |

`plain` counts as source only when its value is exactly `1`.

URLs carrying the legacy `#preview` fragment still resolve to Preview, because
`#preview` is simply "not `?plain=1`".

Because the state is in the URL, it survives reload and can be handed to someone else
in a link.

### 3.3 Transitions

| From | Action | Result |
| --- | --- | --- |
| Preview | click `Code` | `?plain=1` added via `replaceState`; source shown |
| Preview | click `Blame` | GitHub navigates to `/blame/…` |
| Source | click `Preview` | `?plain=1` and fragment removed; preview shown |
| Blame | click `Preview` | full navigation to the `/blob/…` URL, preview shown |
| Blame | click `Code` | extension navigates to the canonical `/blob/…?plain=1` source URL |

Clicks on `Code` and `Blame` are observed through a single capturing listener on
`document`, not by attaching handlers to the buttons themselves.

The content controller prevents GitHub's default Code handler from racing this decision.
It maps Blame to Blob before adding `?plain=1`, so the resulting URL and selected view are
deterministic even when GitHub replaces the page through its SPA router.

### 3.4 Selection state

While previewing, the inserted item carries `data-selected` and its button reports
`aria-pressed="true"`; the item that GitHub had selected is unmarked and restored when
preview is left.

---

## 4. Rendering

### 4.1 Where code runs

The document is rendered inside an `<iframe>` pointing at `sandbox.html`, an extension
page declared in `manifest.json` under `"sandbox"`. Chrome serves it with a CSP
containing `sandbox allow-scripts`, which means:

- the page has an **opaque origin** — no access to the github.com DOM, cookies, or the
  viewer's credentials;
- `chrome.*` is unavailable — the page cannot borrow extension privileges;
- inline `<script>` executes — charts and diagrams work.

The `<iframe>` element always carries `allow-scripts` for the bundled bootstrap. It adds
`allow-modals` only when that setting is enabled. Form submission and popup creation remain
disabled by the sandbox policy. When the JavaScript capability is off, repository `<script>`
elements and inline event-handler attributes are removed before the document is sent to the
sandbox.

**`allow-same-origin` appears nowhere** — not on the element, not in the page CSP.

### 4.2 Placement

The iframe is mounted **as soon as the file-content container exists**, before the file
has been fetched. The region it replaces is hidden at the same moment.

The hidden region is not the matched element itself. Starting from the match, the
extension walks up to the outermost ancestor that does **not** contain the header
toolbar. The line-number gutter is a sibling of the text area, so hiding only the match
would leave line numbers visible below the preview.

If GitHub is still replacing the file body, mounting is deferred rather than using a
full-page overlay. A later DOM mutation retries the placement once the file-content
boundary is available.

`sandbox.html` displays a loading line until content arrives, so the iframe itself is
the placeholder.

### 4.3 Fetching

All network access happens in the service worker.

- Source of truth: `https://github.com/{owner}/{repo}/raw/{refAndPath}`
- `credentials: 'include'` — the viewer's existing session, no token of our own
- Redirects followed (the `/raw/` path redirects to another host)
- Hard limit of 8 MB per resource
- The worker serves requests only from content scripts running on `https://github.com/`,
  only fetches URLs under `https://github.com/`, and requires the target repository to
  match the sender's repository and the current settings allowlist.
- Responses are returned both as UTF-8 text and as base64
- Results are cached per page, keyed by URL

A fetch starts as early as the URL and allowlist allow, in parallel with GitHub's own
page rendering.

### 4.4 Inlining

The fetched HTML is parsed with `DOMParser`, transformed, serialized, and prefixed with
`<!doctype html>`. Any `<base>` element is removed first.

Each reference is classified against the resolution base
(`https://github.com/{owner}/{repo}/raw/{refAndPath}`):

| Class | Condition | Handling |
| --- | --- | --- |
| `skip` | empty, `#…`, `data:`, `blob:`, `about:`, `javascript:` | left alone |
| `external` | has a scheme, or starts with `//` | left alone; loaded from the network at view time |
| `unsupported` | starts with `/` | left alone; warning logged |
| `unsupported` | resolves outside `https://github.com/{owner}/{repo}/raw/` | left alone; warning logged |
| `inline` | anything else | fetched and embedded |

Transformations applied to `inline` references:

| Selector | Attribute | Result |
| --- | --- | --- |
| `link[rel~="stylesheet"][href]` | `href` | replaced by `<style>`; `url()` inside resolved against the stylesheet's own URL |
| `script[src]` | `src` | replaced by inline `<script>`; all other attributes preserved; `</script>` in the body escaped |
| `img[src]`, `source[src]`, `audio[src]` | `src` | `data:` URI |
| `video[poster]` | `poster` | `data:` URI |
| `img[srcset]` | `srcset` | each URL replaced, descriptors preserved |
| `style` (inline in the document) | — | `url()` resolved against the document URL |

References that cannot be read are left untouched and reported. Nothing is silently
dropped.

Not handled: root-absolute paths, ES modules, dynamic `import()`, runtime `fetch` /
`XMLHttpRequest`, CSS `@import`, and anything more than one level of `url()` nesting.

### 4.5 Handover

`sandbox.html` and the document content become ready in either order, so both are
awaited before the content is sent.

The bundled bootstrap reports its startup separately from readiness. If the initial ready
message is missed, the parent sends a `ghpreview:sandbox-ping` after iframe load and the
bootstrap reports readiness again. The parent also removes an unexpected `srcdoc` attribute
so the iframe cannot silently fall back to `about:srcdoc` instead of the declared entry
point.

| Direction | Identity check |
| --- | --- |
| github.com → sandbox | `event.source === window.parent` and `event.origin === 'https://github.com'` |
| sandbox → github.com | `event.source === frame.contentWindow` |

The sandbox has an opaque origin, so its messages arrive with origin `"null"`; only the
source check is meaningful in that direction.

On receipt the sandbox calls `document.open()` / `write()` / `close()`.

The sandbox also reports `render-started` and `render-ready`, then sends height
notifications. Runtime failures are reduced to the safe `sandbox-runtime-error` code and
correlated with the current session ID. The parent accepts only messages from the expected
frame with the matching session ID.

The active Preview surface exposes `data-preview-state`, `data-preview-error-code`,
`data-preview-request-id`, and `data-preview-session-id`. The lifecycle states are `idle`,
`detecting`, `checking-settings`, `fetching`, `validating`, `mounting`,
`waiting-for-sandbox`, `rendering`, `waiting-for-height`, `ready`, `disabled`, `failed`,
and `stale`.

### 4.6 Height

A small reporter script is placed in the rendered document before the document's body
scripts. It posts the document height to `https://github.com` on load, on
`ResizeObserver` callbacks, once fonts are ready, and at 0 / 250 / 1000 ms.

The parent sets the iframe height to `ceil(height) + 8`. Reports differing from the
applied height by 8 px or less are ignored. After `render-ready`, the parent enters
`waiting-for-height`; if no usable height arrives before the timeout, it fails with the
`height-timeout` diagnostic code.

### 4.7 Navigation

GitHub replaces page content while rewriting the URL. The extension watches for this
with a `MutationObserver` on `document.documentElement` (`childList`, `subtree`),
debounced at 150 ms, comparing `location.href` against the last seen value, plus a
`hashchange` listener. No GitHub-internal navigation events are used.

On a URL change the iframe is removed, the hidden region restored, message listeners
dropped, and the inserted `Preview` item removed before re-evaluating the new page.

---

## 5. Failure behavior

| Failure | Behavior |
| --- | --- |
| File cannot be fetched | an inline Preview error surface is shown, Code and Blame remain available, warning logged |
| Subresource cannot be fetched | reference left as written, warning logged |
| Segmented control not found | `Preview` link placed next to `Raw`, warning logged |
| Header toolbar not found | nothing inserted, warning logged |
| File-content container not found | sandbox mounting is delayed until the file body appears, warning logged |
| HTML policy violation | an inline Preview error surface is shown with detected issues |
| Sandbox startup timeout | an inline Preview error surface is shown with `sandbox-timeout` |
| Height notification timeout | an inline Preview error surface is shown with `height-timeout` |
| Extension reloaded under an open tab | `chrome.*` calls fail once, then are not attempted again |

Structured lifecycle logs go to the page console prefixed with `[html-preview]`. DOM
selector warnings keep the `[ghpreview]` prefix and are printed once per message.

---

## 6. Permissions

| Declaration | Reason |
| --- | --- |
| `storage` | normalized settings and the exact repository allowlist |
| `host_permissions: github.com` | fetching file contents |
| `host_permissions: objects/raw/media.githubusercontent.com` | redirect targets of `/raw/` |

No `nativeMessaging`, no `tabs`, no `cookies`, no `webRequest`. No content script runs
in the page's MAIN world; GitHub's own traffic is never intercepted.

---

## 7. Design decisions

Recorded here because the reasoning is not recoverable from the code.

### Rendering is not done with `srcdoc`

An `srcdoc` iframe inherits the parent's CSP. The parent is github.com, whose CSP blocks
inline `<script>`, so scripted documents would not run. Loading an extension page makes
that page's own CSP apply, which is what makes opaque origin and inline execution
possible at the same time.

### `allow-same-origin` is never set

The allowlist expresses trust in a repository, but code would land on github.com, which
is far broader. Anyone able to open a pull request against a trusted repository would
reach the viewer's github.com session. Review is a primary use case, so this is not
hypothetical.

### Content is written with `document.write`

Scripts inserted via `innerHTML` do not execute, which defeats the purpose. The target
is a page created for exactly this and holding nothing else.

### Rendering is the default, source is one click away

GitHub renders `.md` by default and exposes source through `?plain=1`; the same shape is
used here. The objection — that GitHub can default to rendered because rendering is its
own code, while arbitrary HTML is not — is answered by *where* the code runs rather than
*whether* it runs. Execution is confined to an opaque origin, and the decision to trust
was already made when the repository was added to the allowlist.

### The URL contract reuses `?plain=1`

Inventing `#preview` or `#source` would mean a second vocabulary for something GitHub
already names. `?plain=1` is already understood, already survives reload and sharing,
and leaves room for GitHub to implement Preview for `.html` without a collision.

### `ref` and `path` are never separated

`blob/` is followed by `{ref}/{path}`, and branch names may contain slashes, so the
boundary is not recoverable from the URL. Resolving it would require the GitHub API,
which contradicts holding no authorization of our own. Swapping `blob` for `raw` and
keeping the remainder as one opaque string yields a correct target without knowing the
boundary, and lets ordinary URL resolution handle relative references.

The cost is that root-absolute paths cannot be resolved — repository root and site root
are indistinguishable — so they are reported rather than guessed.

### Fetching goes through the service worker

`/raw/` redirects to another host. From a content script that redirect fails CORS. From
the extension it is followed within the declared host permissions.

### `raw.githubusercontent.com` is not used directly

Cookies do not authenticate there; private repositories require a signed token.
`github.com/…/raw/…` lets GitHub handle that.

### The allowlist has no wildcards

`owner/*` would silently extend trust to every repository added to the organization
later. The list is meant to be a handful of entries chosen deliberately.

### GitHub's navigation events are not used

Their names are GitHub's to change. Comparing `location.href` after DOM mutations is
slower but depends on nothing internal.

### Class names are not used as selectors

GitHub's class names carry build hashes. The extension relies on `aria-label`,
`data-component`, `data-testid`, and `data-text`, and clones existing elements when it
needs to match their appearance.

### The cloned segment item is an unselected one

Cloning the selected item would copy the selected styling.

### `data-text` is updated along with the label

The control reserves width for the bold weight applied on selection by duplicating the
label into `data-text`. Changing only the text makes the control jump on selection.

### View clicks are planned before navigation

The capturing listener reads the visible `Code` or `Blame` label and passes the click to
the pure view-transition contract. Code is handled by the extension because its canonical
source URL is deterministic; Blame remains a GitHub-owned navigation because GitHub owns
its route and line-anchor details.

### The iframe is mounted at full size before content arrives

A zero-sized or hidden-then-revealed iframe measures its document at the wrong width,
which produces the wrong height. Mounting at final size keeps the measurement honest and
lets the sandbox page act as its own placeholder.

### Iframe height carries 8 px of slack

Sizing the frame exactly to the content can leave a few pixels of scrollable range
inside the document. Small wheel gestures are consumed there instead of scrolling the
page. Reports within the slack are ignored, so documents sized to their container do not
grow without bound.

### The extension is not bundled, and has no dependencies

Loading unpacked from `chrome://extensions` must work directly; tests run on Node's
built-in runner.

---

## 8. Verification status

| Area | Status |
| --- | --- |
| URL handling, allowlist, reference classification | covered by `npm test` |
| Segmented control and toolbar selectors | confirmed against live DOM, recorded in `DOM-HOOKS.md` |
| File-content container selectors | one of the candidates matches; which one is not yet isolated |
| Subresource inlining | **not yet exercised against a real file** |
| Private-repository fetching via `/raw/` | **not yet confirmed** |

`inlineDocument` is not unit-tested: it needs `DOMParser`, and the repository does not
add dependencies. All decision logic is factored into `src/lib/inline.js`, which is
tested; what remains is application of the rule table.
