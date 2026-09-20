// GitHub URL handling. Keeping ref and path together is the key invariant.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScript } from './helpers/load.mjs';

const window = {};
loadScript('blob-url.js', { window });
const {
  parseFileUrl,
  parseBlobUrl,
  repoKey,
  rawUrl,
  isHtmlPath,
  isPlainRequested,
  shouldPreview,
  previewHref,
  sourceHref,
} = window.GHPREVIEW.blobUrl;

test('extracts owner and repository from a blob URL', () => {
  const parsed = parseBlobUrl('https://github.com/example-owner/design-docs/blob/main/docs/a.html');
  assert.equal(parsed.owner, 'example-owner');
  assert.equal(parsed.repo, 'design-docs');
  assert.equal(repoKey(parsed), 'example-owner/design-docs');
});

test('keeps a slash-containing ref intact', () => {
  // The URL cannot identify the ref/path boundary, so keeping the suffix intact avoids guessing.
  const parsed = parseBlobUrl('https://github.com/o/r/blob/feature/new/docs/a.html');
  assert.equal(parsed.refAndPath, 'feature/new/docs/a.html');
  assert.equal(rawUrl(parsed), 'https://github.com/o/r/raw/feature/new/docs/a.html');
});

test('returns null for non-blob pages', () => {
  assert.equal(parseBlobUrl('https://github.com/example-owner/design-docs'), null);
  assert.equal(parseBlobUrl('https://github.com/example-owner/design-docs/tree/main/docs'), null);
  assert.equal(parseBlobUrl('https://github.com/example-owner/design-docs/pull/12/files'), null);
  assert.equal(parseBlobUrl('https://github.com/o/r/blob/'), null);
});

test('accepts blame as a file view so Preview remains available', () => {
  const parsed = parseFileUrl('https://github.com/o/r/blame/main/docs/a.html');
  assert.equal(parsed.view, 'blame');
  assert.equal(parsed.refAndPath, 'main/docs/a.html');
  // Rendering still happens only for blob pages.
  assert.equal(parseBlobUrl('https://github.com/o/r/blame/main/docs/a.html'), null);
});

test('moves from Blame to blob when Preview is selected', () => {
  assert.equal(
    previewHref('https://github.com/o/r/blame/main/docs/a.html'),
    'https://github.com/o/r/blob/main/docs/a.html',
  );
  // Replace only the view segment, even when the repository name is "blame".
  assert.equal(
    previewHref('https://github.com/o/blame/blame/main/a.html'),
    'https://github.com/o/blame/blob/main/a.html',
  );
});

test('ignores non-github.com origins', () => {
  assert.equal(parseBlobUrl('https://github.com.example.jp/o/r/blob/main/a.html'), null);
  assert.equal(parseBlobUrl('https://raw.githubusercontent.com/o/r/main/a.html'), null);
  assert.equal(parseBlobUrl('http://github.com/o/r/blob/main/a.html'), null);
});

test('parses URLs with fragments and ?plain=1', () => {
  const parsed = parseBlobUrl('https://github.com/o/r/blob/main/a.html?plain=1#preview');
  assert.equal(parsed.refAndPath, 'main/a.html');
  assert.equal(rawUrl(parsed), 'https://github.com/o/r/raw/main/a.html');
});

test('identifies HTML files by extension only', () => {
  assert.equal(isHtmlPath('main/docs/a.html'), true);
  assert.equal(isHtmlPath('main/docs/a.htm'), true);
  assert.equal(isHtmlPath('main/docs/A.HTML'), true);
  assert.equal(isHtmlPath('main/docs/a.xhtml'), true);
  assert.equal(isHtmlPath('main/docs/a.md'), false);
  assert.equal(isHtmlPath('main/docs/a.html.txt'), false);
  assert.equal(isHtmlPath('main/docs/html'), false);
});

test('defaults to preview and uses ?plain=1 for the source view', () => {
  // This follows GitHub's Markdown behavior.
  assert.equal(shouldPreview('https://github.com/o/r/blob/main/a.html'), true);
  assert.equal(shouldPreview('https://github.com/o/r/blob/main/a.html#preview'), true);
  assert.equal(shouldPreview('https://github.com/o/r/blob/main/a.html#L3'), true);
  assert.equal(shouldPreview('https://github.com/o/r/blob/main/a.html?plain=1'), false);
});

test('treats plain as a source request only when its value is 1', () => {
  assert.equal(isPlainRequested('https://github.com/o/r/blob/main/a.html?plain=1'), true);
  assert.equal(isPlainRequested('https://github.com/o/r/blob/main/a.html?plain=0'), false);
  assert.equal(isPlainRequested('https://github.com/o/r/blob/main/a.html'), false);
  assert.equal(isPlainRequested('not a valid URL'), false);
});

test('adds ?plain=1 for Code and removes it for Preview', () => {
  const plain = 'https://github.com/o/r/blob/main/a.html?plain=1';
  const clean = 'https://github.com/o/r/blob/main/a.html';
  assert.equal(sourceHref(clean), plain);
  assert.equal(previewHref(plain), clean);
  // Repeating the operation does not add duplicate parameters.
  assert.equal(sourceHref(plain), plain);
  assert.equal(previewHref(clean), clean);
});

test('preserves unrelated query parameters when switching views', () => {
  assert.equal(
    sourceHref('https://github.com/o/r/blob/main/a.html?ts=4'),
    'https://github.com/o/r/blob/main/a.html?ts=4&plain=1',
  );
  assert.equal(
    previewHref('https://github.com/o/r/blob/main/a.html?ts=4&plain=1'),
    'https://github.com/o/r/blob/main/a.html?ts=4',
  );
});

test('removes fragments when switching views', () => {
  assert.equal(
    sourceHref('https://github.com/o/r/blob/main/a.html#L3'),
    'https://github.com/o/r/blob/main/a.html?plain=1',
  );
});
