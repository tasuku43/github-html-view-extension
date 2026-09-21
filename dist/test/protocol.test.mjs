import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScript } from './helpers/load.mjs';

const window = {};
loadScript('protocol.js', { window });
const { protocol } = window.GHPREVIEW;

test('creates versioned session messages', () => {
  assert.deepEqual(protocol.create('ghpreview:test', 'session-1', { value: 1 }), {
    protocolVersion: 1,
    type: 'ghpreview:test',
    sessionId: 'session-1',
    value: 1,
  });
});
test('rejects messages from another protocol version', () => {
  assert.equal(protocol.isMessage({ protocolVersion: 1, type: 'ghpreview:test' }), true);
  assert.equal(protocol.isMessage({ protocolVersion: 2, type: 'ghpreview:test' }), false);
  assert.equal(protocol.isMessage({ type: 'ghpreview:test' }), false);
  assert.equal(protocol.isMessage({ protocolVersion: 1, type: 'ghpreview:test' }, 'ghpreview:other'), false);
});
