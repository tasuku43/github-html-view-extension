import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const workerSource = fs.readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
const workerRoot = new URL('../src/', import.meta.url);

function createWorker(
  fetchImpl,
  settingsValue = {
    schemaVersion: 2,
    previewEnabled: true,
    capabilities: { javascript: true, modals: false },
    repositories: ['example/project'],
  },
) {
  let listener = null;
  let storedSettings = settingsValue;
  const context = vm.createContext({
    ArrayBuffer,
    URL,
    TextDecoder,
    Uint8Array,
    fetch: fetchImpl,
    chrome: {
      runtime: {
        lastError: undefined,
        onMessage: {
          addListener(callback) {
            listener = callback;
          },
        },
      },
      storage: {
        local: {
          get(key, callback) {
            callback({ [key]: storedSettings });
          },
          set(value, callback) {
            storedSettings = value.settings;
            callback();
          },
        },
      },
    },
  });
  context.importScripts = (...scripts) => {
    scripts.forEach(script => {
      const source = fs.readFileSync(new URL(script, workerRoot), 'utf8');
      vm.runInContext(source, context, { filename: script });
    });
  };
  vm.runInContext(workerSource, context, { filename: 'worker.js' });
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
});

test('rejects a fetch when the master Preview switch is off', async () => {
  let fetchCount = 0;
  const dispatch = createWorker(
    async () => {
      fetchCount += 1;
      return response();
    },
    {
      previewEnabled: false,
      capabilities: {},
      repositories: ['example/project'],
    },
  );

  const result = await dispatch({
    type: 'ghpreview:fetch',
    url: 'https://github.com/example/project/raw/main/index.html',
    requestId: 'request-disabled',
  });

  assert.deepEqual(plain(result), {
    ok: false,
    status: 0,
    errorCode: 'preview-disabled',
    requestId: 'request-disabled',
  });
  assert.equal(fetchCount, 0);
});

test('rejects a fetch when the sender repository is not allowlisted', async () => {
  let fetchCount = 0;
  const dispatch = createWorker(
    async () => {
      fetchCount += 1;
      return response();
    },
    {
      previewEnabled: true,
      capabilities: {},
      repositories: ['another/project'],
    },
  );

  const result = await dispatch({
    type: 'ghpreview:fetch',
    url: 'https://github.com/example/project/raw/main/index.html',
    requestId: 'request-not-allowed',
  });

  assert.deepEqual(plain(result), {
    ok: false,
    status: 0,
    errorCode: 'repository-not-allowed',
    requestId: 'request-not-allowed',
  });
  assert.equal(fetchCount, 0);
});

test('rejects a raw target from a different repository', async () => {
  let fetchCount = 0;
  const dispatch = createWorker(async () => {
    fetchCount += 1;
    return response();
  });

  const result = await dispatch({
    type: 'ghpreview:fetch',
    url: 'https://github.com/other/project/raw/main/index.html',
    requestId: 'request-mismatch',
  });

  assert.deepEqual(plain(result), {
    ok: false,
    status: 0,
    errorCode: 'repository-mismatch',
    requestId: 'request-mismatch',
  });
  assert.equal(fetchCount, 0);
});

test('trusts the exact sender repository and persists it without fetching', async () => {
  let fetchCount = 0;
  const dispatch = createWorker(
    async () => {
      fetchCount += 1;
      return response();
    },
    {
      previewEnabled: true,
      capabilities: {},
      repositories: [],
    },
  );

  const result = await dispatch({
    type: 'ghpreview:trust-repository',
    requestId: 'request-trust',
  }, {
    url: 'https://github.com/Example-Owner/Example-Repo/blob/main/index.html',
  });

  assert.deepEqual(plain(result), {
    ok: true,
    requestId: 'request-trust',
    alreadyAllowed: false,
  });
  assert.equal(fetchCount, 0);
});

test('trust requests are idempotent for case-insensitive repository identity', async () => {
  const dispatch = createWorker(
    async () => response(),
    {
      previewEnabled: true,
      capabilities: {},
      repositories: [],
    },
  );
  const sender = { url: 'https://github.com/Example-Owner/Example-Repo/blob/main/index.html' };

  const first = await dispatch({
    type: 'ghpreview:trust-repository',
    requestId: 'request-trust-first',
  }, sender);
  const second = await dispatch({
    type: 'ghpreview:trust-repository',
    requestId: 'request-trust-second',
  }, {
    url: 'https://github.com/example-owner/example-repo/blob/main/other.html',
  });

  assert.equal(first.ok, true);
  assert.equal(first.alreadyAllowed, false);
  assert.deepEqual(plain(second), {
    ok: true,
    requestId: 'request-trust-second',
    alreadyAllowed: true,
  });
});

test('rejects trust requests when Preview is disabled or the sender is not a GitHub HTML page', async () => {
  const disabled = createWorker(
    async () => response(),
    {
      previewEnabled: false,
      capabilities: {},
      repositories: [],
    },
  );
  const disabledResult = await disabled({
    type: 'ghpreview:trust-repository',
    requestId: 'request-trust-disabled',
  });
  const invalidSender = await disabled({
    type: 'ghpreview:trust-repository',
    requestId: 'request-trust-sender',
  }, { url: 'https://example.test/page' });

  assert.deepEqual(plain(disabledResult), {
    ok: false,
    status: 0,
    errorCode: 'preview-disabled',
    requestId: 'request-trust-disabled',
  });
  assert.deepEqual(plain(invalidSender), {
    ok: false,
    status: 0,
    errorCode: 'invalid-sender',
    requestId: 'request-trust-sender',
  });
});
