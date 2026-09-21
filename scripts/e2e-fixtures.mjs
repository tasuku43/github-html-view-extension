#!/usr/bin/env node

/*
 * Run the public fixture matrix without storing a repository or account in the source.
 * The base URL must point to a GitHub Blob directory, for example:
 * https://github.com/owner/repository/blob/main/
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUNNER = join(ROOT, 'scripts/e2e-chrome.mjs');

function currentRepositoryFixtureRoot() {
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
  if (match === null) {
    throw new Error('The origin remote must point to a GitHub repository.');
  }
  return `https://github.com/${match[1]}/${match[2]}/blob/${process.env.GHPREVIEW_E2E_REF || 'main'}/`;
}

const FIXTURE_ROOT = process.env.GHPREVIEW_E2E_FIXTURE_ROOT || currentRepositoryFixtureRoot();
const rootUrl = new URL(FIXTURE_ROOT);
if (rootUrl.origin !== 'https://github.com' || !rootUrl.pathname.includes('/blob/')) {
  throw new Error('GHPREVIEW_E2E_FIXTURE_ROOT must be a https://github.com Blob directory URL.');
}
if (!rootUrl.pathname.endsWith('/')) {
  rootUrl.pathname += '/';
}

const cases = [
  { name: 'valid', path: 'docs/sample/index.html', state: 'ready' },
  {
    name: 'direct-code-start',
    path: 'docs/sample/index.html',
    state: 'idle',
    preserveTargetView: true,
    initialView: 'code',
  },
  {
    name: 'direct-blame-start',
    path: 'docs/sample/index.html',
    view: 'blame',
    state: 'idle',
    preserveTargetView: true,
    initialView: 'blame',
  },
  {
    name: 'relative-resource',
    path: 'docs/sample/invalid/relative-resource.html',
    state: 'failed',
    errorCode: 'html-policy-violation',
  },
  {
    name: 'module-script',
    path: 'docs/sample/invalid/module-script.html',
    state: 'failed',
    errorCode: 'html-policy-violation',
  },
  {
    name: 'external-resource',
    path: 'docs/sample/invalid/external-resource.html',
    state: 'failed',
    errorCode: 'html-policy-violation',
  },
  {
    name: 'runtime-error',
    path: 'docs/sample/runtime-error.html',
    state: 'failed',
    errorCode: 'sandbox-runtime-error',
    enableJavaScript: true,
  },
  {
    name: 'missing-file',
    path: 'docs/sample/invalid/missing-file.html',
    noPreview: true,
  },
];

function runCase(candidate) {
  const target = new URL(candidate.path, rootUrl);
  if (candidate.view) {
    target.pathname = target.pathname.replace('/blob/', '/' + candidate.view + '/');
  }
  if (candidate.preserveTargetView) {
    target.searchParams.set('plain', '1');
  }
  const environment = {
    ...process.env,
    GHPREVIEW_E2E_URL: target.href,
    GHPREVIEW_E2E_EXPECT_STATE: candidate.state || '',
    GHPREVIEW_E2E_EXPECT_ERROR_CODE: candidate.errorCode || '',
    GHPREVIEW_E2E_EXPECT_NO_PREVIEW: candidate.noPreview ? '1' : '0',
    GHPREVIEW_E2E_ENABLE_JAVASCRIPT: candidate.enableJavaScript ? '1' : '0',
    GHPREVIEW_E2E_PRESERVE_TARGET_VIEW: candidate.preserveTargetView ? '1' : '0',
    GHPREVIEW_E2E_EXPECT_INITIAL_VIEW: candidate.initialView || '',
  };

  return new Promise((resolve, reject) => {
    console.log('\n=== ' + candidate.name + ' ===');
    const child = spawn(process.execPath, [RUNNER], {
      cwd: ROOT,
      env: environment,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal !== null) {
        reject(new Error(candidate.name + ' was terminated by ' + signal));
        return;
      }
      if (code !== 0) {
        reject(new Error(candidate.name + ' failed with exit code ' + code));
        return;
      }
      resolve();
    });
  });
}

for (const candidate of cases) {
  await runCase(candidate);
}

console.log('\nFixture E2E passed: ' + cases.map(candidate => candidate.name).join(', '));
