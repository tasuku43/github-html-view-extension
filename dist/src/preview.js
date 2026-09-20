/*
 * Orchestrate timing, fetching, and delivery to the opaque-origin sandbox.
 *
 * Decisions live in lib/, and GitHub DOM integration lives in github/dom.js. This file
 * owns the sequence only.
 */
(function initPreview(global) {
  'use strict';

  const { blobUrl, allowlist, githubDom } = global.GHPREVIEW;

  const PREFIX = 'ghpreview:';
  const RENDER = PREFIX + 'render';
  const READY = PREFIX + 'sandbox-ready';
  const HEIGHT = PREFIX + 'height';
  const ALLOWLIST_KEY = 'allowlist';

  // After an extension reload, an existing tab's content script can no longer use the
  // chrome API. After one failure, stop touching the extension API.
  let extensionAlive = true;

  function storageGet(key) {
    return new Promise(resolve => {
      if (!extensionAlive) {
        resolve(undefined);
        return;
      }
      try {
        chrome.storage.local.get(key, stored => {
          try {
            resolve(chrome.runtime.lastError ? undefined : stored[key]);
          } catch (error) {
            extensionAlive = false;
            resolve(undefined);
          }
        });
      } catch (error) {
        extensionAlive = false;
        resolve(undefined);
      }
    });
  }

  function ask(message) {
    return new Promise(resolve => {
      if (!extensionAlive) {
        resolve(null);
        return;
      }
      try {
        chrome.runtime.sendMessage(message, reply => {
          try {
            resolve(chrome.runtime.lastError ? null : reply);
          } catch (error) {
            extensionAlive = false;
            resolve(null);
          }
        });
      } catch (error) {
        extensionAlive = false;
        resolve(null);
      }
    });
  }

  /**
   * Delegate fetching to the service worker.
   *
   * Fetching directly from the content script hits CORS after `/raw/` redirects to a
   * different host. The extension worker can follow the redirect within host_permissions
   * (see MODEL.md).
   */
  const cache = new Map();

  function load(url) {
    if (cache.has(url)) {
      return cache.get(url);
    }
    const pending = ask({ type: PREFIX + 'fetch', url }).then(reply => {
      if (reply === null || !reply.ok) {
        return null;
      }
      return {
        text: reply.text,
        dataUri: global.GHPREVIEW.inline.dataUri(reply.contentType, reply.base64),
        contentType: reply.contentType,
      };
    });
    cache.set(url, pending);
    return pending;
  }

  // ---- Current page behavior ------------------------------------------------

  let rendered = null;

  /*
   * Remember the intent to view source across a GitHub view transition. This is needed
   * when Code is selected from Blame; onLeavePreview explains why.
   */
  const INTENT_MS = 1500;
  let wantsSourceUntil = 0;

  /**
   * Check whether the extension is enabled for this page. When it is enabled, fetch early.
   *
   * Reading the allowlist is asynchronous, so callers can reuse the result while the page
   * remains unchanged.
   */
  async function isEnabled(parsed) {
    const entries = allowlist.parseAllowlist(await storageGet(ALLOWLIST_KEY));
    return allowlist.isAllowed(blobUrl.repoKey(parsed), entries);
  }

  async function apply() {
    // Accept Blame too. It shows the same file, so Preview remains available.
    const file = blobUrl.parseFileUrl(location.href);
    if (file === null || !blobUrl.isHtmlPath(file.refAndPath)) {
      teardown();
      return;
    }
    if (!(await isEnabled(file))) {
      teardown();
      return;
    }

    githubDom.ensureStyle(chrome.runtime.getURL('ui.css'));
    githubDom.insertPreviewLink({
      onPreview: () => {
        // The latest explicit click wins; do not bounce back because of a previous Code click.
        wantsSourceUntil = 0;
        go(blobUrl.previewHref(location.href));
      },
    });

    // Blame is a source-oriented view. Keep Preview visible but unselected.
    const wantsPreview = file.view === 'blob' && blobUrl.shouldPreview(location.href);

    // Arriving at Blame completes the carried intent.
    if (file.view === 'blame') {
      wantsSourceUntil = 0;
    }

    // GitHub can arrive here without the query after Code is selected from Blame. Add
    // `?plain=1` or the default preview would open again.
    if (wantsPreview && Date.now() < wantsSourceUntil) {
      wantsSourceUntil = 0;
      go(blobUrl.sourceHref(location.href));
      return;
    }

    githubDom.markPreviewSelected(wantsPreview);

    if (!wantsPreview) {
      unmount();
      return;
    }
    // Mount before fetching. If the container is not available yet, the call is a no-op
    // and the mutation observer will retry when GitHub inserts it.
    openFrame(chrome.runtime.getURL('sandbox.html'));

    if (rendered === location.href) {
      return;
    }
    rendered = location.href;
    await render(file);
  }

  /*
   * Switch views by updating the URL and applying the current page again.
   *
   * Update the observed URL at the same time. Otherwise iframe insertion can look like a
   * navigation and trigger a remove-and-remount loop.
   */
  function go(href) {
    // Blame to Preview changes the page path; let GitHub rebuild that view.
    if (new URL(href).pathname !== location.pathname) {
      location.href = href;
      return;
    }
    history.replaceState(null, '', href);
    seen = location.href;
    apply();
  }

  /*
   * Remove the current preview.
   *
   * Do not rely only on local markers. They are memory rather than page state and can be
   * cleared during a transition, leaving the previous preview mounted. Always ask the DOM
   * layer to remove it; redundant removal is harmless.
   */
  function unmount() {
    rendered = null;
    handover.frame = null;
    handover.ready = false;
    handover.html = null;
    dropFrameListeners();
    githubDom.removeFrame();
  }

  function teardown() {
    unmount();
    githubDom.removePreviewLink();
  }

  async function render(parsed) {
    const source = await load(blobUrl.rawUrl(parsed));
    if (source === null) {
      githubDom.warn('fetch-source', 'Could not fetch file: ' + blobUrl.rawUrl(parsed));
      // Do not leave the source hidden when it cannot be loaded.
      unmount();
      return;
    }

    const built = await githubDom.inlineDocument(
      source.text,
      blobUrl.resolutionBase(parsed),
      load,
    );
    // Report each note once by content. An index-based key could hide a different note
    // when a new document uses the same position.
    built.notes.forEach(note => githubDom.warn('note:' + note, note));

    // Do not render if navigation happened while the document was being prepared.
    if (rendered !== location.href) {
      return;
    }

    handover.html = built.html;
    openFrame(chrome.runtime.getURL('sandbox.html'));
    flush();
  }

  /*
   * Coordinate the document and its receiver; either may become ready first.
   *
   * The iframe is mounted first, so sandbox-ready can arrive before the document. Send
   * only after both sides are ready.
   */
  const handover = { frame: null, ready: false, html: null };

  function openFrame(sandboxUrl) {
    const mounted = githubDom.mountFrame(sandboxUrl);
    if (!mounted.created) {
      return;
    }
    handover.frame = mounted.frame;
    handover.ready = false;
    listen(mounted.frame);
  }

  function flush() {
    if (handover.frame === null || !handover.ready || handover.html === null) {
      return;
    }
    const html = handover.html;
    handover.html = null;
    handover.frame.contentWindow.postMessage({ type: RENDER, html }, '*');
  }

  /**
   * Send the document to the opaque-origin sandbox.
   *
   * The sandbox has an opaque `null` origin, so identify it with `event.source`. Send only
   * to the frame's window.
   */
  function listen(frame) {
    function onMessage(event) {
      if (event.source !== frame.contentWindow) {
        return;
      }
      if (!event.data) {
        return;
      }
      if (event.data.type === READY) {
        handover.ready = true;
        flush();
        return;
      }
      // Resize to the document height so the iframe does not create a second scrollbar.
      if (event.data.type === HEIGHT) {
        githubDom.resizeFrame(event.data.height);
      }
    }
    window.addEventListener('message', onMessage);
    // Remove the listener during unmount; otherwise every remount adds another listener.
    frameListeners.push(onMessage);
  }

  const frameListeners = [];

  function dropFrameListeners() {
    while (frameListeners.length > 0) {
      window.removeEventListener('message', frameListeners.pop());
    }
  }

  // ---- GitHub navigation ---------------------------------------------------

  /*
   * GitHub replaces DOM regions while changing the URL. Its transition event names are
   * not a stable extension contract, so compare the URL after DOM mutations.
   */
  let seen = location.href;
  let timer = null;

  function onMutated() {
    if (timer !== null) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      if (location.href !== seen) {
        seen = location.href;
        // Clear the previous page before applying the new one, including restoring hidden
        // source content.
        unmount();
        githubDom.removePreviewLink();
      }
      apply();
    }, 150);
  }

  new MutationObserver(onMutated).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  window.addEventListener('hashchange', () => {
    seen = location.href;
    apply();
  });

  /*
   * When Code or Blame is selected, switch toward the source view. The query may not
   * change, so apply `?plain=1` explicitly; Blame navigation is handled as a URL change.
   */
  /*
   * Fetch as early as possible. Waiting for GitHub to finish building the page would leave
   * the source visible longer.
   *
   * The result is cached, so render can reuse the completed request or an in-flight one.
   */
  (async function prefetch() {
    const parsed = blobUrl.parseBlobUrl(location.href);
    if (
      parsed === null ||
      !blobUrl.isHtmlPath(parsed.refAndPath) ||
      !blobUrl.shouldPreview(location.href)
    ) {
      return;
    }
    if (await isEnabled(parsed)) {
      load(blobUrl.rawUrl(parsed));
    }
  })();

  githubDom.onLeavePreview(() => {
    if (blobUrl.parseBlobUrl(location.href) === null) {
      return;
    }
    go(blobUrl.sourceHref(location.href));
  });

  apply();
})(window);
