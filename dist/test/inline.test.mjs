import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScript } from './helpers/load.mjs';

const window = {};
loadScript('inline.js', { window });
const { validateDocument } = window.GHPREVIEW.inline;

test('accepts an inline document with inline CSS and safe passive data', () => {
  const result = validateDocument(`
    <!doctype html>
    <style>body { color: #0969da; }</style>
    <main><img src="data:image/png;base64,AAAA" alt="fixture"></main>
  `);
  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
});

test('allows repository-relative resources through structural validation', () => {
  const result = validateDocument(`
    <link rel="stylesheet" href="styles.css">
    <img src="images/example.png" alt="relative">
  `);
  assert.equal(result.valid, true);
  assert.deepEqual(result.issues, []);
});

test('rejects external resources before rendering', () => {
  const result = validateDocument(`
    <script src="https://cdn.example.test/example.js"></script>
    <img src="https://cdn.example.test/example.png" alt="external">
  `);
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues.map(issue => issue.code), [
    'external-resource',
    'external-resource',
  ]);
  assert.deepEqual(result.issues[0].location, {
    line: 2,
    column: 5,
    target: 'script[src]',
    detail: 'external script sources',
  });
  assert.doesNotMatch(JSON.stringify(result.issues), /cdn\.example\.test/);
});

test('rejects module scripts and dynamic imports before rendering', () => {
  const result = validateDocument('<script type="module">import("./module.js");</script>');
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues.map(issue => issue.code), ['module-script']);
});

test('rejects unsupported active elements and CSS loading paths', () => {
  const result = validateDocument(`
    <iframe src="#embedded"></iframe>
    <style>@import "theme.css"; body { background: url("image.png"); }</style>
  `);
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues.map(issue => issue.code), [
    'embedded-element',
  ]);
});

test('rejects network APIs, unsafe navigation, and unsafe data URLs', () => {
  const result = validateDocument(`
    <a href="javascript:alert(1)">unsafe</a>
    <img src="data:text/html;base64,AAAA" alt="unsafe">
    <script>fetch('/private');</script>
  `);
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues.map(issue => issue.code).sort(), [
    'unsafe-data-url',
    'network-api',
    'dangerous-navigation',
  ].sort());
});

test('rejects root-relative resources with a safe location', () => {
  const result = validateDocument('<img src="/assets/preview.png" alt="fixture">');
  assert.equal(result.valid, false);
  assert.equal(
    result.issues[0].message,
    'Root-relative image sources are not supported because the repository ref is ambiguous.',
  );
  assert.deepEqual(result.issues[0].location, {
    line: 1,
    column: 1,
    target: 'img[src]',
    detail: 'root-relative image sources',
  });
  assert.doesNotMatch(JSON.stringify(result.issues[0]), /assets\/preview\.png/);
});

test('resolves branch, tag, and commit-relative references within the raw repository route', () => {
  const resolve = window.GHPREVIEW.inline.resolveRepositoryUrl;
  const bases = [
    'https://github.com/example/project/raw/main/docs/sample/index.html',
    'https://github.com/example/project/raw/release/v1/docs/sample/index.html',
    'https://github.com/example/project/raw/0123456789abcdef/docs/sample/index.html',
  ];
  for (const base of bases) {
    const result = resolve('../assets/preview.svg', base);
    assert.equal(result.ok, true);
    assert.match(result.url, /^https:\/\/github\.com\/example\/project\/raw\//);
    assert.doesNotMatch(result.url, /\.\./);
  }
});

test('rejects ambiguous root-relative and external dependency references', () => {
  const resolve = window.GHPREVIEW.inline.resolveRepositoryUrl;
  assert.deepEqual(
    resolve('/assets/preview.svg', 'https://github.com/example/project/raw/main/index.html'),
    { ok: false, code: 'root-relative-resource' },
  );
  assert.deepEqual(
    resolve('https://cdn.example.test/preview.css', 'https://github.com/example/project/raw/main/index.html'),
    { ok: false, code: 'external-resource' },
  );
});

test('accepts safe passive SVG and font data URLs but rejects active SVG content', () => {
  const { isSafePassiveDataUrl } = window.GHPREVIEW.inline;
  assert.equal(isSafePassiveDataUrl('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"></svg>'), true);
  assert.equal(isSafePassiveDataUrl('data:font/ttf;base64,AAAA'), true);
  assert.equal(isSafePassiveDataUrl('data:image/svg+xml,<svg><script>alert(1)</script></svg>'), false);
});
