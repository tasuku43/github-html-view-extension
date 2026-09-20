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

const PREFIX = 'ghpreview:';

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
  const response = await fetch(url, {
    credentials: 'include',
    redirect: 'follow',
    cache: 'no-cache',
  });
  if (!response.ok) {
    return { ok: false, status: response.status };
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > LIMIT_BYTES) {
    return { ok: false, status: 0, reason: 'File is too large: ' + buffer.byteLength + ' bytes' };
  }

  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim();
  return {
    ok: true,
    contentType,
    base64: toBase64(buffer),
    text: new TextDecoder('utf-8').decode(buffer),
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== PREFIX + 'fetch') {
    return false;
  }
  // Only a content script running on github.com may make this request.
  if (!sender.url || !sender.url.startsWith('https://github.com/')) {
    sendResponse({ ok: false, status: 0, reason: 'Sender is not github.com' });
    return false;
  }
  // Restrict fetch targets to github.com so the extension cannot become an arbitrary
  // URL reader.
  if (typeof message.url !== 'string' || !message.url.startsWith('https://github.com/')) {
    sendResponse({ ok: false, status: 0, reason: 'Target is not github.com' });
    return false;
  }

  take(message.url)
    .then(sendResponse)
    .catch(error => sendResponse({ ok: false, status: 0, reason: String(error) }));

  // Keep the message channel open for the asynchronous response.
  return true;
});
