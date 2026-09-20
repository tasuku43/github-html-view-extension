# GitHub DOM selector evidence

`src/github/dom.js` is the only module that touches the GitHub page DOM. This file records
the selectors and the reason each fallback exists. GitHub does not publish this DOM as a
stable extension API, so these hooks must be rechecked when the UI changes.

## Verification method

1. Open an allowlisted HTML file on a GitHub blob page.
2. Inspect the live DOM after GitHub has finished replacing its page regions.
3. Check the candidates below in order and update `SELECTORS` only with observed evidence.
4. Verify both public and authenticated views when possible.

## View switch

The preferred insertion point is the existing Code / Blame segmented control.

| Selector | Role |
| --- | --- |
| `ul[aria-label="File view"]` | Semantic file-view container. |
| `ul[data-component="SegmentedControl"]` | Primer component fallback. |
| `li[data-component="SegmentedControl.Button"]` | One switch item. |
| `li[data-component="SegmentedControl.Button"]:not([data-selected])` | Unselected visual template. |
| `button[aria-pressed]` | Selection state inside an item. |
| `div[data-text]` | Duplicate label used to reserve width. |

The cloned item must update both visible text and `data-text`. GitHub's selected style is
bold, so changing only the visible text can shift the control when it becomes active.
Generated class names are intentionally not used.

## Toolbar fallback

If the view switch cannot be found, the baseline inserts Preview next to the Raw controls.
The toolbar also defines the boundary between the file header and the file body.

| Selector | Observation |
| --- | --- |
| `[data-testid="raw-button"]` | Preferred Raw anchor. |
| `[data-testid="copy-raw-button"]` | Raw toolbar fallback. |
| `[aria-label="Raw"]` | Semantic fallback. |

## File-content container

The matched content container is hidden and replaced by the preview iframe. The baseline
walks upward until the parent contains the toolbar, so line-number columns are hidden with
the code body instead of remaining below the preview.

| Selector | Role |
| --- | --- |
| `[data-testid="read-only-cursor-text-area"]` | Read-only source area. |
| `[data-testid="blob-viewer-file-content"]` | Blob viewer content fallback. |
| `.react-blob-view-header-sticky ~ section` | Layout fallback; verify after GitHub changes. |
| `#read-only-cursor-text-area` | Legacy id fallback. |

If no content container is found, the baseline uses a full-page overlay and emits a
console warning rather than silently doing nothing.

## Deliberately unused hooks

- GitHub-specific transition events such as `turbo:load`; URL comparison after DOM mutation
  is less coupled to undocumented event names.
- Embedded file payloads in the GitHub page; raw fetching provides one consistent source.
- MAIN-world scripts; the content script remains isolated from the page's JavaScript world.
