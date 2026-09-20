/*
 * The extension settings page.
 *
 * Invalid entries are not saved, and the rejected values are shown to the user.
 * Silently dropping them would make the settings appear ineffective.
 */
(function initOptions(global) {
  'use strict';

  const { allowlist } = global.GHPREVIEW;
  const KEY = 'allowlist';

  const entries = document.getElementById('entries');
  const status = document.getElementById('status');

  function say(message, isError) {
    status.textContent = message;
    status.classList.toggle('ghpreview-error', Boolean(isError));
  }

  chrome.storage.local.get(KEY, stored => {
    entries.value = typeof stored[KEY] === 'string' ? stored[KEY] : '';
  });

  document.getElementById('save').addEventListener('click', () => {
    const parsed = allowlist.parseAllowlist(entries.value);
    const checked = allowlist.validate(parsed);

    if (checked.invalid.length > 0) {
      say('These entries are not valid owner/name values: ' + checked.invalid.join(', '), true);
      return;
    }

    chrome.storage.local.set({ [KEY]: entries.value }, () => {
      if (chrome.runtime.lastError) {
        say('Could not save changes: ' + chrome.runtime.lastError.message, true);
        return;
      }
      say(
        checked.valid.length === 0
          ? 'Changes saved. No repositories are currently enabled.'
          : 'Changes saved. ' + checked.valid.length + ' repositories enabled.',
        false,
      );
    });
  });
})(window);
