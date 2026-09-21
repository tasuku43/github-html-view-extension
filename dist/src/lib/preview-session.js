/*
 * Own the identity and lifetime of one Preview operation.
 *
 * The content controller still coordinates fetching and DOM work, but it must not
 * invent request/session identity in several places. A session becomes invalid when
 * navigation, recheck, or another operation replaces it; late async results can then
 * be rejected without relying on timing alone.
 */
(function initPreviewSession(global) {
  'use strict';

  const PHASES = new Set([
    'idle',
    'detecting',
    'checking-settings',
    'fetching',
    'validating',
    'mounting',
    'waiting-for-sandbox',
    'rendering',
    'waiting-for-height',
    'ready',
    'trust-required',
    'disabled',
    'failed',
    'stale',
  ]);

  let idCounter = 0;

  function createId(prefix) {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return prefix + '-' + global.crypto.randomUUID();
    }
    idCounter += 1;
    return prefix + '-' + Date.now().toString(36) + '-' + idCounter.toString(36);
  }

  function create(href, previous = null) {
    return {
      href,
      requestId: createId('request'),
      sessionId: null,
      generation:
        previous && Number.isInteger(previous.generation) ? previous.generation + 1 : 1,
      phase: 'idle',
      status: 'active',
      invalidatedReason: null,
    };
  }

  function isCurrent(session, active, href) {
    return (
      session !== null &&
      session === active &&
      session.status === 'active' &&
      session.href === href
    );
  }

  function invalidate(session, reason = 'replaced') {
    if (session === null) {
      return null;
    }
    session.status = 'invalidated';
    session.invalidatedReason = reason;
    session.phase = 'stale';
    return session;
  }

  function attachSandbox(session) {
    if (session === null) {
      return null;
    }
    if (session.sessionId === null) {
      session.sessionId = createId('session');
    }
    return session.sessionId;
  }

  function setPhase(session, phase) {
    if (session === null || !PHASES.has(phase)) {
      return false;
    }
    session.phase = phase;
    return true;
  }

  global.GHPREVIEW = global.GHPREVIEW || {};
  global.GHPREVIEW.previewSession = {
    PHASES,
    create,
    isCurrent,
    invalidate,
    attachSandbox,
    setPhase,
  };
})(typeof window === 'undefined' ? globalThis : window);
