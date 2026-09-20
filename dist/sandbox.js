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

  function onMessage(event) {
    // Verify both the parent window and the expected parent origin. Without this check,
    // an unrelated window could inject HTML into the sandbox.
    if (event.source !== window.parent) {
      return;
    }
    if (event.origin !== PARENT_ORIGIN) {
      return;
    }
    if (!event.data || event.data.type !== PREFIX + 'render') {
      return;
    }
    if (typeof event.data.html !== 'string') {
      return;
    }

    window.removeEventListener('message', onMessage);
    document.open();
    document.write(event.data.html);
    document.close();
  }

  window.addEventListener('message', onMessage);

  // Signal readiness before the parent sends the document.
  window.parent.postMessage({ type: PREFIX + 'sandbox-ready' }, PARENT_ORIGIN);
})();
