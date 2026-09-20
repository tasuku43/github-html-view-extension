/*
 * Decide which repository code is trusted.
 *
 * Entries are controlled by the person using the extension. The repository does not
 * provide a configuration file or an implicit approval workflow.
 *
 * **Do not add wildcards.** Allowing `owner/*` would silently trust repositories added
 * later. This list is intentionally explicit (see GOAL.md).
 */
(function initAllowlist(global) {
  'use strict';

  // Characters accepted by GitHub owner and repository names. Wildcards are excluded.
  const ENTRY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

  /**
   * Parse one entry per line. Text after `#` is a comment and empty lines are ignored.
   */
  function parseAllowlist(text) {
    if (typeof text !== 'string') {
      return [];
    }
    return text
      .split('\n')
      .map(line => line.split('#')[0].trim())
      .filter(line => line !== '');
  }

  /** Check whether an entry has the accepted format. */
  function isValidEntry(entry) {
    return ENTRY.test(entry);
  }

  /** Validate entries before saving and return invalid lines for user feedback. */
  function validate(entries) {
    const valid = [];
    const invalid = [];
    entries.forEach(entry => {
      (isValidEntry(entry) ? valid : invalid).push(entry);
    });
    return { valid, invalid };
  }

  /**
   * Check whether this repository is enabled.
   *
   * Matching is case-insensitive, following GitHub repository identity behavior.
   * Only case is ignored; every other character must match exactly.
   */
  function isAllowed(repoKey, entries) {
    if (typeof repoKey !== 'string' || repoKey === '') {
      return false;
    }
    const wanted = repoKey.toLowerCase();
    return entries.some(entry => isValidEntry(entry) && entry.toLowerCase() === wanted);
  }

  global.GHPREVIEW = global.GHPREVIEW || {};
  global.GHPREVIEW.allowlist = {
    parseAllowlist,
    isValidEntry,
    validate,
    isAllowed,
  };
})(typeof window === 'undefined' ? globalThis : window);
