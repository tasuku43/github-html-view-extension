/*
 * Fetch content for the content script.
 *
 * The content script does not fetch directly because /raw/ redirects to another host.
 * Following that redirect from the page world is subject to CORS. The extension worker
 * can follow it within the declared host_permissions.
 *
 * The request uses the viewer's cookies (credentials: 'include'). The extension does not
 * store tokens or sessions; GitHub remains responsible for access control (MODEL.md).
 */
'use strict';

importScripts('lib/blob-url.js', 'lib/settings.js');

const PREFIX = 'ghpreview:';
const TRUST = PREFIX + 'trust-repository';
const { blobUrl, settings } = globalThis.GHPREVIEW;

// Limit fetched source documents so a single preview cannot consume unbounded memory.
const LIMIT_BYTES = 8 * 1024 * 1024;

function encodeBase64(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const combined = (first << 16) | (second << 8) | third;
    output += alphabet[(combined >> 18) & 63];
    output += alphabet[(combined >> 12) & 63];
    output += index + 1 < bytes.length ? alphabet[(combined >> 6) & 63] : '=';
    output += index + 2 < bytes.length ? alphabet[combined & 63] : '=';
  }
  return output;
}

async function take(url, mode = 'text') {
  let response;
  try {
    response = await fetch(url, {
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-cache',
    });
  } catch (error) {
    return { ok: false, status: 0, errorCode: 'fetch-failed' };
  }
  if (!response.ok) {
    return { ok: false, status: response.status, errorCode: 'http-error' };
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > LIMIT_BYTES) {
    return { ok: false, status: 0, errorCode: 'payload-too-large' };
  }

  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim();
  const result = {
    ok: true,
    contentType,
    byteLength: buffer.byteLength,
  };
  if (mode === 'base64') {
    result.data = encodeBase64(new Uint8Array(buffer));
  } else {
    result.text = new TextDecoder('utf-8').decode(buffer);
  }
  return result;
}

function reject(code, requestId) {
  return { ok: false, status: 0, errorCode: code, requestId };
}

function repositoryFromRawUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    return null;
  }
  if (url.origin !== 'https://github.com') {
    return null;
  }
  const match = /^\/([^/]+)\/([^/]+)\/raw\//.exec(url.pathname);
  if (match === null) {
    return null;
  }
  return decodeURIComponent(match[1]) + '/' + decodeURIComponent(match[2]);
}

function loadSettings() {
  return new Promise((resolve, rejectSettings) => {
    chrome.storage.local.get(settings.STORAGE_KEY, stored => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        rejectSettings(new Error('settings-unavailable'));
        return;
      }
      resolve(settings.normalize(stored[settings.STORAGE_KEY]));
    });
  });
}

function saveSettings(value) {
  return new Promise((resolve, rejectSettings) => {
    chrome.storage.local.set({ [settings.STORAGE_KEY]: value }, () => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        rejectSettings(new Error('settings-unavailable'));
        return;
      }
      resolve();
    });
  });
}

function trustRepository(message, sender, sendResponse) {
  if (!sender.url || !sender.url.startsWith('https://github.com/')) {
    sendResponse(reject('invalid-sender', message.requestId));
    return false;
  }

  const senderFile = blobUrl.parseFileUrl(sender.url);
  if (senderFile === null || !blobUrl.isHtmlPath(senderFile.refAndPath)) {
    sendResponse(reject('invalid-target', message.requestId));
    return false;
  }

  const repository = blobUrl.repoKey(senderFile);
  loadSettings()
    .then(current => {
      if (!current.previewEnabled) {
        sendResponse(reject('preview-disabled', message.requestId));
        return null;
      }
      if (settings.isAllowed(repository, current)) {
        sendResponse({
          ok: true,
          requestId: message.requestId,
          alreadyAllowed: true,
        });
        return null;
      }

      const result = settings.addRepository(current, repository);
      if (result.error) {
        sendResponse(reject('trust-failed', message.requestId));
        return null;
      }
      return saveSettings(result.settings).then(() => {
        sendResponse({
          ok: true,
          requestId: message.requestId,
          alreadyAllowed: false,
        });
      });
    })
    .catch(error => {
      sendResponse(
        reject(
          error && error.message === 'settings-unavailable'
            ? 'settings-unavailable'
            : 'trust-failed',
          message.requestId,
        ),
      );
    });

  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return false;
  }
  if (message.type === TRUST) {
    return trustRepository(message, sender, sendResponse);
  }
  if (message.type !== PREFIX + 'fetch') {
    return false;
  }
  // Only a content script running on github.com may make this request.
  if (!sender.url || !sender.url.startsWith('https://github.com/')) {
    sendResponse(reject('invalid-sender', message.requestId));
    return false;
  }
  // Restrict fetch targets to github.com so the extension cannot become an arbitrary
  // URL reader.
  if (typeof message.url !== 'string' || !message.url.startsWith('https://github.com/')) {
    sendResponse(reject('invalid-target', message.requestId));
    return false;
  }
  if (message.mode !== undefined && message.mode !== 'text' && message.mode !== 'base64') {
    sendResponse(reject('invalid-mode', message.requestId));
    return false;
  }

  const senderFile = blobUrl.parseFileUrl(sender.url);
  const senderRepository = senderFile === null ? null : blobUrl.repoKey(senderFile);
  const targetRepository = repositoryFromRawUrl(message.url);
  if (senderRepository === null || targetRepository === null) {
    sendResponse(reject('invalid-target', message.requestId));
    return false;
  }
  if (senderRepository.toLowerCase() !== targetRepository.toLowerCase()) {
    sendResponse(reject('repository-mismatch', message.requestId));
    return false;
  }

  loadSettings()
    .then(current => {
      if (!current.previewEnabled) {
        sendResponse(reject('preview-disabled', message.requestId));
        return null;
      }
      if (!settings.isAllowed(senderRepository, current)) {
        sendResponse(reject('repository-not-allowed', message.requestId));
        return null;
      }
      return take(message.url, message.mode || 'text').then(result =>
        sendResponse({ ...result, requestId: message.requestId }),
      );
    })
    .catch(error => {
      sendResponse(
        reject(
          error && error.message === 'settings-unavailable' ? 'settings-unavailable' : 'fetch-failed',
          message.requestId,
        ),
      );
    });

  // Keep the message channel open for the asynchronous response.
  return true;
});
