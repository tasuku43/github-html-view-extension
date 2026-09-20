// Subresource classification must not expand the set of allowed fetch targets.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScript } from './helpers/load.mjs';

const window = {};
loadScript('inline.js', { window });
const { classify, repoRoot, dataUri, rewriteCssUrls, rewriteSrcset, escapeScriptText } =
  window.GHPREVIEW.inline;

const BASE = 'https://github.com/o/r/raw/main/docs/a.html';

test('resolves relative references within the repository', () => {
  assert.deepEqual(classify('style.css', BASE), {
    kind: 'inline',
    url: 'https://github.com/o/r/raw/main/docs/style.css',
  });
  assert.deepEqual(classify('./assets/x.js', BASE), {
    kind: 'inline',
    url: 'https://github.com/o/r/raw/main/docs/assets/x.js',
  });
  assert.deepEqual(classify('../shared/x.css', BASE), {
    kind: 'inline',
    url: 'https://github.com/o/r/raw/main/shared/x.css',
  });
});

test('leaves external absolute URLs untouched', () => {
  assert.equal(classify('https://example.com/x.css', BASE).kind, 'external');
  assert.equal(classify('//example.com/x.css', BASE).kind, 'external');
});

test('skips references that have nothing to inline', () => {
  assert.equal(classify('', BASE).kind, 'skip');
  assert.equal(classify('   ', BASE).kind, 'skip');
  assert.equal(classify('#section', BASE).kind, 'skip');
  assert.equal(classify('data:image/png;base64,AAAA', BASE).kind, 'skip');
  assert.equal(classify(null, BASE).kind, 'skip');
});

test('does not resolve ambiguous root-absolute paths', () => {
  const decided = classify('/assets/x.css', BASE);
  assert.equal(decided.kind, 'unsupported');
  assert.match(decided.reason, /Root-absolute paths/);
});

test('does not fetch paths that escape through ../', () => {
  // Escaping github.com/o/r/raw/ could target another repository or a GitHub page.
  const decided = classify('../../../../other/repo/raw/main/x.css', BASE);
  assert.equal(decided.kind, 'unsupported');
  assert.match(decided.reason, /escapes the repository/);
});

test('limits allowed fetches to owner/repo/raw/', () => {
  assert.equal(repoRoot(BASE), 'https://github.com/o/r/raw/');
});

test('rewrites CSS url() values and records unresolved references', async () => {
  const css = [
    '@font-face { src: url(fonts/a.woff2); }',
    '.b { background: url("../img/b.png"); }',
    '.c { background: url(/img/c.png); }',
    '.d { background: url(https://example.com/d.png); }',
  ].join('\n');

  const rewritten = await rewriteCssUrls(css, 'https://github.com/o/r/raw/main/docs/s.css', url =>
    Promise.resolve('data:stub,' + url),
  );

  assert.match(rewritten.text, /url\("data:stub,https:\/\/github\.com\/o\/r\/raw\/main\/docs\/fonts\/a\.woff2"\)/);
  assert.match(rewritten.text, /url\("data:stub,https:\/\/github\.com\/o\/r\/raw\/main\/img\/b\.png"\)/);
  // References that are not rewritten remain unchanged.
  assert.match(rewritten.text, /url\(\/img\/c\.png\)/);
  assert.match(rewritten.text, /url\(https:\/\/example\.com\/d\.png\)/);
  assert.equal(rewritten.notes.length, 1);
});

test('records failed resource loads instead of silently removing them', async () => {
  const rewritten = await rewriteCssUrls(
    '.a { background: url(x.png); }',
    'https://github.com/o/r/raw/main/s.css',
    () => Promise.resolve(null),
  );
  assert.match(rewritten.text, /url\(x\.png\)/);
  assert.deepEqual(rewritten.notes, ['Could not load reference: x.png']);
});

test('rewrites srcset URLs while preserving descriptors', async () => {
  const rewritten = await rewriteSrcset('a.png 1x, b.png 2x, https://example.com/c.png 3x', BASE, url =>
    Promise.resolve('data:stub,' + url),
  );
  assert.equal(
    rewritten.value,
    'data:stub,https://github.com/o/r/raw/main/docs/a.png 1x, ' +
      'data:stub,https://github.com/o/r/raw/main/docs/b.png 2x, ' +
      'https://example.com/c.png 3x',
  );
});

test('escapes </script> inside inlined JavaScript', () => {
  const escaped = escapeScriptText('const s = "</script>";');
  assert.doesNotMatch(escaped, /<\/script>/);
  assert.match(escaped, /<\\\/script>/);
});

test('creates a data URI when content type is missing', () => {
  assert.equal(dataUri('image/png', 'AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(dataUri('', 'AAAA'), 'data:application/octet-stream;base64,AAAA');
});
