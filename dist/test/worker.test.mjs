import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const workerSource = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');

function createWorker(fetchImpl) {
  let listener = null;
  const context = {
    ArrayBuffer,
    TextDecoder,
    Uint8Array,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    fetch: fetchImpl,
    chrome: {
      runtime: {
        onMessage: {
          addListener(callback) {
            listener = callback;
          },
        },
      },
    },
  };
  vm.runInNewContext(workerSource, context, { filename: 'worker.js' });
  assert.equal(typeof listener, 'function');

  return function dispatch(message, sender = { url: 'https://github.com/example/project/blob/main/index.html' }) {
    return new Promise(resolve => {
      const keepOpen = listener(message, sender, resolve);
      if (keepOpen === false) {
        // Synchronous validation failures call sendResponse before returning false.
      }
    });
  };
}

function response({ status = 200, contentType = 'text/html', body = '<!doctype html>' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => contentType },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('preserves a network failure code and request ID', async () => {
  const dispatch = createWorker(async () => {
    throw new TypeError('network failure');
  });

  const result = await dispatch({
    type: 'ghpreview:fetch',
    url: 'https://github.com/example/project/raw/main/index.html',
    requestId: 'request-network',
  });

  assert.deepEqual(plain(result), {
    ok: false,
    status: 0,
    errorCode: 'fetch-failed',
    requestId: 'request-network',
  });
});

test('preserves HTTP failure information and request ID', async () => {
  const dispatch = createWorker(async () => response({ status: 404 }));

  const result = await dispatch({
    type: 'ghpreview:fetch',
    url: 'https://github.com/example/project/raw/main/missing.html',
    requestId: 'request-http',
  });

  assert.deepEqual(plain(result), {
    ok: false,
    status: 404,
    errorCode: 'http-error',
    requestId: 'request-http',
  });
});

test('rejects invalid senders and targets without fetching', async () => {
  let fetchCount = 0;
  const dispatch = createWorker(async () => {
    fetchCount += 1;
    return response();
  });

  const invalidSender = await dispatch(
    {
      type: 'ghpreview:fetch',
      url: 'https://github.com/example/project/raw/main/index.html',
      requestId: 'request-sender',
    },
    { url: 'https://example.test/page' },
  );
  const invalidTarget = await dispatch({
    type: 'ghpreview:fetch',
    url: 'https://example.test/private.html',
    requestId: 'request-target',
  });

  assert.deepEqual(plain(invalidSender), {
    ok: false,
    status: 0,
    errorCode: 'invalid-sender',
    requestId: 'request-sender',
  });
  assert.deepEqual(plain(invalidTarget), {
    ok: false,
    status: 0,
    errorCode: 'invalid-target',
    requestId: 'request-target',
  });
  assert.equal(fetchCount, 0);
});

test('returns a successful payload with the request ID', async () => {
  const dispatch = createWorker(async () => response({ body: '<h1>ok</h1>' }));

  const result = await dispatch({
    type: 'ghpreview:fetch',
    url: 'https://github.com/example/project/raw/main/index.html',
    requestId: 'request-success',
  });

  assert.equal(result.ok, true);
  assert.equal(result.requestId, 'request-success');
  assert.equal(result.contentType, 'text/html');
  assert.equal(result.text, '<h1>ok</h1>');
  assert.equal(typeof result.base64, 'string');
});
