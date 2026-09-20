// Subresource classification must not expand the set of allowed fetch targets.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScript } from './helpers/load.mjs';

const window = {};
loadScript('inline.js', { window });
const {
  classify,
  repoRoot,
  dataUri,
  rewriteCssUrls,
  rewriteSrcset,
  escapeScriptText,
  validateDocument,
} = window.GHPREVIEW.inline;

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

test('accepts a self-contained document with inline CSS and safe passive data', () => {
  const result = validateDocument(`
    <!doctype html>
    <style>body { color: #0969da; }</style>
    <main><img src="data:image/png;base64,AAAA" alt="fixture"></main>
  `);
  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
});

test('rejects relative resources before rendering', () => {
  const result = validateDocument(`
    <link rel="stylesheet" href="styles.css">
    <img src="images/example.png" alt="relative">
  `);
  assert.equal(result.valid, false);
  assert.deepEqual(
    result.issues.map(issue => issue.code),
    ['link-element', 'relative-resource'],
  );
});

test('rejects module scripts before they reach the sandbox', () => {
  const result = validateDocument('<script type="module">import("./module.js");</script>');
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues.map(issue => issue.code), ['module-script']);
});

test('rejects external scripts before the browser executes them', () => {
  const result = validateDocument('<script src="https://cdn.example.test/example.js"></script>');
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues.map(issue => issue.code), ['external-resource']);
  assert.deepEqual(result.issues[0].location, {
    line: 1,
    column: 1,
    target: 'script[src]',
    detail: 'external script sources',
  });
  assert.equal(result.issues[0].message, 'External script sources are not supported.');
});

test('reports a safe location for a relative image without exposing its path', () => {
  const result = validateDocument('<img src="assets/preview.png" alt="fixture">');
  assert.equal(result.valid, false);
  assert.equal(result.issues[0].message, 'Relative image sources are not supported.');
  assert.deepEqual(result.issues[0].location, {
    line: 1,
    column: 1,
    target: 'img[src]',
    detail: 'relative image sources',
  });
  assert.doesNotMatch(JSON.stringify(result.issues[0]), /assets\/preview\.png/);
});
