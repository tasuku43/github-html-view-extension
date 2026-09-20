// The allowlist must remain explicit; wildcard entries must never be accepted.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScript } from './helpers/load.mjs';

const window = {};
loadScript('allowlist.js', { window });
const { parseAllowlist, isValidEntry, validate, isAllowed } = window.GHPREVIEW.allowlist;

test('parses one entry per line and ignores blank lines and comments', () => {
  const text = [
    'example-owner/design-docs',
    '',
    '  example-owner/handbook  # Documentation repository',
    '# A comment-only line',
  ].join('\n');
  assert.deepEqual(parseAllowlist(text), ['example-owner/design-docs', 'example-owner/handbook']);
});

test('treats missing or empty settings as an empty allowlist', () => {
  assert.deepEqual(parseAllowlist(undefined), []);
  assert.deepEqual(parseAllowlist(''), []);
});

test('rejects wildcard entries', () => {
  assert.equal(isValidEntry('example-owner/*'), false);
  assert.equal(isValidEntry('*/design-docs'), false);
  assert.equal(isValidEntry('*'), false);
  assert.equal(isAllowed('example-owner/design-docs', ['example-owner/*']), false);
});

test('rejects values that are not owner/name entries', () => {
  assert.equal(isValidEntry('example-owner'), false);
  assert.equal(isValidEntry('example-owner/design-docs/extra'), false);
  assert.equal(isValidEntry('https://github.com/example-owner/design-docs'), false);
  assert.equal(isValidEntry('example-owner / design-docs'), false);
  assert.equal(isValidEntry('example-owner/design-docs'), true);
  assert.equal(isValidEntry('example-owner/design_docs.v2'), true);
});

test('returns invalid lines for user feedback instead of discarding them', () => {
  const checked = validate(['example-owner/design-docs', 'example-owner/*', 'example-owner']);
  assert.deepEqual(checked.valid, ['example-owner/design-docs']);
  assert.deepEqual(checked.invalid, ['example-owner/*', 'example-owner']);
});

test('matches case-insensitively but requires every other character to match', () => {
  const entries = ['Example-Owner/Design-Docs'];
  assert.equal(isAllowed('example-owner/design-docs', entries), true);
  assert.equal(isAllowed('example-owner/design-docs-2', entries), false);
  assert.equal(isAllowed('example-owner/design', entries), false);
  assert.equal(isAllowed('other/design-docs', entries), false);
});

test('does not enable any repository when the allowlist is empty', () => {
  assert.equal(isAllowed('example-owner/design-docs', []), false);
  assert.equal(isAllowed('', ['example-owner/design-docs']), false);
});
