/*
 * This script runs inside the opaque-origin sandbox and opens the received HTML here.
 *
 * document.write is used because it is the supported way to execute scripts inside the
 * received document. Scripts inserted through innerHTML do not execute, which would
 * break interactive diagrams. This page is the deliberately isolated execution area.
 */
(function initSandbox() {
  'use strict';

  const PREFIX = 'ghpreview:';
  const PARENT_ORIGIN = 'https://github.com';
  const BOOTSTRAP = PREFIX + 'sandbox-bootstrap';
  const READY = PREFIX + 'sandbox-ready';
  const PING = PREFIX + 'sandbox-ping';
  const RENDER = PREFIX + 'render';
  const RENDER_STARTED = PREFIX + 'render-started';
  const RUNTIME_ERROR = PREFIX + 'runtime-error';
  const sessionId = new URL(window.location.href).searchParams.get('session') || '';

  function post(type, detail) {
    window.parent.postMessage({ type, sessionId, ...(detail || {}) }, 'https://github.com');
  }

  console.debug(
    '[html-preview] ' +
      JSON.stringify({
        event: 'sandbox-bootstrap',
        phase: 'sandbox',
        sessionId,
      }),
  );

  function onMessage(event) {
    // Verify both the parent window and the expected parent origin. Without this check,
    // an unrelated window could inject HTML into the sandbox.
    if (event.source !== window.parent) {
      return;
    }
    if (event.origin !== PARENT_ORIGIN) {
      return;
    }
    if (!event.data) {
      return;
    }
    if (event.data.sessionId !== sessionId) {
      return;
    }
    if (event.data.type === PING) {
      post(READY);
      return;
    }
    if (event.data.type !== RENDER) {
      return;
    }
    if (typeof event.data.html !== 'string') {
      return;
    }

    console.debug(
      '[html-preview] ' +
        JSON.stringify({
          event: 'render-received',
          phase: 'sandbox',
          sessionId,
          detail: { htmlLength: event.data.html.length },
        }),
    );

    post(RENDER_STARTED);
    window.removeEventListener('message', onMessage);
    document.open();
    document.write(event.data.html);
    document.close();
  }

  window.addEventListener('message', onMessage);

  // Signal readiness before the parent sends the document.
  console.debug(
    '[html-preview] ' +
      JSON.stringify({
        event: 'sandbox-ready',
        phase: 'sandbox',
        sessionId,
      }),
  );
  post(BOOTSTRAP);
  post(READY);
})();
