/*
 * Validate HTML before it crosses into the sandbox and prepare the small, safe
 * capability transformation that belongs to the content script.
 *
 * The product accepts self-contained documents only. Relative and external resources are
 * rejected; they are never fetched or inlined. Keeping that rule here prevents the
 * sandbox and the Worker from becoming an accidental resource loader.
 */
(function initInline(global) {
  'use strict';

  const CLASSIC_SCRIPT_TYPES = new Set([
    '',
    'text/javascript',
    'application/javascript',
    'text/ecmascript',
    'application/ecmascript',
  ]);

  const NETWORK_API = /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|Worker|SharedWorker)\b/;

  function addIssue(issues, code, message, location) {
    if (issues.some(issue => issue.message === message)) {
      return;
    }
    const issue = { code, message };
    if (location !== undefined && location !== null) {
      issue.location = location;
    }
    issues.push(issue);
  }

  function resourceIssueMessage(kind, label) {
    const subject = label || 'resources';
    if (kind === 'external') {
      return 'External ' + subject + ' are not supported.';
    }
    if (kind === 'relative') {
      return 'Relative ' + subject + ' are not supported.';
    }
    return 'Unsafe data URLs in ' + subject + ' are not supported.';
  }

  function sourceLocation(source, tag, attribute) {
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedAttribute = attribute
      ? attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      : null;
    const pattern = escapedAttribute
      ? new RegExp('<' + escapedTag + '\\b[^>]*\\b' + escapedAttribute + '\\b', 'i')
      : new RegExp('<' + escapedTag + '\\b', 'i');
    const match = pattern.exec(source);
    if (match === null) {
      return null;
    }
    const before = source.slice(0, match.index);
    return {
      line: before.split('\n').length,
      column: match.index - before.lastIndexOf('\n'),
      target: tag + (attribute ? '[' + attribute + ']' : ''),
    };
  }

  function resourceLocation(location, kind, label) {
    if (location === null || location === undefined) {
      return location;
    }
    return {
      ...location,
      detail: (kind === 'external' ? 'external ' : kind === 'relative' ? 'relative ' : 'unsafe ') + label,
    };
  }

  function isSafePassiveDataUrl(value) {
    return /^data:(?:image\/(?:png|jpe?g|gif|webp|avif|bmp)|audio\/(?:mpeg|ogg|wav|webm)|video\/(?:mp4|webm|ogg));(?:base64,|[^,]*,)/i.test(
      value,
    );
  }

  /**
   * Check whether a document can be sent to the sandbox.
   *
   * This is deliberately a reject-before-render check. Unsupported references never
   * reach the sandbox, which keeps policy failures deterministic and explainable.
   */
  function validateDocument(htmlText) {
    const source = typeof htmlText === 'string' ? htmlText : '';
    const issues = [];

    function inspectResource(value, passive, label, location) {
      if (typeof value !== 'string') {
        return;
      }
      const raw = value.trim();
      if (raw === '' || raw.startsWith('#')) {
        return;
      }
      if (/^data:/i.test(raw)) {
        if (!passive || !isSafePassiveDataUrl(raw)) {
          addIssue(
            issues,
            'unsafe-data-url',
            resourceIssueMessage('data', label),
            resourceLocation(location, 'data', label),
          );
        }
        return;
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) {
        addIssue(
          issues,
          'external-resource',
          resourceIssueMessage('external', label),
          resourceLocation(location, 'external', label),
        );
        return;
      }
      addIssue(
        issues,
        'relative-resource',
        resourceIssueMessage('relative', label),
        resourceLocation(location, 'relative', label),
      );
    }

    function inspectSrcset(value, label, location) {
      const raw = typeof value === 'string' ? value.trim() : '';
      if (raw.startsWith('data:')) {
        inspectResource(raw, true, label, location);
        return;
      }
      raw.split(',').forEach(part => {
        const candidate = part.trim().split(/\s+/, 1)[0];
        inspectResource(candidate, true, label, location);
      });
    }

    function inspectCss(cssText, location) {
      if (typeof cssText !== 'string') {
        return;
      }
      if (/@import\b/i.test(cssText)) {
        addIssue(issues, 'css-import', 'CSS @import is not supported.', location);
      }
      const urls = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
      let match;
      while ((match = urls.exec(cssText)) !== null) {
        inspectResource(match[2], true, 'CSS resources', location);
      }
    }

    function inspectScript(type, src, body, location) {
      const normalizedType = (type || '').trim().toLowerCase().split(';', 1)[0];
      if (normalizedType === 'module' || /\bimport\s*(?:\(|[\w{*])/u.test(body || '')) {
        addIssue(issues, 'module-script', 'Module scripts and dynamic imports are not supported.', location);
      }
      if (src !== null) {
        inspectResource(src, false, 'script sources', location);
      }
      if (NETWORK_API.test(body || '')) {
        addIssue(issues, 'network-api', 'Network APIs are not supported.');
      }
      if (normalizedType && normalizedType !== 'module' && !CLASSIC_SCRIPT_TYPES.has(normalizedType)) {
        addIssue(issues, 'unsupported-script', 'Only classic inline scripts are supported.');
      }
    }

    function inspectDangerousNavigation(value, location) {
      if (/^(?:javascript|vbscript|file|chrome|chrome-extension):/i.test((value || '').trim())) {
        addIssue(
          issues,
          'dangerous-navigation',
          'Dangerous navigation schemes are not supported.',
          location,
        );
      }
    }

    // DOMParser is available in the content script and gives us correct HTML attribute
    // handling. The text path keeps the policy unit-testable without adding a parser
    // dependency to the runtime.
    if (typeof global.DOMParser === 'function') {
      const doc = new global.DOMParser().parseFromString(source, 'text/html');
      Array.from(doc.querySelectorAll('*')).forEach(element => {
        const tag = element.tagName.toLowerCase();

        if (tag === 'link') {
          const linkLocation = sourceLocation(source, 'link');
          addIssue(issues, 'link-element', 'Link elements are not supported.', linkLocation);
          if (element.hasAttribute('href')) {
            inspectResource(
              element.getAttribute('href'),
              false,
              'stylesheet sources',
              sourceLocation(source, 'link', 'href'),
            );
          }
        }
        if (tag === 'iframe' || tag === 'object' || tag === 'embed') {
          addIssue(
            issues,
            'embedded-element',
            'Embedded frame elements are not supported.',
            sourceLocation(source, tag),
          );
        }
        if (tag === 'meta' && (element.getAttribute('http-equiv') || '').toLowerCase() === 'refresh') {
          addIssue(issues, 'meta-refresh', 'Meta refresh is not supported.', sourceLocation(source, 'meta'));
        }

        if (tag === 'script') {
          const scriptLocation = sourceLocation(
            source,
            'script',
            element.hasAttribute('src') ? 'src' : null,
          );
          inspectScript(
            element.getAttribute('type'),
            element.getAttribute('src'),
            element.textContent || '',
            scriptLocation,
          );
        } else if (tag === 'img' || tag === 'source' || tag === 'video' || tag === 'audio') {
          const sourceAttribute = tag === 'video' ? 'poster' : 'src';
          const sourceLabel = tag === 'img' ? 'image sources' : 'media sources';
          inspectResource(
            element.getAttribute(sourceAttribute),
            true,
            sourceLabel,
            sourceLocation(source, tag, sourceAttribute),
          );
          if (element.hasAttribute('srcset')) {
            inspectSrcset(
              element.getAttribute('srcset'),
              'responsive image sources',
              sourceLocation(source, tag, 'srcset'),
            );
          }
        }

        if (element.hasAttribute('style')) {
          inspectCss(element.getAttribute('style'), sourceLocation(source, tag, 'style'));
        }
        ['href', 'action', 'formaction'].forEach(attribute => {
          if (element.hasAttribute(attribute)) {
            inspectDangerousNavigation(
              element.getAttribute(attribute),
              sourceLocation(source, tag, attribute),
            );
          }
        });
      });
      Array.from(doc.querySelectorAll('style')).forEach(style =>
        inspectCss(style.textContent || '', sourceLocation(source, 'style')),
      );
    } else {
      // Small, conservative fallback for the dependency-free Node test environment.
      if (/<link\b/i.test(source)) {
        addIssue(issues, 'link-element', 'Link elements are not supported.', sourceLocation(source, 'link'));
      }
      if (/<(?:iframe|object|embed)\b/i.test(source)) {
        const embeddedTag = /<(iframe|object|embed)\b/i.exec(source);
        addIssue(
          issues,
          'embedded-element',
          'Embedded frame elements are not supported.',
          embeddedTag ? sourceLocation(source, embeddedTag[1]) : null,
        );
      }
      if (/<meta\b[^>]*http-equiv\s*=\s*["']?refresh\b/i.test(source)) {
        addIssue(issues, 'meta-refresh', 'Meta refresh is not supported.', sourceLocation(source, 'meta'));
      }
      const scripts = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
      let scriptMatch;
      while ((scriptMatch = scripts.exec(source)) !== null) {
        const attributes = scriptMatch[1];
        const typeMatch = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
        const srcMatch = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
        inspectScript(
          typeMatch ? typeMatch[1] || typeMatch[2] || typeMatch[3] : '',
          srcMatch ? srcMatch[1] || srcMatch[2] || srcMatch[3] : null,
          scriptMatch[2],
          sourceLocation(source, 'script', srcMatch ? 'src' : null),
        );
      }
      const resources = /<(img|source|video|audio)\b([^>]*)>/gi;
      let resourceMatch;
      while ((resourceMatch = resources.exec(source)) !== null) {
        const attributes = resourceMatch[2];
        ['src', 'poster', 'srcset'].forEach(attribute => {
          const match = new RegExp(
            `\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
            'i',
          ).exec(attributes);
          if (match) {
            const value = match[1] || match[2] || match[3];
            const location = sourceLocation(source, resourceMatch[1], attribute);
            const resourceLabel = resourceMatch[1] === 'img' ? 'image sources' : 'media sources';
            attribute === 'srcset'
              ? inspectSrcset(value, 'responsive image sources', location)
              : inspectResource(value, true, resourceLabel, location);
          }
        });
      }
      Array.from(source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)).forEach(match =>
        inspectCss(match[1], sourceLocation(source, 'style')),
      );
      if (/@import\b/i.test(source)) {
        addIssue(issues, 'css-import', 'CSS @import is not supported.');
      }
      if (/\b(?:href|action|formaction)\s*=\s*["']?(?:javascript|vbscript|file|chrome|chrome-extension):/i.test(source)) {
        addIssue(issues, 'dangerous-navigation', 'Dangerous navigation schemes are not supported.');
      }
    }

    return { valid: issues.length === 0, issues };
  }

  global.GHPREVIEW = global.GHPREVIEW || {};
  global.GHPREVIEW.inline = {
    validateDocument,
  };
})(typeof window === 'undefined' ? globalThis : window);
