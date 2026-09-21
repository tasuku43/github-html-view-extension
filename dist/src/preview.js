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
    viewCoordinator,
    previewSession,
    settings,
    githubDom,
    inline,
    protocol,
  } = global.GHPREVIEW;

  const PREFIX = 'ghpreview:';
  const RENDER = PREFIX + 'render';
  const TRUST = PREFIX + 'trust-repository';
  const RENDER_STARTED = PREFIX + 'render-started';
  const RENDER_READY = PREFIX + 'render-ready';
  const RENDER_FAILED = PREFIX + 'render-failed';
  const BOOTSTRAP = PREFIX + 'sandbox-bootstrap';
  const READY = PREFIX + 'sandbox-ready';
  const PING = PREFIX + 'sandbox-ping';
  const HEIGHT = PREFIX + 'height';
  const RUNTIME_ERROR = PREFIX + 'runtime-error';
  const SETTINGS_KEY = settings.STORAGE_KEY;

  const STATES = previewSession.PHASES;
  const VIEW_COORDINATOR = viewCoordinator.create();
  const BOOTSTRAP_MARK = 'data-ghpreview-bootstrap';
  let previewState = 'idle';
  let previewErrorCode = null;
  let operation = null;
  let previewControlExpected = false;
  let lastViewSwitchRoot = null;
  let trustRequest = null;
  let trustStorageChangePending = false;

  function isHtmlRoute(href = location.href) {
    const file = blobUrl.parseFileUrl(href);
    return file !== null && blobUrl.isHtmlPath(file.refAndPath);
  }

  function setBootstrapPending(pending) {
    if (!document.documentElement || !isHtmlRoute()) {
      return;
    }
    if (pending) {
      document.documentElement.setAttribute(BOOTSTRAP_MARK, 'pending');
    } else {
      document.documentElement.removeAttribute(BOOTSTRAP_MARK);
    }
  }

  // Set the gate before GitHub paints its first file-view selection. This only applies to
  // supported HTML routes; Markdown and unrelated GitHub pages are never hidden.
  setBootstrapPending(true);

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
    // An operation can be intentionally invalidated while GitHub is rendering a 404
    // page or while teardown is completing. Keep the settled page state stable instead
    // of letting a late response repaint the root as stale after the surface is gone.
    if (operation !== null) {
      setState('stale', 'stale-operation', current);
    }
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

  function beginViewIntent(target) {
    const currentView = viewTransition.inspect(location.href).selectedView;
    const state = VIEW_COORDINATOR.begin(target, currentView);
    debug(
      'view-intent-started',
      {
        target,
        previousView: currentView,
        transitionId: state.transactionId,
      },
      operation,
    );
    return state;
  }

  function ensureViewIntent(target) {
    const state = VIEW_COORDINATOR.snapshot();
    if (state.transactionId === null || state.desiredView !== target) {
      return beginViewIntent(target);
    }
    return state;
  }

  function commitPresentedView(view, current = operation) {
    const hostLabel = view === viewTransition.VIEWS.PREVIEW
      ? viewTransition.nativeViewFor(location.href)
      : view;
    githubDom.markPreviewSelected(view === viewTransition.VIEWS.PREVIEW, hostLabel);
    const state = VIEW_COORDINATOR.commitPresented(view);
    const hostSelection = githubDom.viewSwitchState();
    debug(
      'view-selection-applied',
      {
        selectedView: view,
        presentedView: state.presentedView,
        nativeSelected: hostSelection.selected,
        nativeReady: hostSelection.ready,
        transitionId: state.transactionId,
      },
      current,
    );
    if (githubDom.hasPreviewLink() && hostSelection.ready) {
      setBootstrapPending(false);
    }
    return state;
  }

  function finishViewIntent(view, hostSelection = githubDom.viewSwitchState()) {
    const state = VIEW_COORDINATOR.snapshot();
    if (state.transactionId === null || state.desiredView !== view || !hostSelection.ready) {
      return false;
    }
    const expectedNative = view === viewTransition.VIEWS.PREVIEW
      ? viewTransition.VIEWS.CODE
      : view;
    if (hostSelection.selected !== expectedNative || !githubDom.hasPreviewLink()) {
      return false;
    }
    const settled = VIEW_COORDINATOR.finish();
    setBootstrapPending(false);
    debug(
      'view-transition-settled',
      {
        selectedView: view,
        nativeSelected: hostSelection.selected,
        transitionId: state.transactionId,
      },
      operation,
    );
    return settled;
  }

  // After an extension reload, an existing tab's content script can no longer use the
  // chrome API. After one failure, stop touching the extension API.
  let extensionAlive = true;
  // GitHub SPA view changes do not change the repository settings. Reuse the last
  // normalized snapshot so the replacement view can receive Preview without waiting for a
  // second storage round trip. The storage change listener below invalidates this snapshot.
  let settingsSnapshot = null;

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

  function ask(message, current, phase = 'fetching') {
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
                emit('warn', 'response-rejected', phase, current, 'runtime-last-error', {
                  source: 'runtime-message',
                });
                resolve({ ok: false, errorCode: 'runtime-last-error' });
                return;
              }
              if (!reply || typeof reply !== 'object') {
                emit('warn', 'response-rejected', phase, current, 'invalid-response', {
                  source: 'runtime-message',
                });
                resolve({ ok: false, errorCode: 'invalid-response' });
                return;
              }
              if (current && current.requestId && reply.requestId !== current.requestId) {
                emit('warn', 'response-rejected', phase, current, 'invalid-response', {
                  source: 'runtime-message',
                  reason: 'request-id-mismatch',
                });
                resolve({ ok: false, errorCode: 'invalid-response' });
                return;
              }
              resolve(reply);
            } catch (error) {
              extensionAlive = false;
              emit('warn', 'response-rejected', phase, current, 'runtime-last-error', {
                source: 'runtime-message',
              });
              resolve({ ok: false, errorCode: 'runtime-last-error' });
            }
          },
        );
      } catch (error) {
        extensionAlive = false;
        emit('warn', 'response-rejected', phase, current, 'runtime-last-error', {
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
        contentType: reply.contentType,
      };
      });
    cache.set(url, pending);
    return pending;
  }

  // ---- Current page behavior ------------------------------------------------

  let rendered = null;

  /**
   * Check whether the extension is enabled for this page and whether this exact repository
   * has already been trusted. An untrusted repository is a user decision state, not a
   * Preview failure: the controller can show the trust surface without fetching anything.
   *
   * Reading the allowlist is asynchronous, so callers can reuse the result while the page
   * remains unchanged.
   */
  async function isEnabled(parsed, current) {
    if (settingsSnapshot === null) {
      settingsSnapshot = settings.normalize(await storageGet(SETTINGS_KEY));
    }
    const loaded = settingsSnapshot;
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
      return { enabled: false, allowed: false, errorCode: 'preview-disabled', settings: loaded };
    }
    if (!settings.isAllowed(blobUrl.repoKey(parsed), loaded)) {
      emit('warn', 'repository-not-allowed', 'checking-settings', current, 'repository-not-allowed');
      return { enabled: true, allowed: false, errorCode: 'repository-not-allowed', settings: loaded };
    }
    return { enabled: true, allowed: true, errorCode: null, settings: loaded };
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

  function installPreviewControl() {
    githubDom.ensureStyle(chrome.runtime.getURL('ui.css'));
    return githubDom.insertPreviewLink({
      href: blobUrl.previewHref(location.href),
      onPreview: () => {
        ensureViewIntent(viewTransition.VIEWS.PREVIEW);
        const plan = viewTransition.plan(location.href, viewTransition.VIEWS.PREVIEW);
        const destination = plan.destinationHref || blobUrl.previewHref(location.href);
        go(destination, viewTransition.VIEWS.PREVIEW);
        return false;
      },
    });
  }

  function showTrustSurface(parsed, current, errorCode = 'repository-not-allowed') {
    setState('trust-required', errorCode, current);
    if (githubDom.hasTrustRequired()) {
      githubDom.reconcileTrust();
      return;
    }
    githubDom.showTrustRequired({
      code: errorCode,
      repository: blobUrl.repoKey(parsed),
      reason: errorCode === 'repository-not-allowed'
        ? 'HTML Preview is enabled, but this repository is not trusted yet.'
        : 'The repository could not be trusted. Try again or use the extension popup.',
      requestId: current && current.requestId,
      sessionId: current && current.sessionId,
      onTrust: () => trustRepository(parsed, current),
      onDecline: () => {
        if (!isStale(current)) {
          debug('trust-declined', { source: 'preview-surface' }, current);
          setState('trust-required', 'repository-not-allowed', current);
        }
      },
    });
  }

  async function trustRepository(parsed, current) {
    if (trustRequest === current || isStale(current)) {
      return;
    }
    trustRequest = current;
    debug('trust-requested', { source: 'preview-surface' }, current);
    const reply = await ask({ type: TRUST }, current, 'checking-settings');
    if (trustRequest === current) {
      trustRequest = null;
    }
    if (isStale(current)) {
      return;
    }
    if (!reply || !reply.ok) {
      const errorCode = reply && reply.errorCode ? reply.errorCode : 'trust-failed';
      emit('warn', 'trust-failed', 'checking-settings', current, errorCode, {
        source: 'preview-surface',
      });
      showTrustSurface(parsed, current, errorCode);
      return;
    }

    debug('repository-trusted', { alreadyAllowed: reply.alreadyAllowed === true }, current);
    // The Worker persists the new settings. Refresh locally as a fallback, while the
    // storage listener consumes the matching change event when Chrome delivers it.
    trustStorageChangePending = true;
    settingsSnapshot = null;
    cache.clear();
    loadFailures.clear();
    rendered = null;
    abandonOperation('repository-trusted');
    apply();
  }

  async function apply() {
    setState('detecting');
    // Accept Blame too. It shows the same file, so Preview remains available.
    const file = blobUrl.parseFileUrl(location.href);
    if (file === null || !blobUrl.isHtmlPath(file.refAndPath)) {
      if (document.documentElement) {
        document.documentElement.removeAttribute(BOOTSTRAP_MARK);
      }
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
    if (!access.enabled) {
      previewControlExpected = false;
      teardown('disabled', current, access.errorCode);
      return;
    }
    current.settings = access.settings;
    previewControlExpected = true;
    if (isStale(current)) {
      return;
    }

    installPreviewControl();

    // Blame keeps Preview available but does not select or render it. Blob with no
    // `?plain=1` is the only state that owns the Preview surface.
    const selectedView = viewTransition.inspect(location.href).selectedView;
    const wantsPreview = viewTransition.inspect(location.href).renderPreview;

    commitPresentedView(selectedView, current);
    const hostSelection = githubDom.viewSwitchState();
    lastViewSwitchRoot = hostSelection.root;
    finishViewIntent(selectedView, hostSelection);
    if (githubDom.hasPreviewLink() && hostSelection.ready) {
      setBootstrapPending(false);
    }
    if (!wantsPreview) {
      unmount('view-change', current);
      setState('idle', null, current);
      return;
    }
    if (!access.allowed) {
      // The master switch is on, so keep Preview visible and make the trust decision part of
      // the Preview flow. No fetch or sandbox frame is started before explicit approval.
      showTrustSurface(file, current, access.errorCode);
      return;
    }
    if (githubDom.hasTrustRequired()) {
      unmount('repository-trusted', current);
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
   * Switch views through GitHub's SPA router and apply the current page again.
   *
   * Cross-route Preview uses GitHub's history/popstate path so the switch can settle in
   * place. Blob Code transitions are also resolved in place. A Blame -> Code transition is
   * delegated to GitHub's native SPA handler so the repository shell remains mounted; when
   * GitHub lands on the Blob route, the observer adds the extension's `?plain=1` marker with
   * `history.replaceState` instead of forcing a second document navigation.
   */
  function go(href, target = null) {
    if (target !== null) {
      ensureViewIntent(target);
    }
    // Cross-route transitions are observed until GitHub's native switch settles. For a
    // Preview route, project the user's selection onto the current GitHub switch before
    // changing the URL so the old Blame selection cannot flash as an intermediate state.
    // The replacement switch is reconciled again after GitHub has rendered it.
    if (new URL(href).pathname !== location.pathname) {
      beginNavigationTransition(target);
      if (target === viewTransition.VIEWS.PREVIEW) {
        commitPresentedView(viewTransition.VIEWS.PREVIEW);
        history.pushState(null, '', href);
        window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
      } else {
        location.href = href;
      }
      return;
    }
    if (target === viewTransition.VIEWS.PREVIEW) {
      commitPresentedView(viewTransition.VIEWS.PREVIEW);
    } else if (target === viewTransition.VIEWS.CODE) {
      commitPresentedView(viewTransition.VIEWS.CODE);
    }
    pendingNavigation = null;
    clearNavigationTimer();
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
    const hadSurface =
      handover.frame !== null ||
      githubDom.hasError() ||
      githubDom.hasTrustRequired() ||
      githubDom.hasWarning();
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
    previewControlExpected = false;
    lastViewSwitchRoot = null;
    if (document.documentElement) {
      document.documentElement.removeAttribute(BOOTSTRAP_MARK);
    }
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

    const built = githubDom.prepareDocument(
      source.text,
      current.sessionId,
      current.settings && current.settings.capabilities,
    );
    debug('document-built', {
      htmlLength: built.length,
    }, current);

    // Do not render if navigation happened while the document was being prepared.
    if (rendered !== location.href || isStale(current)) {
      debug('stale-operation', { stage: 'document-built' }, current, 'stale-operation');
      return;
    }

    handover.html = built;
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
          debug('sandbox-frame-loaded', { ready: handover.ready }, current);
          if (handover.ready) {
            return;
          }
          // Ask the bundled bootstrap to repeat its ready signal. This makes the
          // handshake recoverable if navigation or a stale frame consumed the first one.
          try {
            frame.contentWindow.postMessage(
              protocol.create(PING, current.sessionId),
              '*',
            );
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
    try {
      handover.frame.contentWindow.postMessage(
        protocol.create(RENDER, handover.sessionId, { html }),
        '*',
      );
    } catch (error) {
      emit('error', 'render-failed', 'rendering', operation, 'render-failed');
      failPreview(
        {
          code: 'render-failed',
          reason: 'The preview could not render the document.',
          issues: [{ message: 'The isolated document rejected the render request.' }],
          onOpenCode: () => go(blobUrl.sourceHref(location.href)),
          onRecheck: () => recheck(blobUrl.parseFileUrl(location.href), operation),
        },
        operation,
      );
    }
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
                    : data && data.type === RENDER_FAILED
                      ? 'render-failed'
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
      if (!protocol.isMessage(data)) {
        debug('sandbox-message-rejected', { reason: 'protocol-version' }, operation);
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
        debug('sandbox-bootstrap', undefined, operation);
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
      if (data.type === RENDER_FAILED) {
        emit('error', 'render-failed', 'rendering', operation, 'render-failed');
        failPreview(
          {
            code: 'render-failed',
            reason: 'The preview could not render the document.',
            issues: [{ message: 'The isolated document rejected the render request.' }],
            onOpenCode: () => go(blobUrl.sourceHref(location.href)),
            onRecheck: () => recheck(blobUrl.parseFileUrl(location.href), operation),
          },
          operation,
        );
        return;
      }
      if (data.type === RUNTIME_ERROR) {
        emit('error', 'runtime-error', 'sandbox', operation, 'sandbox-runtime-error', {
          source: 'rendered-document',
        });
        const state = previewState === 'ready' ? 'ready' : previewState;
        setState(state, 'sandbox-runtime-error', operation);
        githubDom.showRuntimeWarning({
          state,
          code: 'sandbox-runtime-error',
          reason: 'The document reported a runtime error after rendering.',
          requestId: operation && operation.requestId,
          sessionId: operation && operation.sessionId,
        });
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
        setState(
          'ready',
          previewErrorCode === 'sandbox-runtime-error' ? previewErrorCode : null,
          operation,
        );
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
  let navigationTimer = null;
  let pendingNavigation = null;
  const NAVIGATION_SETTLE_TIMEOUT_MS = 2000;
  const NAVIGATION_SETTLE_QUIET_MS = 32;
  const NAVIGATION_SETTLE_POLL_MS = 32;
  const NAVIGATION_MUTATION_DEBOUNCE_MS = 64;

  function clearNavigationTimer() {
    if (navigationTimer !== null) {
      clearTimeout(navigationTimer);
      navigationTimer = null;
    }
  }

  /**
   * Observe one navigation intent while GitHub replaces its file-view switch. The
   * extension must not insert/remove/reselect Preview for every intermediate DOM snapshot.
   */
  function beginNavigationTransition(target = null) {
    clearNavigationTimer();
    // Close the visible gap before GitHub removes the old switch. The replacement switch
    // is not ready until both native items and the Preview peer have been reconciled.
    // Hiding only this small control prevents a transient Code/Blame-only state from
    // looking like a Preview selection during the host's DOM swap.
    setBootstrapPending(true);
    if (target !== null) {
      ensureViewIntent(target);
      VIEW_COORDINATOR.beginHostNavigation();
    }
    const originSignature = githubDom.viewSwitchState().signature;
    const settleTarget =
      target === viewTransition.VIEWS.PREVIEW
        ? viewTransition.VIEWS.CODE
        : target || viewTransition.nativeViewFor(location.href);
    debug(
      'native-navigation-started',
      { target: target || settleTarget, settleTarget },
      operation,
    );
    pendingNavigation = {
      originHref: location.href,
      href: null,
      intentTarget: target || settleTarget,
      target: settleTarget,
      originSignature,
      startedAt: Date.now(),
      stableSince: null,
      lastSignature: null,
    };
  }

  function queueNavigationAfterUrlChange(previousHref) {
    const current = pendingNavigation;
    if (current === null || current.originHref !== previousHref) {
      pendingNavigation = {
        originHref: previousHref,
        href: location.href,
        intentTarget: viewTransition.nativeViewFor(location.href),
        target: viewTransition.nativeViewFor(location.href),
        originSignature: null,
        startedAt: Date.now(),
        stableSince: null,
        lastSignature: null,
      };
    } else {
      current.href = location.href;
      current.target = current.target || viewTransition.nativeViewFor(location.href);
      current.stableSince = null;
      current.lastSignature = null;
    }
    scheduleNavigationReconcile();
  }

  function reconcileNavigation() {
    navigationTimer = null;
    const current = pendingNavigation;
    if (current === null) {
      return;
    }

    const now = Date.now();
    if (location.href === current.originHref) {
      if (now - current.startedAt >= NAVIGATION_SETTLE_TIMEOUT_MS) {
        debug('navigation-cancelled', { reason: 'url-unchanged' });
        pendingNavigation = null;
        return;
      }
      scheduleNavigationReconcile();
      return;
    }

    if (githubDom.isMissingFilePage()) {
      setBootstrapPending(false);
      pendingNavigation = null;
      rejectMissingFilePage();
      return;
    }

    const expected = current.target || viewTransition.nativeViewFor(location.href);
    const host = githubDom.viewSwitchState();
    const hostRootChanged = host.root !== lastViewSwitchRoot;
    if (previewControlExpected && (hostRootChanged || !githubDom.hasPreviewLink())) {
      setBootstrapPending(true);
    }
    lastViewSwitchRoot = host.root;
    const coordinatorState = VIEW_COORDINATOR.observeHost({
      view: host.selected,
      ready: host.ready,
      signature: host.signature,
    });
    if (host.signature !== current.lastSignature) {
      debug(
        'view-transition-observed',
        {
          expected,
          selected: host.selected,
          ready: host.ready,
          signature: host.signature,
          transitionPhase: coordinatorState.phase,
          transitionId: coordinatorState.transactionId,
        },
        operation,
      );
    }

    // GitHub may have replaced the switch before the controller's final apply() can run.
    // Restore the Preview peer as soon as the new native switch exists, but leave its
    // selection to the final settled reconciliation so host readiness remains observable.
    const nextFile = blobUrl.parseFileUrl(location.href);
    if (
      current.intentTarget === viewTransition.VIEWS.CODE &&
      nextFile !== null &&
      nextFile.view === 'blob' &&
      new URL(location.href).searchParams.get('plain') !== '1'
    ) {
      // GitHub's native Blame -> Code transition keeps the SPA shell and lands on the
      // Blob route without the explicit plain marker. Canonicalize that route in place so
      // the extension's Code/Preview contract survives without triggering a second document
      // navigation (which would discard the repository file tree).
      const canonicalCodeHref = viewTransition.codeHref(location.href);
      if (canonicalCodeHref !== location.href) {
        history.replaceState(history.state, '', canonicalCodeHref);
        seen = location.href;
        debug('code-route-canonicalized', { route: 'blob' }, operation);
      }
    }
    if (
      host.ready &&
      settingsSnapshot !== null &&
      nextFile !== null &&
      blobUrl.isHtmlPath(nextFile.refAndPath) &&
      settingsSnapshot.previewEnabled &&
      settings.isAllowed(blobUrl.repoKey(nextFile), settingsSnapshot) &&
      !githubDom.hasPreviewLink()
    ) {
      const controlInserted = installPreviewControl();
      debug(
        'view-control-reconciled',
        { inserted: controlInserted, selected: host.selected },
        operation,
      );
    }

    // A Preview navigation from Blame changes the route to Blob, whose native GitHub
    // selection is Code. Do not wait for that transient Code selection to settle: once
    // the new native switch has replaced the old Blame switch, project Preview into it
    // in the same reconciliation turn. Waiting for Code here is the visible flicker the
    // extension is meant to avoid.
    const previewTransitionReady =
      current.intentTarget === viewTransition.VIEWS.PREVIEW &&
      nextFile !== null &&
      nextFile.view === 'blob' &&
      blobUrl.shouldPreview(location.href) &&
      host.ready &&
      (current.originSignature === null || host.signature !== current.originSignature) &&
      githubDom.hasPreviewLink();
    if (previewTransitionReady) {
      pendingNavigation = null;
      commitPresentedView(viewTransition.VIEWS.PREVIEW);
      setBootstrapPending(false);
      debug(
        'preview-transition-committed',
        {
          selectedView: viewTransition.VIEWS.PREVIEW,
          nativeSelected: host.selected,
          signature: host.signature,
          transitionId: coordinatorState.transactionId,
        },
        operation,
      );
      apply();
      return;
    }

    const settled = expected !== null && host.ready && host.selected === expected;
    const wasStable = current.stableSince !== null;
    if (settled && host.signature === current.lastSignature) {
      if (current.stableSince === null) {
        current.stableSince = now;
      }
    } else {
      current.lastSignature = host.signature;
      current.stableSince = settled ? now : null;
    }
    if (!wasStable && current.stableSince !== null) {
      debug(
        'view-transition-host-settled',
        { expected, selected: host.selected, signature: host.signature },
        operation,
      );
    }

    if (
      settled &&
      current.stableSince !== null &&
      now - current.stableSince >= NAVIGATION_SETTLE_QUIET_MS
    ) {
      pendingNavigation = null;
      apply();
      return;
    }

    if (now - current.startedAt >= NAVIGATION_SETTLE_TIMEOUT_MS) {
      debug('navigation-settle-timeout', { expected, selected: host.selected });
      pendingNavigation = null;
      apply();
      return;
    }
    scheduleNavigationReconcile();
  }

  function scheduleNavigationReconcile() {
    if (navigationTimer !== null) {
      return;
    }
    navigationTimer = setTimeout(reconcileNavigation, NAVIGATION_SETTLE_POLL_MS);
  }

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
    if (previewState === 'trust-required' && !githubDom.hasTrustRequired()) {
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

  function handleUrlChange() {
    const previousHref = seen;
    seen = location.href;
    // Clear the previous page before applying the new one, including restoring hidden
    // source content. Record the abandoned async operation instead of letting a late
    // response mutate the new page.
    abandonOperation('navigation');
    const nextFile = blobUrl.parseFileUrl(location.href);
    if (nextFile === null || !blobUrl.isHtmlPath(nextFile.refAndPath)) {
      pendingNavigation = null;
      clearNavigationTimer();
      teardown('idle');
      return;
    }
    setBootstrapPending(true);
    queueNavigationAfterUrlChange(previousHref);
  }

  function onMutated() {
    // URL changes are the navigation signal. Process them immediately instead of waiting
    // for the ordinary DOM-settle debounce; the native GitHub view switch is already the
    // visible transition surface and should not be held behind extension bookkeeping.
    if (location.href !== seen) {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      handleUrlChange();
      return;
    }
    const host = githubDom.viewSwitchState();
    const hostRootChanged = host.root !== lastViewSwitchRoot;
    if (previewControlExpected && (hostRootChanged || !githubDom.hasPreviewLink())) {
      setBootstrapPending(true);
      lastViewSwitchRoot = host.root;
      if (pendingNavigation !== null) {
        reconcileNavigation();
      } else {
        apply();
      }
      return;
    }
    if (timer !== null) {
      return;
    }
    if (pendingNavigation !== null) {
      reconcileNavigation();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      if (location.href !== seen) {
        handleUrlChange();
        return;
      }
      if (pendingNavigation !== null) {
        scheduleNavigationReconcile();
        return;
      }
      if (githubDom.isMissingFilePage()) {
        if (
          operation !== null ||
          githubDom.hasPreviewLink() ||
          githubDom.hasFrame() ||
          githubDom.hasError() ||
          githubDom.hasTrustRequired()
        ) {
          debug('page-rejected', { reason: 'github-file-not-found' });
          rejectMissingFilePage();
        }
        return;
      }
      if (shouldReapplyAfterMutation()) {
        apply();
      }
    }, NAVIGATION_MUTATION_DEBOUNCE_MS);
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
      settingsSnapshot = null;
      cache.clear();
      loadFailures.clear();
      rendered = null;
      if (trustStorageChangePending) {
        trustStorageChangePending = false;
        return;
      }
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
    const hostSelection = githubDom.viewSwitchState();
    debug(
      'view-intent',
      {
        target: label,
        nativeSelected: hostSelection.selected,
        nativeReady: hostSelection.ready,
      },
      operation,
    );
    if (label === 'code' || label === 'blame') {
      ensureViewIntent(label);
      // Project the native destination immediately, matching GitHub's own segmented
      // control timing. The coordinator keeps this as the single presentation write while
      // the route and the file view are still being replaced.
      if (label === 'blame') {
        commitPresentedView(viewTransition.VIEWS.BLAME);
      }
    }
    if (label === 'code') {
      const plan = viewTransition.plan(location.href, viewTransition.VIEWS.CODE);
      if (file.view === 'blame') {
        // Blame's Code control is a GitHub-owned SPA transition. Let its native handler
        // update the route so the repository file tree remains mounted; the capture-phase
        // listener has already recorded the intent and the observer will reconcile Preview
        // after GitHub replaces the file view.
        beginNavigationTransition(viewTransition.VIEWS.CODE);
        debug(
          'native-code-navigation-delegated',
          { route: 'blame', plannedAction: plan.action },
          operation,
        );
        return;
      }
      if (plan.destinationHref !== null) {
        // Code is a source-view decision owned by the extension. Prevent GitHub's
        // default handler from racing the canonical destination on the Blob route.
        if (event && typeof event.preventDefault === 'function') {
          event.preventDefault();
        }
        go(plan.destinationHref, viewTransition.VIEWS.CODE);
        return;
      }
      go(blobUrl.sourceHref(location.href), viewTransition.VIEWS.CODE);
      return;
    }
    if (label === 'blame') {
      // Let GitHub's native route handler own Blame navigation. The extension only records
      // the intent and waits for the host switch to settle.
      beginNavigationTransition(viewTransition.VIEWS.BLAME);
    }
  });

  apply();
})(window);
