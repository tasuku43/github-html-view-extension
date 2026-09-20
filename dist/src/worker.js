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
const { blobUrl, settings } = globalThis.GHPREVIEW;

// Do not inline files above this limit. A single-document preview needs a clear bound,
// and rejecting before conversion avoids wasting work.
const LIMIT_BYTES = 8 * 1024 * 1024;

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  // Chunk the conversion so the argument list stays within browser limits.
  const CHUNK = 0x8000;
  let binary = '';
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

async function take(url) {
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
  return {
    ok: true,
    contentType,
    base64: toBase64(buffer),
    text: new TextDecoder('utf-8').decode(buffer),
  };
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== PREFIX + 'fetch') {
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
      return take(message.url).then(result => sendResponse({ ...result, requestId: message.requestId }));
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
