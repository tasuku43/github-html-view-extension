/*
 * Decide how to handle subresources.
 *
 * An opaque origin cannot resolve relative references. CSS, JavaScript, and images must
 * be fetched and folded into one HTML document before rendering (MODEL.md).
 *
 * This file knows neither the DOM nor fetch. It decides what to do with a reference;
 * github/dom.js and preview.js perform the loading and replacement. Keeping the decision
 * separate makes it easy to lock down with tests.
 */
(function initInline(global) {
  'use strict';

  /**
   * Resources to inline and how to replace them.
   *
   *   select    ... selector used to find elements
   *   attribute ... attribute containing the reference
   *   as        ... replacement type
   *                 css    ... rewrite as a <style> element, including url()
   *                 js     ... place the text inside a <script> element
   *                 binary ... replace the attribute with a data URI
   *
   * Compare additions against the exclusions in GOAL.md.
   */
  const RULES = [
    { select: 'link[rel~="stylesheet"][href]', attribute: 'href', as: 'css' },
    { select: 'script[src]', attribute: 'src', as: 'js' },
    { select: 'img[src]', attribute: 'src', as: 'binary' },
    { select: 'img[srcset]', attribute: 'srcset', as: 'srcset' },
    { select: 'source[src]', attribute: 'src', as: 'binary' },
    { select: 'video[poster]', attribute: 'poster', as: 'binary' },
    { select: 'audio[src]', attribute: 'src', as: 'binary' },
  ];

  /**
   * Classify a reference.
   *
   *   inline      ... same repository; fetch and inline it
   *   external    ... external absolute URL; leave it untouched
   *   skip        ... nothing to inline (empty, fragment, or data URL)
   *   unsupported ... resolvable but intentionally not handled; return a reason
   *
   * Root-absolute paths such as `/assets/x.css` are unsupported because the URL does not
   * say whether they refer to the repository root or the site root. Resolving them as a
   * repository path would require splitting ref and path, which blob-url.js deliberately
   * avoids. Guessing could silently fetch the wrong file.
   */
  function classify(value, base) {
    if (typeof value !== 'string') {
      return { kind: 'skip' };
    }
    const raw = value.trim();
    if (raw === '' || raw.startsWith('#')) {
      return { kind: 'skip' };
    }
    if (/^(data|blob|about|javascript):/i.test(raw)) {
      return { kind: 'skip' };
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) {
      return { kind: 'external' };
    }
    if (raw.startsWith('/')) {
      return {
        kind: 'unsupported',
        reason: 'Root-absolute paths are not resolved because the repository and site roots are ambiguous',
      };
    }
    let resolved;
    try {
      resolved = new URL(raw, base);
    } catch (error) {
      return { kind: 'skip' };
    }
    // Do not fetch a path that escapes the repository through `../`.
    if (!resolved.href.startsWith(repoRoot(base))) {
      return {
        kind: 'unsupported',
        reason: 'Reference escapes the repository: ' + raw,
      };
    }
    return { kind: 'inline', url: resolved.href };
  }

  /**
   * Return the allowed fetch prefix: `https://github.com/{owner}/{repo}/raw/`.
   * Do not restrict below ref because blob-url.js intentionally keeps ref and path together.
   */
  function repoRoot(base) {
    const url = new URL(base);
    const parts = url.pathname.split('/');
    // ['', owner, repo, 'raw', ...]
    return url.origin + '/' + parts[1] + '/' + parts[2] + '/raw/';
  }

  function dataUri(contentType, base64) {
    return 'data:' + (contentType || 'application/octet-stream') + ';base64,' + base64;
  }

  // CSS url(...), with optional quotes around the value.
  const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

  /**
   * Rewrite url() references inside CSS.
   *
   * @import is intentionally unsupported (GOAL.md). Unresolved references are returned
   * in notes so the caller can report them.
   */
  async function rewriteCssUrls(cssText, base, load) {
    const found = [];
    cssText.replace(CSS_URL, (whole, quote, value) => {
      found.push({ whole, value });
      return whole;
    });

    const notes = [];
    const replacements = new Map();
    for (const item of found) {
      if (replacements.has(item.whole)) {
        continue;
      }
      const decided = classify(item.value, base);
      if (decided.kind !== 'inline') {
        if (decided.kind === 'unsupported') {
          notes.push(decided.reason);
        }
        continue;
      }
      const loaded = await load(decided.url);
      if (loaded === null) {
        notes.push('Could not load reference: ' + item.value);
        continue;
      }
      replacements.set(item.whole, 'url("' + loaded + '")');
    }

    let text = cssText;
    replacements.forEach((to, from) => {
      text = text.split(from).join(to);
    });
    return { text, notes };
  }

  /**
   * Rewrite the URLs in `URL descriptor, URL descriptor` srcset values while preserving
   * the descriptors.
   */
  async function rewriteSrcset(value, base, load) {
    const notes = [];
    const parts = value.split(',');
    const rewritten = [];
    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed === '') {
        continue;
      }
      const space = trimmed.search(/\s/);
      const url = space === -1 ? trimmed : trimmed.slice(0, space);
      const descriptor = space === -1 ? '' : trimmed.slice(space);
      const decided = classify(url, base);
      if (decided.kind !== 'inline') {
        if (decided.kind === 'unsupported') {
          notes.push(decided.reason);
        }
        rewritten.push(trimmed);
        continue;
      }
      const loaded = await load(decided.url);
      if (loaded === null) {
        notes.push('Could not load reference: ' + url);
        rewritten.push(trimmed);
        continue;
      }
      rewritten.push(loaded + descriptor);
    }
    return { value: rewritten.join(', '), notes };
  }

  /**
   * Escape `</script>` before writing inlined JavaScript so the containing element cannot
   * close early.
   */
  function escapeScriptText(text) {
    return text.replace(/<\/(script)/gi, '<\\/$1');
  }

  global.GHPREVIEW = global.GHPREVIEW || {};
  global.GHPREVIEW.inline = {
    RULES,
    classify,
    repoRoot,
    dataUri,
    rewriteCssUrls,
    rewriteSrcset,
    escapeScriptText,
  };
})(typeof window === 'undefined' ? globalThis : window);
