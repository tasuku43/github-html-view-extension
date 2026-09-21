/*
 * Validate HTML before it crosses into the sandbox and prepare the small, safe
 * capability transformation that belongs to the content script.
 *
 * Repository-relative resources are resolved by the content controller before a document
 * crosses into the sandbox. This module validates the references and owns the deterministic
 * rewrite used to turn supported repository dependencies into local document resources.
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
      return 'External ' + subject + ' are not supported; use repository-relative resources.';
    }
    if (kind === 'relative') {
      return 'Relative ' + subject + ' must be resolved before rendering.';
    }
    if (kind === 'root-relative') {
      return 'Root-relative ' + subject + ' are not supported because the repository ref is ambiguous.';
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
      detail:
        (kind === 'external'
          ? 'external '
          : kind === 'relative'
            ? 'relative '
            : kind === 'root-relative'
              ? 'root-relative '
              : 'unsafe ') + label,
    };
  }

  function isSafePassiveDataUrl(value) {
    const match = /^data:([^;,]+)(?:;[^,]*)?,([\s\S]*)$/i.exec(value);
    if (match === null) {
      return false;
    }
    const mime = match[1].toLowerCase();
    const allowed = /^(?:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml)|audio\/(?:mpeg|ogg|wav|webm)|video\/(?:mp4|webm|ogg)|font\/(?:woff|woff2|ttf|otf)|application\/(?:font-woff|font-woff2|vnd\.ms-opentype|vnd\.ms-fontobject|x-font-ttf|x-font-opentype))$/i.test(
      mime,
    );
    if (!allowed) {
      return false;
    }
    if (mime === 'image/svg+xml') {
      let source = match[2];
      try {
        if (/^base64$/i.test((value.match(/^data:[^;]+;([^,]+),/i) || [])[1] || '')) {
          source = typeof global.atob === 'function' ? global.atob(source) : source;
        } else {
          source = decodeURIComponent(source);
        }
      } catch (error) {
        return false;
      }
      return isSafeSvgText(source);
    }
    return true;
  }

  function isSafeSvgText(source) {
    if (typeof source !== 'string') {
      return false;
    }
    return !/(?:<\s*script\b|<\s*(?:iframe|object|embed)\b|\bon[a-z]+\s*=|(?:javascript|vbscript|file|chrome|chrome-extension):|@import\b|url\(\s*(?!#)[^)]+\)|\b(?:href|xlink:href|src)\s*=\s*["']?(?!#)[^"'\s>]+)/i.test(
      source,
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
      if (raw.startsWith('/')) {
        addIssue(
          issues,
          'root-relative-resource',
          resourceIssueMessage('root-relative', label),
          resourceLocation(location, 'root-relative', label),
        );
        return;
      }
      // Repository-relative resources are resolved and inlined after this structural
      // validation step. Do not reject them merely because they are not data URLs.
      return;
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
        const imports = /@import\s+(?:url\(\s*)?(?:['"]([^'"]+)['"]|([^)'\s;]+))\s*\)?/gi;
        let importMatch;
        while ((importMatch = imports.exec(cssText)) !== null) {
          inspectResource(
            importMatch[1] || importMatch[2],
            false,
            'stylesheet imports',
            location,
          );
        }
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
          const rel = (element.getAttribute('rel') || '').toLowerCase().split(/\s+/).filter(Boolean);
          if (!rel.includes('stylesheet') || !element.hasAttribute('href')) {
            addIssue(issues, 'link-element', 'Only stylesheet link elements are supported.', linkLocation);
          } else {
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
        if (tag === 'base') {
          addIssue(issues, 'base-element', 'Base elements are not supported.', sourceLocation(source, 'base'));
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
          const sourceLabel = tag === 'img' ? 'image sources' : 'media sources';
          ['src', ...(tag === 'video' ? ['poster'] : [])].forEach(sourceAttribute => {
            inspectResource(
              element.getAttribute(sourceAttribute),
              true,
              sourceLabel,
              sourceLocation(source, tag, sourceAttribute),
            );
          });
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
      if (/<link\b/i.test(source) && !/<link\b[^>]*\brel\s*=\s*["'][^"']*\bstylesheet\b/i.test(source)) {
        addIssue(issues, 'link-element', 'Only stylesheet link elements are supported.', sourceLocation(source, 'link'));
      }
      if (/<base\b/i.test(source)) {
        addIssue(issues, 'base-element', 'Base elements are not supported.', sourceLocation(source, 'base'));
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
      if (/\b(?:href|action|formaction)\s*=\s*["']?(?:javascript|vbscript|file|chrome|chrome-extension):/i.test(source)) {
        addIssue(issues, 'dangerous-navigation', 'Dangerous navigation schemes are not supported.');
      }
    }

    return { valid: issues.length === 0, issues };
  }

  const RESOURCE_LIMITS = Object.freeze({
    maxResources: 64,
    maxBytes: 16 * 1024 * 1024,
    maxCssImportDepth: 8,
  });

  function repositoryRawPrefix(value) {
    try {
      const url = new URL(value);
      if (url.origin !== 'https://github.com') {
        return null;
      }
      const match = /^\/[^/]+\/[^/]+\/raw\//.exec(url.pathname);
      return match === null ? null : match[0];
    } catch (error) {
      return null;
    }
  }

  /**
   * Resolve a dependency without allowing the preview to become an arbitrary URL loader.
   * The raw GitHub URL is the base so branch, tag, and commit paths stay tied to the file
   * being viewed. Root-relative references are rejected because their ref boundary is
   * ambiguous in GitHub's raw URL format.
   */
  function resolveRepositoryUrl(reference, baseUrl) {
    const raw = typeof reference === 'string' ? reference.trim() : '';
    if (raw === '' || raw.startsWith('#')) {
      return { ok: true, kind: 'fragment', url: raw };
    }
    if (/^data:/i.test(raw)) {
      return isSafePassiveDataUrl(raw)
        ? { ok: true, kind: 'data', url: raw }
        : { ok: false, code: 'unsafe-data-url' };
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) {
      return { ok: false, code: 'external-resource' };
    }
    if (raw.startsWith('/')) {
      return { ok: false, code: 'root-relative-resource' };
    }

    let resolved;
    try {
      resolved = new URL(raw, baseUrl);
    } catch (error) {
      return { ok: false, code: 'invalid-resource-reference' };
    }
    if (resolved.origin !== 'https://github.com') {
      return { ok: false, code: 'external-resource' };
    }
    if (repositoryRawPrefix(resolved.href) === null) {
      return { ok: false, code: 'repository-boundary-escaped' };
    }
    resolved.hash = '';
    return { ok: true, kind: 'repository', url: resolved.href };
  }

  function resourceLabel(kind) {
    switch (kind) {
      case 'stylesheet':
        return 'stylesheet';
      case 'script':
        return 'classic script';
      case 'font':
        return 'font';
      case 'image':
        return 'image';
      case 'media':
        return 'media resource';
      default:
        return 'resource';
    }
  }

  function extensionOf(value) {
    try {
      const pathname = new URL(value, 'https://github.com/').pathname;
      return pathname.toLowerCase().split('.').pop() || '';
    } catch (error) {
      return '';
    }
  }

  function guessedMime(value, kind) {
    const extension = extensionOf(value);
    const map = {
      css: 'text/css',
      js: 'text/javascript',
      mjs: 'text/javascript',
      svg: 'image/svg+xml',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      avif: 'image/avif',
      bmp: 'image/bmp',
      ico: 'image/x-icon',
      woff: 'font/woff',
      woff2: 'font/woff2',
      ttf: 'font/ttf',
      otf: 'font/otf',
      eot: 'application/vnd.ms-fontobject',
      mp3: 'audio/mpeg',
      ogg: 'audio/ogg',
      wav: 'audio/wav',
      mp4: 'video/mp4',
      webm: 'video/webm',
    };
    if (map[extension]) {
      return map[extension];
    }
    if (kind === 'stylesheet') {
      return 'text/css';
    }
    if (kind === 'script') {
      return 'text/javascript';
    }
    return 'application/octet-stream';
  }

  function normalizedMime(value) {
    return typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
  }

  function resourceMode(value, kind) {
    if (kind === 'stylesheet' || kind === 'script') {
      return 'text';
    }
    return /\.svg(?:$|[?#])/i.test(value) ? 'text' : 'base64';
  }

  function safeResourceMime(mime, kind, reference) {
    const declared = normalizedMime(mime);
    const fallback = guessedMime(reference, kind);
    const value = declared === '' || declared === 'application/octet-stream'
      ? fallback
      : declared;
    if (kind === 'stylesheet') {
      return value === 'text/css' || value === 'text/plain' ? 'text/css' : null;
    }
    if (kind === 'script') {
      return /^(?:text|application)\/(?:java|ecma)script$/.test(value) || value === 'text/plain'
        ? 'text/javascript'
        : null;
    }
    if (kind === 'font') {
      return /^(?:font\/(?:woff|woff2|ttf|otf)|application\/(?:font-woff|font-woff2|vnd\.ms-opentype|vnd\.ms-fontobject|x-font-ttf|x-font-opentype))$/i.test(
        value,
      )
        ? value
        : null;
    }
    if (/^image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml)$|^audio\/(?:mpeg|ogg|wav|webm)$|^video\/(?:mp4|webm|ogg)$/i.test(value)) {
      return value;
    }
    if (
      declared !== fallback &&
      /^text\/plain$/i.test(declared) &&
      /^(?:image|audio|video|font)\//i.test(fallback)
    ) {
      return fallback;
    }
    return null;
  }

  function safeSvgText(source) {
    return isSafeSvgText(source);
  }

  function textDataUrl(mime, source) {
    return 'data:' + mime + ';charset=utf-8,' + encodeURIComponent(source);
  }

  function binaryDataUrl(mime, source) {
    return 'data:' + mime + ';base64,' + source;
  }

  function resolutionIssue(context, code, message, location) {
    addIssue(context.issues, code, message, location);
  }

  function fetchIssue(context, kind, location, errorCode = null) {
    const suffix = errorCode === 'payload-too-large'
      ? ' The resource is too large.'
      : errorCode === 'http-error'
        ? ' GitHub did not return the resource.'
        : '';
    resolutionIssue(
      context,
      'resource-resolution-failed',
      'The repository ' + resourceLabel(kind) + ' could not be resolved safely.' + suffix,
      location,
    );
  }

  function classifyCssResource(reference) {
    const extension = extensionOf(reference);
    if (['woff', 'woff2', 'ttf', 'otf', 'eot'].includes(extension)) {
      return 'font';
    }
    if (['mp3', 'ogg', 'wav', 'mp4', 'webm'].includes(extension)) {
      return 'media';
    }
    return 'image';
  }

  async function resolveResources(htmlText, baseUrl, fetchResource, options = {}) {
    if (typeof global.DOMParser !== 'function') {
      return {
        valid: false,
        html: htmlText,
        issues: [{ code: 'resource-resolution-failed', message: 'The browser parser is unavailable.' }],
        resourceCount: 0,
        byteCount: 0,
      };
    }
    const doc = new global.DOMParser().parseFromString(typeof htmlText === 'string' ? htmlText : '', 'text/html');
    const context = {
      issues: [],
      resourceCount: 0,
      byteCount: 0,
      cache: new Map(),
      maxResources: Number.isInteger(options.maxResources) ? options.maxResources : RESOURCE_LIMITS.maxResources,
      maxBytes: Number.isInteger(options.maxBytes) ? options.maxBytes : RESOURCE_LIMITS.maxBytes,
      maxCssImportDepth: Number.isInteger(options.maxCssImportDepth)
        ? options.maxCssImportDepth
        : RESOURCE_LIMITS.maxCssImportDepth,
    };

    async function request(reference, parentUrl, kind, location, mode = resourceMode(reference, kind)) {
      const resolved = resolveRepositoryUrl(reference, parentUrl);
      if (!resolved.ok) {
        const message = resolved.code === 'external-resource'
          ? 'External ' + resourceLabel(kind) + 's are not supported; use repository-relative resources.'
          : resolved.code === 'root-relative-resource'
            ? 'Root-relative ' + resourceLabel(kind) + 's are not supported because the repository ref is ambiguous.'
            : 'The repository ' + resourceLabel(kind) + ' reference is not valid.';
        resolutionIssue(context, resolved.code, message, location);
        return null;
      }
      if (resolved.kind === 'fragment') {
        return { inline: false, url: resolved.url };
      }
      if (resolved.kind === 'data') {
        if (kind === 'stylesheet' || kind === 'script') {
          resolutionIssue(context, 'unsafe-data-url', 'Data URLs are not supported for active resources.', location);
          return null;
        }
        return { inline: true, dataUrl: resolved.url };
      }

      const key = mode + ':' + resolved.url;
      if (context.cache.has(key)) {
        return context.cache.get(key);
      }
      if (context.resourceCount >= context.maxResources) {
        resolutionIssue(context, 'resource-limit', 'The preview uses too many repository resources.', location);
        return null;
      }
      context.resourceCount += 1;

      const pending = Promise.resolve()
        .then(() => fetchResource(resolved.url, { kind, mode }))
        .then(resource => {
          if (!resource || resource.ok === false) {
            fetchIssue(context, kind, location, resource && resource.errorCode);
            return null;
          }
          const size = Number.isFinite(resource.byteLength)
            ? resource.byteLength
            : typeof resource.text === 'string'
              ? resource.text.length
              : 0;
          context.byteCount += size;
          if (context.byteCount > context.maxBytes) {
            resolutionIssue(context, 'resource-limit', 'The repository resources are too large to preview.', location);
            return null;
          }
          return { inline: true, resource, url: resolved.url };
        })
        .catch(error => {
          fetchIssue(context, kind, location, 'fetch-failed');
          return null;
        });
      context.cache.set(key, pending);
      return pending;
    }

    function resourceData(reference, result, kind) {
      if (!result || !result.inline) {
        return null;
      }
      if (result.dataUrl) {
        return { dataUrl: result.dataUrl };
      }
      const resource = result.resource || {};
      const mime = safeResourceMime(resource.contentType, kind, reference);
      if (mime === null) {
        resolutionIssue(context, 'unsupported-resource-type', 'The repository ' + resourceLabel(kind) + ' type is not supported.', null);
        return null;
      }
      if (resourceMode(reference, kind) === 'text') {
        if (typeof resource.text !== 'string') {
          resolutionIssue(context, 'resource-resolution-failed', 'The repository ' + resourceLabel(kind) + ' could not be read.', null);
          return null;
        }
        if (mime === 'image/svg+xml' && !safeSvgText(resource.text)) {
          resolutionIssue(context, 'unsafe-resource', 'The repository SVG contains unsupported active content.', null);
          return null;
        }
        return { mime, text: resource.text, dataUrl: textDataUrl(mime, resource.text) };
      }
      if (typeof resource.data !== 'string') {
        resolutionIssue(context, 'resource-resolution-failed', 'The repository ' + resourceLabel(kind) + ' could not be read.', null);
        return null;
      }
      return { mime, dataUrl: binaryDataUrl(mime, resource.data) };
    }

    async function resolveCss(cssText, cssBaseUrl, location, depth = 0) {
      if (depth > context.maxCssImportDepth) {
        resolutionIssue(context, 'resource-limit', 'The stylesheet import depth is too large.', location);
        return null;
      }
      let output = '';
      let cursor = 0;
      const imports = /@import\s+(?:url\(\s*)?(?:['"]([^'"]+)['"]|([^)'\s;]+))\s*\)?([^;]*);/gi;
      let match;
      while ((match = imports.exec(cssText)) !== null) {
        output += cssText.slice(cursor, match.index);
        const reference = match[1] || match[2];
        const result = await request(reference, cssBaseUrl, 'stylesheet', location, 'text');
        if (result === null) {
          return null;
        }
        const data = resourceData(reference, result, 'stylesheet');
        if (data === null || typeof data.text !== 'string') {
          if (data !== null) {
            resolutionIssue(context, 'resource-resolution-failed', 'The imported stylesheet could not be read.', location);
          }
          return null;
        }
        const nested = await resolveCss(data.text, result.url, location, depth + 1);
        if (nested === null) {
          return null;
        }
        const media = (match[3] || '').trim();
        output += media === '' ? nested : '@media ' + media + '{' + nested + '}';
        cursor = imports.lastIndex;
      }
      output += cssText.slice(cursor);
      if (/@import\b/i.test(output)) {
        resolutionIssue(context, 'resource-resolution-failed', 'A stylesheet import could not be resolved safely.', location);
        return null;
      }

      let rewritten = '';
      cursor = 0;
      const urls = /url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi;
      while ((match = urls.exec(output)) !== null) {
        rewritten += output.slice(cursor, match.index);
        const reference = match[2].trim();
        if (reference.startsWith('#') || /^data:/i.test(reference)) {
          const dataReference = resolveRepositoryUrl(reference, cssBaseUrl);
          if (!dataReference.ok || (dataReference.kind === 'data' && !isSafePassiveDataUrl(reference))) {
            resolutionIssue(context, dataReference.code || 'unsafe-data-url', 'A CSS resource is not safe to use.', location);
            return null;
          }
          rewritten += match[0];
          cursor = urls.lastIndex;
          continue;
        }
        const kind = classifyCssResource(reference);
        const mode = resourceMode(reference, kind);
        const result = await request(reference, cssBaseUrl, kind, location, mode);
        if (result === null) {
          return null;
        }
        const data = resourceData(reference, result, kind);
        if (data === null) {
          return null;
        }
        rewritten += 'url("' + data.dataUrl + '")';
        cursor = urls.lastIndex;
      }
      rewritten += output.slice(cursor);
      return rewritten;
    }

    async function resolveStylesheet(element) {
      const href = element.getAttribute('href');
      const location = { target: 'link[href]' };
      const result = await request(href, baseUrl, 'stylesheet', location, 'text');
      if (result === null) {
        return false;
      }
      const data = resourceData(href, result, 'stylesheet');
      if (data === null || typeof data.text !== 'string') {
        resolutionIssue(context, 'resource-resolution-failed', 'The stylesheet could not be read.', location);
        return false;
      }
      const css = await resolveCss(data.text, result.url, location);
      if (css === null) {
        return false;
      }
      const style = doc.createElement('style');
      if (element.hasAttribute('media')) {
        style.setAttribute('media', element.getAttribute('media') || '');
      }
      style.textContent = css;
      element.replaceWith(style);
      return true;
    }

    async function resolveScript(element) {
      if (options.javascript !== true || !element.hasAttribute('src')) {
        return true;
      }
      const src = element.getAttribute('src');
      const location = { target: 'script[src]' };
      const result = await request(src, baseUrl, 'script', location, 'text');
      if (result === null) {
        return false;
      }
      const data = resourceData(src, result, 'script');
      if (data === null || typeof data.text !== 'string') {
        resolutionIssue(context, 'resource-resolution-failed', 'The classic script could not be read.', location);
        return false;
      }
      element.removeAttribute('src');
      element.textContent = data.text;
      return true;
    }

    async function resolveMedia(element, attribute, kind) {
      if (!element.hasAttribute(attribute)) {
        return true;
      }
      const reference = element.getAttribute(attribute);
      const location = { target: element.tagName.toLowerCase() + '[' + attribute + ']' };
      const result = await request(reference, baseUrl, kind, location);
      if (result === null) {
        return false;
      }
      const data = resourceData(reference, result, kind);
      if (data === null) {
        return false;
      }
      element.setAttribute(attribute, data.dataUrl);
      return true;
    }

    async function resolveSrcset(element) {
      if (!element.hasAttribute('srcset')) {
        return true;
      }
      const value = element.getAttribute('srcset') || '';
      // A data URL contains commas by definition. Preserve an already validated passive
      // data srcset instead of splitting its payload as if it were a candidate separator.
      if (/^data:/i.test(value.trim())) {
        return true;
      }
      const candidates = value.split(',');
      const rewritten = [];
      for (const candidate of candidates) {
        const parts = candidate.trim().split(/\s+/);
        const reference = parts.shift();
        if (!reference) {
          continue;
        }
        const result = await request(reference, baseUrl, 'image', { target: element.tagName.toLowerCase() + '[srcset]' });
        if (result === null) {
          return false;
        }
        const data = resourceData(reference, result, 'image');
        if (data === null) {
          return false;
        }
        rewritten.push([data.dataUrl, ...parts].join(' '));
      }
      element.setAttribute('srcset', rewritten.join(', '));
      return true;
    }

    const links = Array.from(doc.querySelectorAll('link[rel~="stylesheet" i][href]'));
    for (const element of links) {
      if (!(await resolveStylesheet(element))) {
        return { valid: false, html: htmlText, issues: context.issues, resourceCount: context.resourceCount, byteCount: context.byteCount };
      }
    }

    const scripts = Array.from(doc.querySelectorAll('script[src]'));
    for (const element of scripts) {
      if (!(await resolveScript(element))) {
        return { valid: false, html: htmlText, issues: context.issues, resourceCount: context.resourceCount, byteCount: context.byteCount };
      }
    }

    for (const element of Array.from(doc.querySelectorAll('img[src], source[src], video[src], video[poster], audio[src]'))) {
      const tag = element.tagName.toLowerCase();
      const attributes = tag === 'video' ? ['src', 'poster'] : ['src'];
      for (const attribute of attributes) {
        if (!(await resolveMedia(element, attribute, tag === 'img' ? 'image' : 'media'))) {
          return { valid: false, html: htmlText, issues: context.issues, resourceCount: context.resourceCount, byteCount: context.byteCount };
        }
      }
    }
    for (const element of Array.from(doc.querySelectorAll('img[srcset], source[srcset]'))) {
      if (!(await resolveSrcset(element))) {
        return { valid: false, html: htmlText, issues: context.issues, resourceCount: context.resourceCount, byteCount: context.byteCount };
      }
    }

    for (const element of Array.from(doc.querySelectorAll('style'))) {
      const location = { target: 'style' };
      const css = await resolveCss(element.textContent || '', baseUrl, location);
      if (css === null) {
        return { valid: false, html: htmlText, issues: context.issues, resourceCount: context.resourceCount, byteCount: context.byteCount };
      }
      element.textContent = css;
    }
    for (const element of Array.from(doc.querySelectorAll('[style]'))) {
      const location = { target: element.tagName.toLowerCase() + '[style]' };
      const css = await resolveCss(element.getAttribute('style') || '', baseUrl, location);
      if (css === null) {
        return { valid: false, html: htmlText, issues: context.issues, resourceCount: context.resourceCount, byteCount: context.byteCount };
      }
      element.setAttribute('style', css);
    }

    const serialized = '<!doctype html>\n' + doc.documentElement.outerHTML;
    return {
      valid: context.issues.length === 0,
      html: serialized,
      issues: context.issues,
      resourceCount: context.resourceCount,
      byteCount: context.byteCount,
    };
  }

  global.GHPREVIEW = global.GHPREVIEW || {};
  global.GHPREVIEW.inline = {
    validateDocument,
    resolveRepositoryUrl,
    resolveResources,
    isSafePassiveDataUrl,
  };
})(typeof window === 'undefined' ? globalThis : window);
