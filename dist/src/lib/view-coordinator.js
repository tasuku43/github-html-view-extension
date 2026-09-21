/*
 * Coordinate the user-visible file view independently from GitHub's route and DOM.
 *
 * GitHub owns the Code and Blame routes. The extension owns the Preview peer, so a route
 * transition can temporarily have a native carrier view without exposing that carrier to
 * the user. Keeping this state pure makes the handoff contract testable without a browser.
 */
(function initViewCoordinator(global) {
  'use strict';

  const VIEWS = Object.freeze({
    PREVIEW: 'preview',
    CODE: 'code',
    BLAME: 'blame',
  });

  const PHASES = Object.freeze({
    STABLE: 'stable',
    INTENT: 'intent',
    HOST_NAVIGATION: 'host-navigation',
    HANDOFF: 'handoff',
    SETTLED: 'settled',
  });

  let idCounter = 0;

  function createId() {
    idCounter += 1;
    return 'view-' + Date.now().toString(36) + '-' + idCounter.toString(36);
  }

  function copy(state) {
    return { ...state };
  }

  function create(initialView = null) {
    let state = {
      phase: PHASES.STABLE,
      desiredView: initialView,
      presentedView: initialView,
      hostView: initialView,
      hostReady: false,
      hostSignature: null,
      transactionId: null,
      previousView: null,
    };

    function begin(target, previousView = state.presentedView) {
      if (!Object.values(VIEWS).includes(target)) {
        return copy(state);
      }
      state = {
        ...state,
        phase: PHASES.INTENT,
        desiredView: target,
        transactionId: createId(),
        previousView,
        hostReady: false,
      };
      return copy(state);
    }

    function beginHostNavigation() {
      if (state.transactionId === null) {
        return copy(state);
      }
      state = { ...state, phase: PHASES.HOST_NAVIGATION };
      return copy(state);
    }

    function observeHost({ view = null, ready = false, signature = null } = {}) {
      state = {
        ...state,
        hostView: view,
        hostReady: ready,
        hostSignature: signature,
      };
      if (state.transactionId !== null && ready) {
        if (state.desiredView === VIEWS.PREVIEW) {
          state = { ...state, phase: PHASES.HANDOFF };
        } else if (state.desiredView === view) {
          state = { ...state, phase: PHASES.SETTLED };
        }
      }
      return copy(state);
    }

    function commitPresented(view) {
      if (!Object.values(VIEWS).includes(view)) {
        return copy(state);
      }
      state = {
        ...state,
        presentedView: view,
        phase:
          state.transactionId !== null && state.desiredView === view
            ? PHASES.SETTLED
            : state.phase,
      };
      return copy(state);
    }

    function finish() {
      state = {
        ...state,
        phase: PHASES.STABLE,
        presentedView: state.desiredView,
        transactionId: null,
        previousView: null,
      };
      return copy(state);
    }

    function cancel() {
      state = {
        ...state,
        phase: PHASES.STABLE,
        desiredView: state.presentedView,
        transactionId: null,
        previousView: null,
      };
      return copy(state);
    }

    return Object.freeze({
      begin,
      beginHostNavigation,
      observeHost,
      commitPresented,
      finish,
      cancel,
      snapshot: () => copy(state),
      isLocked: () => state.transactionId !== null,
      wants: view => state.desiredView === view,
    });
  }

  global.GHPREVIEW = global.GHPREVIEW || {};
  global.GHPREVIEW.viewCoordinator = { VIEWS, PHASES, create };
})(typeof window === 'undefined' ? globalThis : window);
