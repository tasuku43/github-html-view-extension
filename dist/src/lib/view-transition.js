/*
 * Define the GitHub file-view contract without touching the DOM.
 *
 * GitHub's Blob and Blame pages are different routes for the same file. Keeping the
 * route/view decision here gives the content controller one deterministic source of
 * truth while leaving GitHub-specific DOM work in github/dom.js.
 */
(function initViewTransition(global) {
  'use strict';

  const { blobUrl } = global.GHPREVIEW;

  const VIEWS = Object.freeze({
    PREVIEW: 'preview',
    CODE: 'code',
    BLAME: 'blame',
  });

  const ROUTES = Object.freeze({
    BLOB: 'blob',
    BLAME: 'blame',
    OTHER: 'other',
  });

  function unsupported(href) {
    return {
      href,
      supported: false,
      route: ROUTES.OTHER,
      selectedView: null,
      previewAvailable: false,
      renderPreview: false,
    };
  }

  /**
   * Describe the stable view state represented by a GitHub URL.
   *
   * The extension only owns HTML file views. A Blame page keeps Preview available but
   * does not render it; `?plain=1` selects Code while keeping the Preview control.
   */
  function inspect(href) {
    const file = blobUrl.parseFileUrl(href);
    if (file === null || !blobUrl.isHtmlPath(file.refAndPath)) {
      return unsupported(href);
    }

    if (file.view === ROUTES.BLAME) {
      return {
        href,
        supported: true,
        route: ROUTES.BLAME,
        selectedView: VIEWS.BLAME,
        previewAvailable: true,
        renderPreview: false,
      };
    }

    const renderPreview = blobUrl.shouldPreview(href);
    return {
      href,
      supported: true,
      route: ROUTES.BLOB,
      selectedView: renderPreview ? VIEWS.PREVIEW : VIEWS.CODE,
      previewAvailable: true,
      renderPreview,
    };
  }

  /** Build the canonical Code destination, including the Blame -> Blob transition. */
  function codeHref(href) {
    return blobUrl.sourceHref(blobUrl.previewHref(href));
  }

  function navigationAction(fromHref, destinationHref) {
    if (destinationHref === null) {
      return 'follow-github';
    }
    if (destinationHref === fromHref) {
      return 'noop';
    }
    const from = new URL(fromHref);
    const destination = new URL(destinationHref);
    return from.pathname === destination.pathname ? 'replace-state' : 'navigate';
  }

  function expectedFor(target) {
    if (target === VIEWS.PREVIEW) {
      return {
        route: ROUTES.BLOB,
        selectedView: VIEWS.PREVIEW,
        previewAvailable: true,
        renderPreview: true,
      };
    }
    if (target === VIEWS.CODE) {
      return {
        route: ROUTES.BLOB,
        selectedView: VIEWS.CODE,
        previewAvailable: true,
        renderPreview: false,
      };
    }
    return {
      route: ROUTES.BLAME,
      selectedView: VIEWS.BLAME,
      previewAvailable: true,
      renderPreview: false,
    };
  }

  /**
   * Plan a user-selected view without performing navigation.
   *
   * Blame navigation is intentionally delegated to GitHub's own link because its ref,
   * line anchors, and route details belong to GitHub. The resulting state is still part
   * of this contract, so the content controller can verify it after the SPA transition.
   */
  function plan(href, target) {
    const current = inspect(href);
    if (!current.supported || !Object.values(VIEWS).includes(target)) {
      return {
        target,
        current,
        action: 'ignore',
        destinationHref: null,
        expected: null,
      };
    }

    let destinationHref = null;
    if (target === VIEWS.PREVIEW) {
      destinationHref = blobUrl.previewHref(href);
    } else if (target === VIEWS.CODE) {
      destinationHref = codeHref(href);
    }

    return {
      target,
      current,
      action: navigationAction(href, destinationHref),
      destinationHref,
      expected: expectedFor(target),
    };
  }

  global.GHPREVIEW.viewTransition = {
    VIEWS,
    ROUTES,
    inspect,
    codeHref,
    plan,
  };
})(typeof window === 'undefined' ? globalThis : window);
