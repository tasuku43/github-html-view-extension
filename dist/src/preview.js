/*
 * Orchestrate timing, fetching, and delivery to the opaque-origin sandbox.
 *
 * Decisions live in lib/, and GitHub DOM integration lives in github/dom.js. This file
 * owns the sequence only.
 */
(function initPreview(global) {
  'use strict';

  const {
    blobUrl,
    viewTransition,
    previewSession,
    settings,
    githubDom,
    inline,
  } = global.GHPREVIEW;

  const PREFIX = 'ghpreview:';
  const RENDER = PREFIX + 'render';
  const RENDER_STARTED = PREFIX + 'render-started';
  const RENDER_READY = PREFIX + 'render-ready';
  const BOOTSTRAP = PREFIX + 'sandbox-bootstrap';
  const READY = PREFIX + 'sandbox-ready';
  const PING = PREFIX + 'sandbox-ping';
  const HEIGHT = PREFIX + 'height';
  const RUNTIME_ERROR = PREFIX + 'runtime-error';
  const SETTINGS_KEY = settings.STORAGE_KEY;

  const STATES = previewSession.PHASES;
  let previewState = 'idle';
  let previewErrorCode = null;
  let operation = null;

  function operationFor(href) {
    if (previewSession.isCurrent(operation, operation, href)) {
      return operation;
    }
    operation = previewSession.create(href, operation);
    return operation;
  }

  function isStale(current) {
    if (previewSession.isCurrent(current, operation, location.href)) {
      return false;
    }
    previewSession.invalidate(current, 'stale-operation');
    emit('warn', 'stale-operation', 'preview', current, 'stale-operation', {
      stage: 'async-boundary',
    });
    setState('stale', 'stale-operation', current);
    return true;
  }

  function emit(level, event, phase, current, errorCode, detail) {
    const payload = { event, phase };
    const active = current || operation;
    if (active && active.requestId) {
      payload.requestId = active.requestId;
    }
    if (active && active.sessionId) {
      payload.sessionId = active.sessionId;
    }
    if (errorCode) {
      payload.errorCode = errorCode;
    }
    if (detail !== undefined) {
      payload.detail = detail;
    }
    const message = '[html-preview] ' + JSON.stringify(payload);
    const logger = console[level] || console.debug;
    logger.call(console, message);
  }

  function debug(event, detail, current, errorCode) {
    emit('debug', event, 'preview', current, errorCode, detail);
  }

  function setState(next, errorCode = null, current = operation) {
    if (!STATES.has(next)) {
      return;
    }
    const changed = previewState !== next || previewErrorCode !== errorCode;
    previewState = next;
    previewErrorCode = errorCode;
    previewSession.setPhase(current, next);
    githubDom.setPreviewMetadata({
      state: next,
      errorCode,
      requestId: current && current.requestId,
      sessionId: current && current.sessionId,
    });
    if (changed) {
      debug('state-changed', { state: next }, current, errorCode);
    }
  }

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

  function ask(message, current) {
    return new Promise(resolve => {
      if (!extensionAlive) {
        resolve({ ok: false, errorCode: 'extension-unavailable' });
        return;
      }
      try {
        chrome.runtime.sendMessage(
          { ...message, requestId: current && current.requestId },
          reply => {
            try {
              const runtimeError = chrome.runtime.lastError;
              if (runtimeError) {
                emit('warn', 'response-rejected', 'fetching', current, 'runtime-last-error', {
                  source: 'runtime-message',
                });
                resolve({ ok: false, errorCode: 'runtime-last-error' });
                return;
              }
              if (!reply || typeof reply !== 'object') {
                emit('warn', 'response-rejected', 'fetching', current, 'invalid-response', {
                  source: 'runtime-message',
                });
                resolve({ ok: false, errorCode: 'invalid-response' });
                return;
              }
              if (current && current.requestId && reply.requestId !== current.requestId) {
                emit('warn', 'response-rejected', 'fetching', current, 'invalid-response', {
                  source: 'runtime-message',
                  reason: 'request-id-mismatch',
                });
                resolve({ ok: false, errorCode: 'invalid-response' });
                return;
              }
              resolve(reply);
            } catch (error) {
              extensionAlive = false;
              emit('warn', 'response-rejected', 'fetching', current, 'runtime-last-error', {
                source: 'runtime-message',
              });
              resolve({ ok: false, errorCode: 'runtime-last-error' });
            }
          },
        );
      } catch (error) {
        extensionAlive = false;
        emit('warn', 'response-rejected', 'fetching', current, 'runtime-last-error', {
          source: 'runtime-message',
        });
        resolve({ ok: false, errorCode: 'runtime-last-error' });
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
  const loadFailures = new Map();

  function load(url, current, kind = 'resource') {
    if (cache.has(url)) {
      return cache.get(url);
    }
    debug('request-started', { kind }, current);
    const pending = Promise.resolve()
      .then(() => {
        debug('request-sent', { kind }, current);
        return ask({ type: PREFIX + 'fetch', url }, current);
      })
      .then(reply => {
      if (!reply || !reply.ok) {
        const errorCode = reply && reply.errorCode ? reply.errorCode : 'fetch-failed';
        loadFailures.set(url, errorCode);
        emit('warn', 'response-rejected', 'fetching', current, errorCode, { kind });
        return null;
      }
      debug('response-received', { kind, contentType: reply.contentType || 'unknown' }, current);
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

  /**
   * Check whether the extension is enabled for this page. When it is enabled, fetch early.
   *
   * Reading the allowlist is asynchronous, so callers can reuse the result while the page
   * remains unchanged.
   */
  async function isEnabled(parsed, current) {
    const loaded = settings.normalize(await storageGet(SETTINGS_KEY));
    debug(
      'settings-loaded',
      {
        previewEnabled: loaded.previewEnabled,
        allowlistEntryCount: loaded.repositories.length,
        capabilities: { ...loaded.capabilities },
      },
      current,
    );
    if (!loaded.previewEnabled) {
      emit('warn', 'preview-disabled', 'checking-settings', current, 'preview-disabled');
      return { allowed: false, errorCode: 'preview-disabled', settings: loaded };
    }
    if (!settings.isAllowed(blobUrl.repoKey(parsed), loaded)) {
      emit('warn', 'repository-not-allowed', 'checking-settings', current, 'repository-not-allowed');
      return { allowed: false, errorCode: 'repository-not-allowed', settings: loaded };
    }
    return { allowed: true, errorCode: null, settings: loaded };
  }

  function abandonOperation(reason) {
    const previous = operation;
    if (previous !== null) {
      previewSession.invalidate(previous, reason);
      emit('debug', 'stale-operation', 'preview', previous, 'stale-operation', { stage: reason });
      setState('stale', 'stale-operation', previous);
      unmount(reason, previous);
    }
    operation = null;
    rendered = null;
  }

  function rejectMissingFilePage() {
    if (operation !== null) {
      abandonOperation('github-file-not-found');
    }
    teardown('idle');
  }

  async function apply() {
    setState('detecting');
    // Accept Blame too. It shows the same file, so Preview remains available.
    const file = blobUrl.parseFileUrl(location.href);
    if (file === null || !blobUrl.isHtmlPath(file.refAndPath)) {
      teardown('idle');
      return;
    }
    if (operation !== null && operation.href !== location.href) {
      abandonOperation('navigation');
    }
    if (githubDom.isMissingFilePage()) {
      debug('page-rejected', { reason: 'github-file-not-found' });
      rejectMissingFilePage();
      return;
    }
    const current = operationFor(location.href);
    debug('page-detected', { view: file.view, fileKind: 'html' }, current);
    setState('checking-settings', null, current);
    const access = await isEnabled(file, current);
    if (!access.allowed) {
      teardown('disabled', current, access.errorCode);
      return;
    }
    current.settings = access.settings;
    if (isStale(current)) {
      return;
    }

    githubDom.ensureStyle(chrome.runtime.getURL('ui.css'));
    githubDom.insertPreviewLink({
      onPreview: () => {
        const plan = viewTransition.plan(location.href, viewTransition.VIEWS.PREVIEW);
        go(plan.destinationHref || blobUrl.previewHref(location.href));
      },
    });

    // Blame keeps Preview available but does not select or render it. Blob with no
    // `?plain=1` is the only state that owns the Preview surface.
    const wantsPreview = viewTransition.inspect(location.href).renderPreview;

    githubDom.markPreviewSelected(wantsPreview);

    if (!wantsPreview) {
      unmount('view-change', current);
      setState('idle', null, current);
      return;
    }
    // A policy or fetch failure owns the Preview surface until the user explicitly
    // chooses Recheck. MutationObserver callbacks must not replace that surface with a
    // second, permanently loading sandbox frame.
    if (githubDom.hasError()) {
      setState('failed', githubDom.getErrorCode() || previewErrorCode || 'preview-failed', current);
      githubDom.reconcileError();
      return;
    }
    // Mount before fetching. If the container is not available yet, the call is a no-op
    // and the mutation observer will retry when GitHub inserts it.
    setState('mounting', null, current);
    openFrame(chrome.runtime.getURL('sandbox.html'), file, current.settings.capabilities, current);

    if (rendered === location.href) {
      return;
    }
    rendered = location.href;
    await render(file, current);
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
  function unmount(reason = 'preview-destroyed', current = operation) {
    const hadSurface = handover.frame !== null || githubDom.hasError();
    if (hadSurface) {
      debug('preview-destroyed', { reason }, current);
    }
    if (reason === 'view-change' && current !== null) {
      emit('debug', 'stale-operation', 'preview', current, 'stale-operation', {
        stage: 'view-change',
      });
      setState('stale', 'stale-operation', current);
    }
    clearSandboxTimer();
    rendered = null;
    handover.frame = null;
    handover.ready = false;
    handover.html = null;
    handover.sessionId = null;
    dropFrameListeners();
    githubDom.removeFrame();
  }

  function teardown(nextState = 'idle', current = operation, errorCode = null) {
    unmount('teardown', current);
    githubDom.removePreviewLink();
    setState(nextState, errorCode, current);
  }

  function recheck(parsed, current = operation) {
    cache.clear();
    loadFailures.clear();
    rendered = null;
    debug('recheck-started', { cache: 'cleared' }, current);
    unmount('recheck', current);
    previewSession.invalidate(current, 'recheck');
    operation = null;
    apply();
  }

  async function render(parsed, current) {
    setState('fetching', null, current);
    const sourceUrl = blobUrl.rawUrl(parsed);
    const source = await load(sourceUrl, current, 'source');
    if (isStale(current)) {
      return;
    }
    if (source === null) {
      const errorCode = loadFailures.get(sourceUrl) || 'source-fetch-failed';
      emit('warn', 'fetch-failed', 'fetching', current, errorCode, { kind: 'source' });
      failPreview({
        code: errorCode,
        reason: 'GitHub did not return the file for Preview.',
        issues: [{ message: 'The source file could not be retrieved.' }],
        onOpenCode: () => go(blobUrl.sourceHref(location.href)),
        onRecheck: () => recheck(parsed, current),
      }, current);
      return;
    }

    debug('source-loaded', {
      textLength: typeof source.text === 'string' ? source.text.length : null,
    }, current);

    // Reject unsupported documents before any source is sent to the sandbox. This keeps
    // policy failures deterministic instead of turning them into blank documents or
    // browser-level CSP/runtime errors.
    setState('validating', null, current);
    debug('validation-started', undefined, current);
    const validation = inline.validateDocument(source.text);
    debug('validation-completed', {
      valid: validation.valid,
      issueCodes: validation.issues.map(issue => issue.code),
    }, current);
    if (!validation.valid) {
      emit('warn', 'validation-failed', 'validating', current, 'html-policy-violation', {
        issueCount: validation.issues.length,
      });
      if (rendered !== location.href || isStale(current)) {
        debug('stale-operation', { stage: 'validation-result' }, current, 'stale-operation');
        return;
      }
      failPreview({
        code: 'html-policy-violation',
        reason: 'This file cannot be previewed because it is not self-contained.',
        issues: validation.issues,
        onOpenCode: () => go(blobUrl.sourceHref(location.href)),
        onRecheck: () => recheck(parsed, current),
      }, current);
      return;
    }

    const built = await githubDom.inlineDocument(
      source.text,
      blobUrl.resolutionBase(parsed),
      (url) => load(url, current),
      current.sessionId,
      current.settings && current.settings.capabilities,
    );
    debug('document-built', {
      htmlLength: built.html.length,
      noteCount: built.notes.length,
    }, current);
    // Report each note once by content. An index-based key could hide a different note
    // when a new document uses the same position.
    if (built.notes.length > 0) {
      const noteKinds = new Set(
        built.notes.map(note => {
          if (note.startsWith('Could not load reference:')) {
            return 'reference-load-failed';
          }
          if (note.startsWith('Could not fetch file:')) {
            return 'source-fetch-failed';
          }
          return 'inline-warning';
        }),
      );
      noteKinds.forEach(kind =>
        githubDom.warn(
          'note:' + kind,
          'Inline document processing reported a ' + kind + ' condition',
        ),
      );
    }

    // Do not render if navigation happened while the document was being prepared.
    if (rendered !== location.href || isStale(current)) {
      debug('stale-operation', { stage: 'document-built' }, current, 'stale-operation');
      return;
    }

    handover.html = built.html;
    setState('rendering', null, current);
    openFrame(
      chrome.runtime.getURL('sandbox.html'),
      parsed,
      current.settings && current.settings.capabilities,
      current,
    );
    flush();
  }

  /*
   * Coordinate the document and its receiver; either may become ready first.
   *
   * The iframe is mounted first, so sandbox-ready can arrive before the document. Send
   * only after both sides are ready.
   */
  const handover = { frame: null, ready: false, html: null, sessionId: null };
  const SANDBOX_TIMEOUT_MS = 4000;
  const HEIGHT_TIMEOUT_MS = 4000;
  let sandboxTimer = null;
  let heightTimer = null;

  function clearSandboxTimer() {
    if (sandboxTimer !== null) {
      clearTimeout(sandboxTimer);
      sandboxTimer = null;
    }
    if (heightTimer !== null) {
      clearTimeout(heightTimer);
      heightTimer = null;
    }
  }

  function scheduleHeightTimeout(parsed, current) {
    if (heightTimer !== null) {
      clearTimeout(heightTimer);
    }
    heightTimer = setTimeout(() => {
      heightTimer = null;
      if (
        operation !== current ||
        handover.frame === null ||
        handover.sessionId !== current.sessionId ||
        previewState !== 'waiting-for-height' ||
        githubDom.hasError()
      ) {
        return;
      }
      emit('error', 'height-timeout', 'rendering', current, 'height-timeout');
      failPreview(
        {
          code: 'height-timeout',
          reason: 'The preview rendered but did not report its layout.',
          issues: [{ message: 'The isolated document did not provide a usable height.' }],
          onOpenCode: () => go(blobUrl.sourceHref(location.href)),
          onRecheck: () => recheck(parsed, current),
        },
        current,
      );
    }, HEIGHT_TIMEOUT_MS);
  }

  function failPreview(details, current = operation) {
    clearSandboxTimer();
    const errorCode = details.code || 'preview-failed';
    emit('error', 'preview-failed', 'preview', current, errorCode);
    setState('failed', errorCode, current);
    githubDom.showError({
      ...details,
      state: 'failed',
      code: errorCode,
      requestId: current && current.requestId,
      sessionId: current && current.sessionId,
      errorCode,
    });
  }

  function scheduleSandboxTimeout(frame, parsed, current) {
    clearSandboxTimer();
    sandboxTimer = setTimeout(() => {
      sandboxTimer = null;
      if (handover.frame !== frame || handover.ready || githubDom.hasError() || operation !== current) {
        return;
      }

      emit('error', 'sandbox-timeout', 'sandbox', current, 'sandbox-timeout');
      dropFrameListeners();
      handover.frame = null;
      handover.ready = false;
      handover.html = null;
      handover.sessionId = null;
      failPreview({
        code: 'sandbox-timeout',
        reason: 'The preview sandbox did not start.',
        issues: [{ message: 'The isolated preview surface did not respond.' }],
        onOpenCode: () => go(blobUrl.sourceHref(location.href)),
        onRecheck: () => recheck(parsed, current),
      }, current);
    }, SANDBOX_TIMEOUT_MS);
  }

  function openFrame(sandboxUrl, parsed, capabilities, current) {
    previewSession.attachSandbox(current);
    const entry = new URL(sandboxUrl);
    entry.searchParams.set('session', current.sessionId);
    let prepared = false;
    const prepare = (frame, created = false) => {
      if (handover.frame === frame) {
        prepared = true;
        return;
      }
      handover.frame = frame;
      handover.ready = false;
      handover.sessionId = current.sessionId;
      listen(frame);
      setState('waiting-for-sandbox', null, current);
      debug('frame-mounted', { created }, current);
      frame.addEventListener(
        'load',
        () => {
          if (handover.frame !== frame || operation !== current) {
            emit('debug', 'stale-operation', 'sandbox', current, 'stale-operation', {
              stage: 'sandbox-load',
            });
            return;
          }
          debug('sandbox-document-loaded', { ready: handover.ready }, current);
          if (handover.ready) {
            return;
          }
          // Ask the bundled bootstrap to repeat its ready signal. This makes the
          // handshake recoverable if navigation or a stale frame consumed the first one.
          try {
            frame.contentWindow.postMessage({ type: PING, sessionId: current.sessionId }, '*');
            debug('sandbox-ping-sent', undefined, current);
          } catch (error) {
            emit('warn', 'sandbox-ping-failed', 'sandbox', current, 'sandbox-communication-failed');
          }
        },
      );
      prepared = true;
      debug('sandbox-navigation-started', undefined, current);
      scheduleSandboxTimeout(frame, parsed, current);
    };
    const mounted = githubDom.mountFrame(entry.href, capabilities, prepare);
    if (mounted.frame === null) {
      return;
    }
    if (mounted.entryRepaired) {
      debug('sandbox-entry-repaired', { entry: 'bundled-sandbox' }, current);
    }
    if (handover.frame === mounted.frame) {
      return;
    }
    if (!prepared) {
      prepare(mounted.frame, mounted.created);
    }
  }

  function flush() {
    if (handover.frame === null || !handover.ready || handover.html === null) {
      return;
    }
    const html = handover.html;
    handover.html = null;
    setState('rendering', null, operation);
    debug('render-sent', { htmlLength: html.length }, operation);
    handover.frame.contentWindow.postMessage(
      { type: RENDER, html, sessionId: handover.sessionId },
      '*',
    );
  }

  /**
   * Send the document to the opaque-origin sandbox.
   *
   * The sandbox has an opaque `null` origin, so identify it with `event.source`. Send only
   * to the frame's window.
   */
  function listen(frame) {
    function onMessage(event) {
      const sourceMatches = event.source === frame.contentWindow;
      const data = event.data;
      const messageKind =
        data && data.type === BOOTSTRAP
          ? 'sandbox-bootstrap'
          : data && data.type === READY
            ? 'sandbox-ready'
            : data && data.type === HEIGHT
              ? 'height'
              : data && data.type === RENDER_STARTED
                ? 'render-started'
                : data && data.type === RENDER_READY
                  ? 'render-ready'
                  : data && data.type === RUNTIME_ERROR
                    ? 'runtime-error'
                    : 'other';
      debug(
        'sandbox-message-received',
        {
          type: messageKind,
          sourceMatches,
          origin: event.origin === 'null' ? 'opaque' : 'other',
        },
        operation,
      );
      if (!sourceMatches) {
        debug('sandbox-message-rejected', { reason: 'source-mismatch' }, operation);
        return;
      }
      if (handover.frame !== frame || operation === null) {
        emit('debug', 'stale-operation', 'sandbox', operation, 'stale-operation', {
          stage: 'sandbox-message',
        });
        return;
      }
      if (!data) {
        debug('sandbox-message-rejected', { reason: 'missing-data' }, operation);
        return;
      }
      if (event.origin !== 'null') {
        debug('sandbox-message-rejected', { reason: 'origin-mismatch' }, operation);
        return;
      }
      if (data.sessionId !== handover.sessionId) {
        emit('debug', 'stale-operation', 'sandbox', operation, 'stale-operation', {
          stage: 'sandbox-session',
        });
        return;
      }
      if (data.type === READY) {
        clearSandboxTimer();
        debug('sandbox-ready', undefined, operation);
        handover.ready = true;
        flush();
        return;
      }
      if (data.type === BOOTSTRAP) {
        debug('sandbox-bootstrap-received', undefined, operation);
        return;
      }
      if (data.type === RENDER_STARTED) {
        setState('rendering', null, operation);
        debug('render-started', undefined, operation);
        return;
      }
      if (data.type === RENDER_READY) {
        setState('waiting-for-height', null, operation);
        debug('render-ready', undefined, operation);
        scheduleHeightTimeout(blobUrl.parseFileUrl(location.href), operation);
        return;
      }
      if (data.type === RUNTIME_ERROR) {
        emit('error', 'runtime-error', 'sandbox', operation, 'sandbox-runtime-error', {
          source: 'rendered-document',
        });
        failPreview(
          {
            code: 'sandbox-runtime-error',
            reason: 'The preview ran into a runtime error.',
            issues: [{ message: 'The isolated document reported a runtime error.' }],
            onOpenCode: () => go(blobUrl.sourceHref(location.href)),
            onRecheck: () => recheck(blobUrl.parseFileUrl(location.href), operation),
          },
          operation,
        );
        return;
      }
      // Resize to the document height so the iframe does not create a second scrollbar.
      if (data.type === HEIGHT) {
        const validHeight = Number.isFinite(data.height) && data.height > 0;
        debug('height-received', { valid: validHeight }, operation);
        if (!validHeight) {
          emit('warn', 'response-rejected', 'waiting-for-height', operation, 'invalid-height');
          return;
        }
        if (heightTimer !== null) {
          clearTimeout(heightTimer);
          heightTimer = null;
        }
        githubDom.resizeFrame(data.height);
        setState('ready', null, operation);
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

  function shouldReapplyAfterMutation() {
    const file = blobUrl.parseFileUrl(location.href);
    if (file === null || !blobUrl.isHtmlPath(file.refAndPath)) {
      return false;
    }
    if (githubDom.isMissingFilePage()) {
      return false;
    }
    // Settings are still being read or a disabled page is already settled. Re-entering
    // apply here would create concurrent operations while GitHub is rendering its shell.
    if (previewState === 'detecting' || previewState === 'checking-settings' || previewState === 'disabled') {
      return false;
    }
    if (githubDom.needsReconcile()) {
      return true;
    }
    if (!githubDom.hasPreviewLink()) {
      return true;
    }
    if (previewState === 'failed' && !githubDom.hasError()) {
      return true;
    }
    if (previewState === 'ready' && !githubDom.hasFrame()) {
      return true;
    }
    return (
      ['mounting', 'fetching', 'validating', 'rendering', 'waiting-for-sandbox', 'waiting-for-height'].includes(
        previewState,
      ) && !githubDom.hasFrame()
    );
  }

  function onMutated() {
    if (timer !== null) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      const changed = location.href !== seen;
      if (changed) {
        seen = location.href;
        // Clear the previous page before applying the new one, including restoring hidden
        // source content. Record the abandoned async operation instead of letting it
        // silently mutate the new page.
        abandonOperation('navigation');
        githubDom.removePreviewLink();
      }
      if (githubDom.isMissingFilePage()) {
        if (operation !== null || githubDom.hasPreviewLink() || githubDom.hasFrame() || githubDom.hasError()) {
          debug('page-rejected', { reason: 'github-file-not-found' });
          rejectMissingFilePage();
        }
        return;
      }
      if (changed || shouldReapplyAfterMutation()) {
        apply();
      }
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
      !blobUrl.shouldPreview(location.href) ||
      githubDom.isMissingFilePage()
    ) {
      return;
    }
    const current = operationFor(location.href);
    const access = await isEnabled(parsed, current);
    if (access.allowed) {
      current.settings = access.settings;
      load(blobUrl.rawUrl(parsed), current, 'source');
    }
  })();

  // Settings changes are part of the page lifecycle. Re-evaluate the current file without
  // requiring a tab reload, and invalidate any fetch or sandbox work that used old policy.
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes[SETTINGS_KEY]) {
        return;
      }
      debug('settings-changed', { source: 'popup' }, operation);
      cache.clear();
      loadFailures.clear();
      rendered = null;
      if (operation !== null) {
        abandonOperation('settings-changed');
      }
      apply();
    });
  }

  githubDom.onLeavePreview(({ label, event } = {}) => {
    const file = blobUrl.parseFileUrl(location.href);
    if (file === null) {
      return;
    }
    if (label === 'code') {
      const plan = viewTransition.plan(location.href, viewTransition.VIEWS.CODE);
      if (plan.destinationHref !== null) {
        // Code is a source-view decision owned by the extension. Prevent GitHub's
        // default handler from racing the canonical destination, especially on Blame.
        if (event && typeof event.preventDefault === 'function') {
          event.preventDefault();
        }
        go(plan.destinationHref);
        return;
      }
      go(blobUrl.sourceHref(location.href));
      return;
    }
    if (label === 'blame') {
      // Let GitHub perform the normal /blob/ -> /blame/ navigation. Preview remains a
      // visible, unselected peer on the resulting Blame page.
    }
  });

  apply();
})(window);
