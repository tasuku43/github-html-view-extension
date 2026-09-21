// Session identity is independent of Chrome APIs and the DOM, so stale-operation
// behavior can be tested deterministically in Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScript } from './helpers/load.mjs';

const window = {};
loadScript('preview-session.js', { window });
const { previewSession } = window.GHPREVIEW;

const FIRST_URL = 'https://github.com/example-owner/design-docs/blob/main/page.html';
const SECOND_URL = 'https://github.com/example-owner/design-docs/blob/main/other.html';

test('creates an active operation with a first generation', () => {
  const session = previewSession.create(FIRST_URL);

  assert.equal(session.href, FIRST_URL);
  assert.match(session.requestId, /^request-/);
  assert.equal(session.sessionId, null);
  assert.equal(session.generation, 1);
  assert.equal(session.phase, 'idle');
  assert.equal(session.status, 'active');
  assert.equal(previewSession.isCurrent(session, session, FIRST_URL), true);
});

test('increments generation when a navigation replaces an operation', () => {
  const first = previewSession.create(FIRST_URL);
  previewSession.invalidate(first, 'navigation');
  const second = previewSession.create(SECOND_URL, first);

  assert.equal(first.status, 'invalidated');
  assert.equal(first.phase, 'stale');
  assert.equal(first.invalidatedReason, 'navigation');
  assert.equal(second.generation, 2);
  assert.equal(previewSession.isCurrent(first, second, FIRST_URL), false);
  assert.equal(previewSession.isCurrent(second, second, SECOND_URL), true);
});

test('rejects a late result after the current URL changes', () => {
  const session = previewSession.create(FIRST_URL);
  assert.equal(previewSession.isCurrent(session, session, SECOND_URL), false);

  previewSession.invalidate(session, 'stale-operation');
  assert.equal(previewSession.isCurrent(session, session, FIRST_URL), false);
  assert.equal(session.invalidatedReason, 'stale-operation');
});

test('assigns one stable sandbox session ID per operation', () => {
  const session = previewSession.create(FIRST_URL);
  const firstId = previewSession.attachSandbox(session);
  const secondId = previewSession.attachSandbox(session);

  assert.match(firstId, /^session-/);
  assert.equal(secondId, firstId);
  assert.equal(session.sessionId, firstId);
});

test('tracks lifecycle phases without accepting unknown states', () => {
  const session = previewSession.create(FIRST_URL);

  assert.equal(previewSession.setPhase(session, 'fetching'), true);
  assert.equal(session.phase, 'fetching');
  assert.equal(previewSession.setPhase(session, 'trust-required'), true);
  assert.equal(session.phase, 'trust-required');
  assert.equal(previewSession.setPhase(session, 'unknown'), false);
  assert.equal(session.phase, 'trust-required');
});
