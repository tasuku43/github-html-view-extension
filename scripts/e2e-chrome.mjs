#!/usr/bin/env node

/*
 * Run a browser-level smoke test against the unpacked MV3 extension.
 *
 * The URL is supplied at runtime so repository or account information never becomes
 * part of the test source. The browser context is isolated and is discarded after each
 * run. The test intentionally observes the page through data-preview-* attributes rather
 * than depending on the appearance of the error card.
 */
import { chromium } from 'playwright';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXTENSION_DIR = process.env.GHPREVIEW_EXTENSION_DIR || join(ROOT, 'dist');
const TARGET_URL = process.env.GHPREVIEW_E2E_URL;
const EXPECTED_STATE = process.env.GHPREVIEW_E2E_EXPECT_STATE || '';
const EXPECTED_ERROR_CODE = process.env.GHPREVIEW_E2E_EXPECT_ERROR_CODE || '';
const EXPECT_NO_PREVIEW = process.env.GHPREVIEW_E2E_EXPECT_NO_PREVIEW === '1';
const ENABLE_JAVASCRIPT = process.env.GHPREVIEW_E2E_ENABLE_JAVASCRIPT === '1';
const RUN_NAVIGATION = process.env.GHPREVIEW_E2E_NAVIGATION !== '0';
const HEADLESS = process.env.GHPREVIEW_E2E_HEADLESS === '1';
const DEBUG = process.env.GHPREVIEW_E2E_DEBUG === '1';
const TIMEOUT = Number(process.env.GHPREVIEW_E2E_TIMEOUT || 30000);

if (!TARGET_URL) {
  throw new Error(
    'GHPREVIEW_E2E_URL is required. Pass a public GitHub Blob URL for an HTML file.',
  );
}

const target = new URL(TARGET_URL);
if (target.origin !== 'https://github.com') {
  throw new Error('GHPREVIEW_E2E_URL must use https://github.com.');
}

const fileMatch = /^\/([^/]+)\/([^/]+)\/(blob|blame)\/(.+)$/.exec(target.pathname);
if (fileMatch === null || !/\.(?:html?|xhtml)$/i.test(fileMatch[4])) {
  throw new Error('GHPREVIEW_E2E_URL must point to an HTML Blob or Blame page.');
}

const repository = fileMatch[1] + '/' + fileMatch[2];

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function previewUrl(href) {
  const url = new URL(href);
  url.pathname = url.pathname.replace(/^(\/[^/]+\/[^/]+)\/blame\//, '$1/blob/');
  url.searchParams.delete('plain');
  url.hash = '';
  return url.href;
}

function findBrowserPath() {
  const candidates = [
    process.env.GHPREVIEW_E2E_BROWSER_PATH,
    process.env.CHROME_PATH,
    chromium.executablePath(),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);

  return candidates.find(candidate => existsSync(candidate)) || null;
}

async function waitFor(label, callback, timeoutMilliseconds = TIMEOUT) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await callback();
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  const suffix = lastError instanceof Error ? ': ' + lastError.message : '';
  throw new Error('Timed out waiting for ' + label + suffix);
}

async function findExtensionWorker(context) {
  return waitFor('ghpreview service worker', async () => {
    for (const worker of context.serviceWorkers()) {
      try {
        const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
        if (manifest && manifest.name === 'ghpreview') {
          return worker;
        }
      } catch {
        // The worker can be replaced while Chrome starts the unpacked extension.
      }
    }
    return null;
  });
}

