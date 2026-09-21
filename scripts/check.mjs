#!/usr/bin/env node

/*
 * Run the local release gate without requiring a compiler or a framework.
 *
 * The checked-in dist/ directory is the runtime. This script verifies the manifest's
 * local references, parses every checked-in JavaScript file, and runs the unit tests.
 * Browser E2E remains a separate command because it needs a real browser and a public
 * GitHub URL.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const manifestPath = join(DIST, 'manifest.json');
const errors = [];

function fail(message) {
  errors.push(message);
}
function displayPath(file) {
  return relative(ROOT, file).replaceAll('\\', '/');
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(file));
    } else if (entry.isFile()) {
      files.push(file);
    }
  }
  return files;
}

function addManifestPath(paths, value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`Manifest field ${label} must contain a file path.`);
    return;
  }
  paths.push({ value, label });
}

function validateLocalPath(value, label) {
  if (value.includes('*')) {
    return;
  }
  const resolved = resolve(DIST, value);
  const relativeToDist = relative(DIST, resolved);
  if (relativeToDist.startsWith('..') || relativeToDist.includes('\\')) {
    fail(`Manifest field ${label} points outside dist/: ${value}`);
    return;
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    fail(`Manifest field ${label} points to a missing file: ${value}`);
  }
}

function validateHtmlReferences(file) {
  const source = readFileSync(file, 'utf8');
  const references = [...source.matchAll(/(?:src|href)=["']([^"']+)["']/gi)]
    .map(match => match[1])
    .filter(value => !/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(value));
  for (const reference of references) {
    const resolved = resolve(join(file, '..'), reference);
    if (!resolved.startsWith(DIST + '/') && resolved !== DIST) {
      fail(`${displayPath(file)} references a file outside dist/: ${reference}`);
      continue;
    }
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      fail(`${displayPath(file)} references a missing file: ${reference}`);
    }
  }
}

function runSyntaxChecks() {
  const candidates = [
    ...walk(join(ROOT, 'scripts')),
    ...walk(DIST),
  ].filter(file => ['.js', '.mjs'].includes(extname(file)));

  for (const file of candidates) {
    try {
      execFileSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    } catch (error) {
      const output = [error.stdout, error.stderr]
        .filter(value => typeof value === 'string' && value.trim() !== '')
        .join('\n')
        .trim();
      fail(`JavaScript syntax check failed for ${displayPath(file)}${output ? `: ${output}` : ''}`);
    }
  }

  return candidates.length;
}

function validateManifest() {
  if (!existsSync(manifestPath)) {
    fail('dist/manifest.json is missing.');
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    fail(`dist/manifest.json is not valid JSON: ${error.message}`);
    return;
  }

  if (manifest.manifest_version !== 3) {
    fail('The extension must use Manifest V3.');
  }
  if (!Array.isArray(manifest.permissions) || !manifest.permissions.includes('storage')) {
    fail('The manifest must declare storage permission for settings.');
  }
  if (manifest.permissions.some(permission => permission === '<all_urls>' || permission === 'tabs')) {
    fail('The manifest must not broaden permissions to <all_urls> or tabs.');
  }
  if (!Array.isArray(manifest.host_permissions) || !manifest.host_permissions.includes('https://github.com/*')) {
    fail('The manifest must include the GitHub page host permission.');
  }
  if (!manifest.sandbox?.pages?.includes('sandbox.html')) {
    fail('The manifest must keep sandbox.html as the sandbox entry point.');
  }
  if (!manifest.action?.default_popup) {
    fail('The manifest must expose the Action Popup.');
  }

  const paths = [];
  addManifestPath(paths, manifest.action?.default_popup, 'action.default_popup');
  addManifestPath(paths, manifest.background?.service_worker, 'background.service_worker');
  for (const [index, script] of (manifest.content_scripts || []).entries()) {
    for (const [scriptIndex, file] of (script.js || []).entries()) {
      addManifestPath(paths, file, `content_scripts[${index}].js[${scriptIndex}]`);
    }
    for (const [styleIndex, file] of (script.css || []).entries()) {
      addManifestPath(paths, file, `content_scripts[${index}].css[${styleIndex}]`);
    }
  }
  for (const [index, file] of (manifest.sandbox?.pages || []).entries()) {
    addManifestPath(paths, file, `sandbox.pages[${index}]`);
  }
  for (const [index, group] of (manifest.web_accessible_resources || []).entries()) {
    for (const [resourceIndex, file] of (group.resources || []).entries()) {
      addManifestPath(paths, file, `web_accessible_resources[${index}].resources[${resourceIndex}]`);
    }
  }
  for (const entry of paths) {
    validateLocalPath(entry.value, entry.label);
  }

  for (const file of [join(DIST, manifest.action.default_popup), join(DIST, 'sandbox.html')]) {
    if (existsSync(file)) {
      validateHtmlReferences(file);
    }
  }

  return paths.length;
}

const manifestReferenceCount = validateManifest();
const syntaxFileCount = runSyntaxChecks();

if (errors.length > 0) {
  console.error('\nRelease gate failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Manifest and local references: OK (${manifestReferenceCount} entries)`);
  console.log(`JavaScript syntax: OK (${syntaxFileCount} files)`);
}

if (process.exitCode === 0 || process.exitCode === undefined) {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    execFileSync(npmCommand, ['test', '--silent'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
    console.log('Unit tests: OK');
  } catch (error) {
    console.error('Unit tests: FAILED');
    process.exitCode = typeof error.status === 'number' ? error.status || 1 : 1;
  }
}
