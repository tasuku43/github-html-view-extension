/*
 * Read and write GitHub file URLs.
 *
 * This module knows neither the DOM nor chrome APIs. It only handles strings and URLs.
 *
 * The important rule here is that ref and path are not split. The part after `blob/` is
 * `{ref}/{path}`, but branch names can contain slashes such as `feature/foo`, so the
 * boundary cannot be inferred from the URL. Calling the GitHub API would add an
 * unnecessary authorization dependency.
 *
 * Instead, keep the suffix as one string and replace `blob` with `raw`. GitHub resolves
 * both forms using the same rules, so the correct target is preserved without knowing
 * the boundary. Relative references can then use normal URL resolution (inline.js).
 */
(function initBlobUrl(global) {
  'use strict';

  const ORIGIN = 'https://github.com';
  // Blob and blame are two views of the same file and share the same URL shape.
  const FILE = /^\/([^/]+)\/([^/]+)\/(blob|blame)\/(.+)$/;

  /**
   * Return file information for a file view, or null for other pages.
   *
   * Blame is accepted so **Preview remains available while Blame is open**, matching
   * GitHub's Markdown behavior. Rendering only happens for blob, which is handled by
   * parseBlobUrl.
   *
   * The returned `refAndPath` deliberately keeps ref and path together.
   */
  function parseFileUrl(href) {
    let url;
    try {
      url = new URL(href);
    } catch (error) {
      return null;
    }
    if (url.origin !== ORIGIN) {
      return null;
    }
    const matched = FILE.exec(url.pathname);
    if (matched === null) {
      return null;
    }
    const refAndPath = matched[4];
    if (refAndPath === '') {
      return null;
    }
    return {
      owner: decodeURIComponent(matched[1]),
      repo: decodeURIComponent(matched[2]),
      view: matched[3],
      refAndPath: refAndPath,
    };
  }

  /** Return a renderable view only for blob pages. */
  function parseBlobUrl(href) {
    const parsed = parseFileUrl(href);
    return parsed === null || parsed.view !== 'blob' ? null : parsed;
  }

  /** Return the allowlist key: `owner/name`. */
  function repoKey(parsed) {
    return parsed.owner + '/' + parsed.repo;
  }

  /**
   * Build the content URL.
   *
   * Display parameters such as `?plain=1` are not included because this URL requests
   * the file itself rather than GitHub's presentation.
   */
  function rawUrl(parsed) {
    return ORIGIN + '/' + parsed.owner + '/' + parsed.repo + '/raw/' + parsed.refAndPath;
  }

  /**
   * Return the base URL for relative references, including the file name. It is intended
   * for calls such as `new URL('./a.css', base)`.
   */
  function resolutionBase(parsed) {
    return rawUrl(parsed);
  }

  /**
   * Check whether a path is an HTML file.
   *
   * Use the extension alone. Inspecting content could unexpectedly render files such as
   * `.txt` that the user intended to read as source.
   */
  function isHtmlPath(refAndPath) {
    const withoutQuery = refAndPath.split(/[?#]/)[0];
    return /\.x?html?$/i.test(withoutQuery);
  }

  /*
   * Put the view selection in the URL, following GitHub's Markdown behavior.
   * （`notes/decision-view-switch.md`）。
   *
   *   No query  ... preview (default)
   *   `?plain=1` ... source
   *
   * Do not invent a custom fragment. `?plain=1` has an established meaning, works in
   * links, and is less likely to conflict if GitHub adds native HTML preview support.
   *
   * Treat `#preview` URLs as preview requests so existing links keep working.
   */
  const PREVIEW_HASH = '#preview';
  const PLAIN = 'plain';

  /** Check whether the source view was requested. */
  function isPlainRequested(href) {
    try {
      return new URL(href).searchParams.get(PLAIN) === '1';
    } catch (error) {
      return false;
    }
  }

  /**
   * Check whether the current URL should render.
   *
   * > This is not a security boundary. It only controls surprise behavior; the allowlist
   * > and opaque origin provide the security boundary. With preview as the default, the
   * > adjacent Code control is what lets users switch back (MODEL.md).
   */
  function shouldPreview(href) {
    return !isPlainRequested(href);
  }

  /**
   * Build the destination when Preview is selected by removing `?plain=1`.
   *
   * Convert Blame to blob because both views represent the same file and the user is
   * asking for a preview of that file.
   */
  function previewHref(href) {
    const url = new URL(href);
    url.pathname = url.pathname.replace(/^(\/[^/]+\/[^/]+)\/blame\//, '$1/blob/');
    url.searchParams.delete(PLAIN);
    url.hash = '';
    return url.href;
  }

  /** Build the Code destination using GitHub's `?plain=1` convention. */
  function sourceHref(href) {
    const url = new URL(href);
    url.searchParams.set(PLAIN, '1');
    url.hash = '';
    return url.href;
  }

  global.GHPREVIEW = global.GHPREVIEW || {};
  global.GHPREVIEW.blobUrl = {
    parseFileUrl,
    parseBlobUrl,
    repoKey,
    rawUrl,
    resolutionBase,
    isHtmlPath,
    isPlainRequested,
    shouldPreview,
    previewHref,
    sourceHref,
    PREVIEW_HASH,
  };
})(typeof window === 'undefined' ? globalThis : window);
