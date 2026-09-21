import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScript } from './helpers/load.mjs';

function loadGithubDom(document) {
  const window = { GHPREVIEW: { inline: {} } };
  loadScript('dom.js', { window, document });
  return window.GHPREVIEW.githubDom;
}

test('detects GitHub missing-file responses before inserting Preview', () => {
  const githubDom = loadGithubDom({
    title: 'File not found · GitHub',
    querySelector: () => null,
  });

  assert.equal(githubDom.isMissingFilePage(), true);
});

test('detects the semantic missing-file marker in a client-rendered GitHub page', () => {
  const githubDom = loadGithubDom({
    title: 'github/docs · GitHub',
    querySelector: selector =>
      selector === '[data-testid="error-404-description"]' ? {} : null,
  });

  assert.equal(githubDom.isMissingFilePage(), true);
});

test('does not classify a normal GitHub file page as missing', () => {
  const githubDom = loadGithubDom({
    title: 'page-with-sections.html at main · github/docs · GitHub',
    querySelector: () => null,
  });

  assert.equal(githubDom.isMissingFilePage(), false);
});

test('keeps forms and popups disabled while allowing optional dialogs', () => {
  const githubDom = loadGithubDom({
    title: 'page-with-sections.html at main · github/docs · GitHub',
    querySelector: () => null,
  });

  assert.equal(
    githubDom.sandboxPolicy({ forms: true, popups: true, modals: false }),
    'allow-scripts',
  );
  assert.equal(
    githubDom.sandboxPolicy({ forms: true, popups: true, modals: true }),
    'allow-scripts allow-modals',
  );
});
