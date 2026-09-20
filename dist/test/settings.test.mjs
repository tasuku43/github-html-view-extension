import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScript } from './helpers/load.mjs';

const window = {};
loadScript('settings.js', { window });
const { settings } = window.GHPREVIEW;

test('creates the safe disabled-by-default settings object', () => {
  assert.deepEqual(settings.createDefault(), {
    schemaVersion: 1,
    previewEnabled: false,
    capabilities: {
      javascript: false,
      forms: false,
      popups: false,
      modals: false,
    },
    repositories: [],
  });
});

test('normalizes capabilities and removes malformed or duplicate repositories', () => {
  assert.deepEqual(
    settings.normalize({
      previewEnabled: true,
      capabilities: { javascript: 1, forms: true, popups: true },
      repositories: [
        'Example-Owner/Example-Repo',
        'example-owner/example-repo',
        'owner/*',
        'not a repository',
      ],
    }),
    {
      schemaVersion: 1,
      previewEnabled: true,
      capabilities: { javascript: false, forms: true, popups: true, modals: false },
      repositories: ['Example-Owner/Example-Repo'],
    },
  );
});

test('rejects wildcard and malformed repository entries with distinct codes', () => {
  assert.equal(settings.validateRepository('owner/*').code, 'wildcard-not-allowed');
  assert.equal(settings.validateRepository('owner').code, 'invalid-repository');
  assert.equal(settings.validateRepository('owner/repository').valid, true);
});

test('adds exact entries and rejects case-insensitive duplicates', () => {
  const first = settings.addRepository(settings.createDefault(), 'Example-Owner/Example-Repo');
  assert.equal(first.error, null);
  assert.deepEqual(first.settings.repositories, ['Example-Owner/Example-Repo']);

  const duplicate = settings.addRepository(first.settings, 'example-owner/example-repo');
  assert.equal(duplicate.error.code, 'duplicate-repository');
  assert.deepEqual(duplicate.settings.repositories, ['Example-Owner/Example-Repo']);
});

test('matches repository identity without case sensitivity', () => {
  const configured = settings.normalize({ repositories: ['Example-Owner/Example-Repo'] });
  assert.equal(settings.isAllowed('example-owner/example-repo', configured), true);
  assert.equal(settings.isAllowed('example-owner/another-repo', configured), false);
});
