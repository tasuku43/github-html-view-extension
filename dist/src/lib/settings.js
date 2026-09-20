/*
 * Own the persisted settings contract shared by the Popup, content script, and Worker.
 *
 * Settings are intentionally small and JSON-shaped. The Popup is a convenience surface;
 * the Worker is still the final enforcement point before any GitHub content is fetched.
 */
(function initSettings(global) {
  'use strict';

  const STORAGE_KEY = 'settings';
  const SCHEMA_VERSION = 1;
  const CAPABILITIES = ['javascript', 'forms', 'popups', 'modals'];
  const ENTRY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

  function createDefault() {
    return {
      schemaVersion: SCHEMA_VERSION,
      previewEnabled: false,
      capabilities: {
        javascript: false,
        forms: false,
        popups: false,
        modals: false,
      },
      repositories: [],
    };
  }

  function normalizeEntry(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function validateRepository(value) {
    const entry = normalizeEntry(value);
    if (entry === '') {
      return { valid: false, code: 'empty-repository', entry };
    }
    if (entry.includes('*')) {
      return { valid: false, code: 'wildcard-not-allowed', entry };
    }
    if (!ENTRY.test(entry)) {
      return { valid: false, code: 'invalid-repository', entry };
    }
    return { valid: true, code: null, entry };
  }

  function normalize(value) {
    const source = value && typeof value === 'object' ? value : {};
    const sourceCapabilities =
      source.capabilities && typeof source.capabilities === 'object' ? source.capabilities : {};
    const repositories = [];
    const seen = new Set();
    const sourceRepositories = Array.isArray(source.repositories) ? source.repositories : [];

    sourceRepositories.forEach(valueToCheck => {
      const checked = validateRepository(valueToCheck);
      if (!checked.valid) {
        return;
      }
      const key = checked.entry.toLowerCase();
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      repositories.push(checked.entry);
    });

    return {
      schemaVersion: SCHEMA_VERSION,
      previewEnabled: source.previewEnabled === true,
      capabilities: CAPABILITIES.reduce((result, key) => {
        result[key] = sourceCapabilities[key] === true;
        return result;
      }, {}),
      repositories,
    };
  }

  function clone(value) {
    return normalize(value);
  }

  function isAllowed(repoKey, value) {
    const wanted = normalizeEntry(repoKey).toLowerCase();
    if (wanted === '') {
      return false;
    }
    return normalize(value).repositories.some(entry => entry.toLowerCase() === wanted);
  }

  function addRepository(value, entry) {
    const current = normalize(value);
    const checked = validateRepository(entry);
    if (!checked.valid) {
      return { settings: current, error: checked };
    }
    if (current.repositories.some(item => item.toLowerCase() === checked.entry.toLowerCase())) {
      return {
        settings: current,
        error: { valid: false, code: 'duplicate-repository', entry: checked.entry },
      };
    }
    current.repositories.push(checked.entry);
    return { settings: current, error: null };
  }

  function removeRepository(value, entry) {
    const current = normalize(value);
    const wanted = normalizeEntry(entry).toLowerCase();
    current.repositories = current.repositories.filter(item => item.toLowerCase() !== wanted);
    return current;
  }

  global.GHPREVIEW = global.GHPREVIEW || {};
  global.GHPREVIEW.settings = {
    STORAGE_KEY,
    SCHEMA_VERSION,
    CAPABILITIES,
    createDefault,
    normalize,
    clone,
    validateRepository,
    isAllowed,
    addRepository,
    removeRepository,
  };
})(typeof window === 'undefined' ? globalThis : window);
