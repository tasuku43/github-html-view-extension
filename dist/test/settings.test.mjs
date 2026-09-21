import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScript } from './helpers/load.mjs';

const window = {};
loadScript('settings.js', { window });
const { settings } = window.GHPREVIEW;

test('creates the safe disabled-by-default settings object', () => {
  assert.deepEqual(settings.createDefault(), {
    schemaVersion: 2,
    previewEnabled: false,
    capabilities: {
      javascript: false,
      modals: false,
    },
    repositories: [],
  });
});

test('normalizes supported capabilities and removes retired capabilities', () => {
  assert.deepEqual(
    settings.normalize({
      previewEnabled: true,
      capabilities: { javascript: true, forms: true, popups: true, modals: true },
      repositories: [
        'Example-Owner/Example-Repo',
        'example-owner/example-repo',
        'owner/*',
        'not a repository',
      ],
    }),
    {
      schemaVersion: 2,
      previewEnabled: true,
      capabilities: { javascript: true, modals: true },
      repositories: ['Example-Owner/Example-Repo'],
    },
  );
});

test('exposes only the capabilities supported by the current product contract', () => {
  assert.deepEqual(settings.CAPABILITIES, ['javascript', 'modals']);
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
