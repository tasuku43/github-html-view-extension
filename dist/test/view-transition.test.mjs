// The navigation contract is deliberately pure so it can be verified without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScripts } from './helpers/load.mjs';

const window = {};
loadScripts(['blob-url.js', 'view-transition.js'], { window });
const { viewTransition } = window.GHPREVIEW;

const BLOB_PREVIEW = 'https://github.com/example-owner/design-docs/blob/main/docs/page.html';
const BLOB_CODE = BLOB_PREVIEW + '?plain=1';
const BLAME = 'https://github.com/example-owner/design-docs/blame/main/docs/page.html';

function state(url) {
  const inspected = viewTransition.inspect(url);
  return {
    route: inspected.route,
    selectedView: inspected.selectedView,
    previewAvailable: inspected.previewAvailable,
    renderPreview: inspected.renderPreview,
  };
}

test('describes the default Blob view as selected Preview', () => {
  assert.deepEqual(state(BLOB_PREVIEW), {
    route: 'blob',
    selectedView: 'preview',
    previewAvailable: true,
    renderPreview: true,
  });
});

test('describes ?plain=1 as selected Code while keeping Preview available', () => {
  assert.deepEqual(state(BLOB_CODE), {
    route: 'blob',
    selectedView: 'code',
    previewAvailable: true,
    renderPreview: false,
  });
});

test('describes Blame as selected Blame while keeping Preview available', () => {
  assert.deepEqual(state(BLAME), {
    route: 'blame',
    selectedView: 'blame',
    previewAvailable: true,
    renderPreview: false,
  });
});

test('does not treat Markdown or non-file pages as previewable', () => {
  assert.equal(viewTransition.inspect(BLOB_PREVIEW.replace('.html', '.md')).supported, false);
  assert.equal(viewTransition.inspect('https://github.com/example-owner/design-docs').supported, false);
});

test('plans Preview from Blob without changing the route', () => {
  const plan = viewTransition.plan(BLOB_CODE, viewTransition.VIEWS.PREVIEW);
  assert.equal(plan.action, 'replace-state');
  assert.equal(plan.destinationHref, BLOB_PREVIEW);
  assert.deepEqual(plan.expected, {
    route: 'blob',
    selectedView: 'preview',
    previewAvailable: true,
    renderPreview: true,
  });
});

test('plans Preview from Blame as a Blob navigation', () => {
  const plan = viewTransition.plan(BLAME, viewTransition.VIEWS.PREVIEW);
  assert.equal(plan.action, 'navigate');
  assert.equal(plan.destinationHref, BLOB_PREVIEW);
  assert.deepEqual(plan.expected, {
    route: 'blob',
    selectedView: 'preview',
    previewAvailable: true,
    renderPreview: true,
  });
});

test('plans Code from Preview as the GitHub source view', () => {
  const plan = viewTransition.plan(BLOB_PREVIEW, viewTransition.VIEWS.CODE);
  assert.equal(plan.action, 'replace-state');
  assert.equal(plan.destinationHref, BLOB_CODE);
  assert.deepEqual(plan.expected, {
    route: 'blob',
    selectedView: 'code',
    previewAvailable: true,
    renderPreview: false,
  });
});

test('plans Blame to Code as a Blob source-view navigation', () => {
  const plan = viewTransition.plan(BLAME, viewTransition.VIEWS.CODE);
  assert.equal(plan.action, 'navigate');
  assert.equal(plan.destinationHref, BLOB_CODE);
  assert.deepEqual(plan.expected, {
    route: 'blob',
    selectedView: 'code',
    previewAvailable: true,
    renderPreview: false,
  });
});

test('delegates navigation to GitHub for Blame while preserving the Preview contract', () => {
  const plan = viewTransition.plan(BLOB_PREVIEW, viewTransition.VIEWS.BLAME);
  assert.equal(plan.action, 'follow-github');
  assert.equal(plan.destinationHref, null);
  assert.deepEqual(plan.expected, {
    route: 'blame',
    selectedView: 'blame',
    previewAvailable: true,
    renderPreview: false,
  });
});

test('preserves slash-containing refs when planning source navigation', () => {
  const blame = 'https://github.com/example-owner/design-docs/blame/feature/new/docs/page.html';
  const plan = viewTransition.plan(blame, viewTransition.VIEWS.CODE);
  assert.equal(
    plan.destinationHref,
    'https://github.com/example-owner/design-docs/blob/feature/new/docs/page.html?plain=1',
  );
});
