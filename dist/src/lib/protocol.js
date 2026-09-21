/*
 * Define the small parent/sandbox message contract shared by both sides.
 *
 * The sandbox has an opaque origin, so protocol version and session identity are
 * validated in addition to the message source and expected origin.
 */
(function initProtocol(global) {
  'use strict';

  const VERSION = 1;

  function create(type, sessionId, detail = {}) {
    return {
      protocolVersion: VERSION,
      type,
      sessionId,
      ...detail,
    };
  }

  function isMessage(value, type = null) {
    return (
      value !== null &&
      typeof value === 'object' &&
      value.protocolVersion === VERSION &&
      typeof value.type === 'string' &&
      (type === null || value.type === type)
    );
  }

  global.GHPREVIEW = global.GHPREVIEW || {};
  global.GHPREVIEW.protocol = { VERSION, create, isMessage };
})(typeof window === 'undefined' ? globalThis : window);
