import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScript } from './helpers/load.mjs';

const window = {};
loadScript('inline.js', { window });
const { validateDocument } = window.GHPREVIEW.inline;

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
    'css-import',
    'relative-resource',
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
