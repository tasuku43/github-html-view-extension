#!/usr/bin/env node

/*
 * Package the checked-in dist/ directory as a Chrome-loadable archive.
 *
 * The archive intentionally contains the complete runtime directory. Keeping the package
 * source and the unpacked extension identical prevents a release-only omission of the
 * sandbox entry, popup assets, content scripts, or shared runtime files.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const ARTIFACTS = join(ROOT, 'artifacts');
const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
const output = process.env.GHPREVIEW_PACKAGE_OUTPUT || join(
  ARTIFACTS,
  `extension-${manifest.version}.zip`,
);

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

function archivePath(value) {
  return value.replace(/^\.\//, '').replaceAll('\\', '/');
}

mkdirSync(ARTIFACTS, { recursive: true });
if (existsSync(output)) {
  unlinkSync(output);
}

try {
  execFileSync('zip', ['-q', '-r', '-X', output, '.'], {
    cwd: DIST,
    stdio: 'inherit',
  });
} catch (error) {
  console.error('Packaging failed: the system zip command is required.');
  process.exitCode = typeof error.status === 'number' ? error.status || 1 : 1;
  process.exit();
}

let entries;
try {
  entries = execFileSync('unzip', ['-Z1', output], { encoding: 'utf8' })
    .split(/\r?\n/)
    .map(archivePath)
    .filter(entry => entry !== '' && !entry.endsWith('/'));
} catch (error) {
  console.error('Packaging failed: the archive could not be inspected with unzip.');
  process.exitCode = typeof error.status === 'number' ? error.status || 1 : 1;
  process.exit();
}

const expected = walk(DIST)
  .map(file => archivePath(relative(DIST, file)))
  .sort();
const actual = [...new Set(entries)].sort();
const missing = expected.filter(file => !actual.includes(file));
if (missing.length > 0) {
  console.error('Packaging failed: the archive omitted runtime files:');
  for (const file of missing) {
    console.error(`- ${file}`);
  }
  process.exitCode = 1;
  process.exit();
}

if (!actual.includes('manifest.json')) {
  console.error('Packaging failed: manifest.json is not at the archive root.');
  process.exitCode = 1;
  process.exit();
}

console.log(`Package created: ${relative(ROOT, output)}`);
console.log(`Archive entries verified: ${actual.length}`);