async function openSettingsPopup(context, extensionId) {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`, {
    waitUntil: 'domcontentloaded',
    timeout: TIMEOUT,
  });
  await popup.locator('[data-settings-surface][data-settings-state="ready"]').waitFor({
    state: 'attached',
    timeout: TIMEOUT,
  });
  return popup;
}

async function configureSettingsThroughPopup(context, worker) {
  const extensionId = new URL(worker.url()).hostname;
  const popup = await openSettingsPopup(context, extensionId);

  const firstRun = await popup.evaluate(() => ({
    previewEnabled: document.querySelector('#preview-enabled').checked,
    capabilityDisabled: document.querySelector('#capability-javascript').disabled,
    capabilityIds: Array.from(document.querySelectorAll('.capability-row input')).map(input => input.id),
    limits: Array.from(document.querySelectorAll('.limit-row')).map(row => ({
      name: row.querySelector('strong').textContent.trim(),
      status: row.querySelector('.unsupported-badge').textContent.trim(),
    })),
    repositoryCount: document.querySelector('#repository-list').childElementCount,
  }));
  assert(!firstRun.previewEnabled, 'Preview should be off on a fresh profile.');
  assert(firstRun.capabilityDisabled, 'Capabilities should be disabled until Preview is enabled.');
  assert(
    JSON.stringify(firstRun.capabilityIds) === JSON.stringify(['capability-javascript', 'capability-modals']),
    'The Popup exposes an unsupported capability.',
  );
  assert(
    JSON.stringify(firstRun.limits) === JSON.stringify([
      { name: 'Form submission', status: 'Not supported' },
      { name: 'New windows and popups', status: 'Not supported' },
    ]),
    'The Popup does not clearly expose the enforced Preview limits.',
  );
  assert(firstRun.repositoryCount === 0, 'A fresh profile should have no repositories.');

  await popup.locator('#repository-input').fill('owner/*');
  await waitFor('wildcard repository error', async () => {
    return (await popup.locator('#repository-error').innerText()).includes('Wildcards are not supported');
  });
  assert(
    (await popup.locator('#repository-list > li').count()) === 0,
    'An invalid repository must not be stored.',
  );

  await popup.locator('#repository-input').fill(repository);
  await popup.locator('.add-button').click();
  const repositoryItem = popup.locator(`[data-repository="${repository}"]`);
  await repositoryItem.waitFor({ state: 'attached', timeout: TIMEOUT });

  await popup.locator('#repository-input').fill(repository);
  await popup.locator('.add-button').click();
  await waitFor('duplicate repository error', async () => {
    return (await popup.locator('#repository-error').innerText()).includes('already approved');
  });
  assert(
    (await popup.locator('#repository-list > li').count()) === 1,
    'A duplicate repository must not create a second entry.',
  );

  await repositoryItem.locator('[data-remove-repository]').click();
  await waitFor('repository removal', async () => {
    return (await popup.locator('#repository-list > li').count()) === 0;
  });

  await popup.locator('#repository-input').fill(repository);
  await popup.locator('.add-button').click();
  await popup.locator(`[data-repository="${repository}"]`).waitFor({
    state: 'attached',
    timeout: TIMEOUT,
  });
  const restoredRepositoryItem = popup.locator(`[data-repository="${repository}"]`);
  const repositoryPresentation = await restoredRepositoryItem.locator('.repository-name').evaluate(element => ({
    fullName: element.dataset.fullName,
    title: element.getAttribute('title'),
    ariaLabel: element.getAttribute('aria-label'),
    describedBy: element.getAttribute('aria-describedby'),
    textOverflow: getComputedStyle(element.querySelector('code')).textOverflow,
    whiteSpace: getComputedStyle(element.querySelector('code')).whiteSpace,
  }));
  assert(repositoryPresentation.fullName === repository, 'Repository full value is not attached to the name surface.');
  assert(repositoryPresentation.title === null, 'Repository name must not use the delayed native title tooltip.');
  assert(
    repositoryPresentation.ariaLabel === 'Full repository name: ' + repository,
    'Repository name does not expose an accessible full value.',
  );
  assert(repositoryPresentation.describedBy === 'repository-tooltip', 'Repository name is not connected to its tooltip.');
  assert(repositoryPresentation.textOverflow === 'ellipsis', 'Repository names must remain truncated with an ellipsis.');
  assert(repositoryPresentation.whiteSpace === 'nowrap', 'Repository names must stay on one line before inspection.');
  const repositoryName = restoredRepositoryItem.locator('.repository-name');
  await repositoryName.hover();
  await waitFor('repository tooltip to appear', async () => {
    return popup.locator('#repository-tooltip.is-visible').count();
  });
  assert(
    (await popup.locator('#repository-tooltip').innerText()) === repository,
    'Repository tooltip does not show the complete value.',
  );
  await popup.close();
  return extensionId;
}

async function setPreviewEnabledThroughPopup(context, extensionId, enabled) {
  const popup = await openSettingsPopup(context, extensionId);
  const control = popup.locator('#preview-enabled');
  if (enabled) {
    await control.check();
  } else {
    await control.uncheck();
  }
  await waitFor('Popup master switch to settle', async () => {
    return popup.locator(
      `[data-settings-surface][data-preview-enabled="${String(enabled)}"]`,
    ).count();
  });
  if (enabled) {
    assert(
      !(await popup.locator('#capability-javascript').isDisabled()),
      'Capabilities should be configurable after Preview is enabled.',
    );
    if (ENABLE_JAVASCRIPT) {
      await popup.locator('#capability-javascript').check();
      await waitFor('JavaScript capability to be saved', async () => {
        return popup.locator('[data-settings-surface][data-capability-javascript="true"]').count();
      });
    }
    await waitFor('Popup settings to be saved', async () => {
      return popup.locator('[data-settings-surface][data-settings-state="saved"]').count();
    });
  }
  await popup.close();
}

async function inspect(page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const frame = document.querySelector('#ghpreview-frame');
    const error = document.querySelector('#ghpreview-error');
    const items = Array.from(
      document.querySelectorAll('li[data-component="SegmentedControl.Button"]'),
    );
    const views = items.map(item => {
      const control = item.matches('a, button') ? item : item.querySelector('a, button');
      const label = (control || item).textContent.trim();
      return {
        label,
        selected:
          item.hasAttribute('data-selected') ||
          item.getAttribute('aria-selected') === 'true' ||
          (control && control.getAttribute('aria-pressed') === 'true'),
      };
    });
    const state =
      root.dataset.previewState || frame?.dataset.previewState || error?.dataset.previewState || null;
    const errorCode =
      root.dataset.previewErrorCode ||
      frame?.dataset.previewErrorCode ||
      error?.dataset.previewErrorCode ||
      null;
    return {
      state,
      errorCode,
      requestId:
        root.dataset.previewRequestId ||
        frame?.dataset.previewRequestId ||
        error?.dataset.previewRequestId ||
        null,
      sessionId:
        root.dataset.previewSessionId ||
        frame?.dataset.previewSessionId ||
        error?.dataset.previewSessionId ||
        null,
      previewAvailable: Boolean(document.querySelector('[data-ghpreview-link]')),
      previewLinkCount: document.querySelectorAll('[data-ghpreview-link]').length,
      views,
      hasFrame: Boolean(frame),
      hasError: Boolean(error),
    };
  });
}

async function inspectFrameGeometry(page) {
  const host = await page.locator('#ghpreview-frame').evaluate(frame => ({
    height: frame.getBoundingClientRect().height,
    clientHeight: frame.clientHeight,
  }));
  const sandbox = page.frames().find(frame => frame.url().includes('/sandbox.html'));
  if (!sandbox) {
    throw new Error('The sandbox frame was not available for geometry verification.');
  }
  const documentMetrics = await sandbox.evaluate(() => {
    const documentElement = document.documentElement;
    const body = document.body;
    return {
      documentHeight: Math.max(
        documentElement ? documentElement.scrollHeight : 0,
        documentElement ? documentElement.offsetHeight : 0,
        body ? body.scrollHeight : 0,
        body ? body.offsetHeight : 0,
      ),
      viewportHeight: documentElement ? documentElement.clientHeight : 0,
    };
  });
  return { host, document: documentMetrics };
}

function assertScrollContract(geometry) {
  assert(geometry.host.height > 500, 'The valid fixture did not produce a long Preview surface.');
  assert(
    geometry.host.clientHeight + 16 >= geometry.document.documentHeight,
    'The Preview iframe is shorter than the rendered document.',
  );
  assert(
    geometry.document.viewportHeight + 16 >= geometry.document.documentHeight,
    'The rendered document has an unexpected internal vertical scrollbar.',
  );
}

async function waitForPreviewControl(page) {
  await page.locator('[data-ghpreview-link]').waitFor({ state: 'attached', timeout: TIMEOUT });
}

async function waitForPreviewDisabled(page) {
  return waitFor('Preview to remain disabled', async () => {
    const snapshot = await inspect(page);
    return ['disabled', 'idle'].includes(snapshot.state) &&
      !snapshot.previewAvailable &&
      !snapshot.hasFrame &&
      !snapshot.hasError
      ? snapshot
      : false;
  });
}

async function waitForTerminalState(page, expectedState = EXPECTED_STATE) {
  return waitFor('a stable terminal Preview state', async () => {
    const snapshot = await inspect(page);
    if (!['ready', 'failed', 'disabled'].includes(snapshot.state)) {
      return false;
    }
    if (expectedState && snapshot.state !== expectedState) {
      return false;
    }
    if (EXPECTED_ERROR_CODE && snapshot.errorCode !== EXPECTED_ERROR_CODE) {
      return false;
    }
    // GitHub and the extension both mutate the same DOM. Keep observing long enough to
    // catch a terminal state that regresses when the extension reacts to its own iframe.
    await page.waitForTimeout(2500);
    const stable = await inspect(page);
    if (stable.state !== snapshot.state || stable.errorCode !== snapshot.errorCode) {
      return false;
    }
    return stable;
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertSelected(snapshot, label) {
  const view = snapshot.views.find(candidate => candidate.label.toLowerCase() === label.toLowerCase());
  assert(view && view.selected, label + ' is not selected: ' + JSON.stringify(snapshot.views));
}

function isSelected(snapshot, label) {
  return snapshot.views.some(
    candidate => candidate.label.toLowerCase() === label.toLowerCase() && candidate.selected,
  );
}

function assertMetadata(snapshot) {
  assert(snapshot.state, 'Preview did not expose data-preview-state.');
  assert(snapshot.requestId, 'Preview did not expose data-preview-request-id.');
  if (snapshot.state === 'ready' || snapshot.hasFrame) {
    assert(snapshot.sessionId, 'Preview did not expose data-preview-session-id.');
  }
  if (snapshot.state === 'failed') {
    assert(snapshot.errorCode, 'Failed Preview did not expose data-preview-error-code.');
  }
}

async function clickView(page, label) {
  const item = page
    .locator('li[data-component="SegmentedControl.Button"]')
    .filter({ hasText: new RegExp('^\\s*' + label + '\\s*$', 'i') })
    .first();
  await item.waitFor({ state: 'attached', timeout: TIMEOUT });
  await item.locator('a, button').first().click();
}

async function clickPreview(page) {
  await page.locator('[data-ghpreview-link]').first().click();
}

async function waitForView(page, predicate, label) {
  return waitFor(label, async () => {
    const snapshot = await inspect(page);
    return predicate(snapshot) ? snapshot : false;
  });
}

async function runNavigationContract(page) {
  await waitForPreviewControl(page);
  let snapshot = await inspect(page);
  assertSelected(snapshot, 'Preview');
  assert(snapshot.previewAvailable, 'Preview control is missing before navigation.');
  assert(snapshot.previewLinkCount === 1, 'Preview control is duplicated before navigation.');

  await clickView(page, 'Code');
  snapshot = await waitForView(
    page,
    current =>
      new URL(page.url()).searchParams.get('plain') === '1' &&
      current.previewAvailable &&
      isSelected(current, 'Code'),
    'Preview -> Code',
  );
  assertSelected(snapshot, 'Code');
  assert(snapshot.previewLinkCount === 1, 'Preview control was duplicated after Preview -> Code.');

  await clickView(page, 'Blame');
  snapshot = await waitForView(
    page,
    current => page.url().includes('/blame/') && current.previewAvailable && isSelected(current, 'Blame'),
    'Code -> Blame',
  );
  assertSelected(snapshot, 'Blame');
  assert(snapshot.previewLinkCount === 1, 'Preview control was duplicated after Code -> Blame.');

  await clickPreview(page);
  snapshot = await waitForView(
    page,
    current =>
      page.url().includes('/blob/') &&
      !new URL(page.url()).searchParams.has('plain') &&
      current.previewAvailable &&
      isSelected(current, 'Preview'),
    'Blame -> Preview',
  );
  assertSelected(snapshot, 'Preview');
  assert(snapshot.previewLinkCount === 1, 'Preview control was duplicated after Blame -> Preview.');

  await clickView(page, 'Blame');
  snapshot = await waitForView(
    page,
    current => page.url().includes('/blame/') && current.previewAvailable && isSelected(current, 'Blame'),
    'Preview -> Blame',
  );
  assertSelected(snapshot, 'Blame');
  assert(snapshot.previewLinkCount === 1, 'Preview control was duplicated after Preview -> Blame.');

  await clickView(page, 'Code');
  snapshot = await waitForView(
    page,
    current =>
      page.url().includes('/blob/') &&
      new URL(page.url()).searchParams.get('plain') === '1' &&
      current.previewAvailable &&
      isSelected(current, 'Code'),
    'Blame -> Code',
  );
  assertSelected(snapshot, 'Code');
  assert(snapshot.previewLinkCount === 1, 'Preview control was duplicated after Blame -> Code.');
}

const browserPath = findBrowserPath();
const profile = mkdtempSync(join(tmpdir(), 'ghpreview-e2e-'));
const launchOptions = {
  headless: HEADLESS,
  viewport: { width: 1440, height: 1000 },
  locale: 'en-US',
  args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
};
if (browserPath !== null) {
  launchOptions.executablePath = browserPath;
}

let context = null;
let page = null;
const logs = [];

try {
  context = await chromium.launchPersistentContext(profile, launchOptions);
  page = context.pages()[0] || (await context.newPage());
  page.on('console', message => {
    const text = message.text();
    if (text.startsWith('[html-preview]')) {
      logs.push({ type: message.type(), text });
      if (DEBUG) {
        console.error(text);
      }
    }
  });
  page.on('pageerror', error => logs.push({ type: 'pageerror', text: error.message }));

  const worker = await findExtensionWorker(context);
  const extensionId = await configureSettingsThroughPopup(context, worker);
  await page.goto(previewUrl(TARGET_URL), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

  const disabled = await waitForPreviewDisabled(page);
  console.log(JSON.stringify({ step: 'master-switch-off', ...disabled }));

  await setPreviewEnabledThroughPopup(context, extensionId, true);
  await page.goto(previewUrl(TARGET_URL), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

  if (EXPECT_NO_PREVIEW) {
    await page.locator('[data-testid="error-404-description"]').waitFor({
      state: 'attached',
      timeout: TIMEOUT,
    });
    const missingFile = await waitFor('Preview to remain absent on a missing GitHub file', async () => {
      const snapshot = await inspect(page);
      return snapshot.previewAvailable || snapshot.hasError || snapshot.state !== 'idle' ? false : snapshot;
    });
    assert(!missingFile.previewAvailable, 'Preview control was injected into a missing GitHub file page.');
    assert(!missingFile.hasError, 'Preview error surface was injected into a missing GitHub file page.');
    console.log(JSON.stringify({ step: 'missing-file', ...missingFile }));
    console.log('E2E passed.');
  } else {
    await waitForPreviewControl(page);

    const initial = await waitForTerminalState(page);
    assertMetadata(initial);
    console.log(JSON.stringify({ step: 'terminal', ...initial }));
    if (EXPECTED_STATE) {
      assert(initial.state === EXPECTED_STATE, 'Expected state ' + EXPECTED_STATE + ', got ' + initial.state + '.');
    }
    if (EXPECTED_ERROR_CODE) {
      assert(
        initial.errorCode === EXPECTED_ERROR_CODE,
        'Expected error code ' + EXPECTED_ERROR_CODE + ', got ' + initial.errorCode + '.',
      );
    }

    if (initial.state === 'ready') {
      const geometry = await waitFor('Preview frame geometry', async () => {
        try {
          return await inspectFrameGeometry(page);
        } catch {
          return false;
        }
      });
      assertScrollContract(geometry);
      console.log(JSON.stringify({ step: 'scroll-contract', ...geometry }));
    }

    if (RUN_NAVIGATION) {
      await runNavigationContract(page);
    }

    console.log('E2E passed.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  const recentLogs = logs.slice(-20);
  if (recentLogs.length > 0) {
    console.error('Recent Preview diagnostics:');
    recentLogs.forEach(entry => console.error(entry.text));
  }
  process.exitCode = 1;
} finally {
  if (context !== null) {
    await context.close().catch(() => {});
  }
  rmSync(profile, { recursive: true, force: true });
}
