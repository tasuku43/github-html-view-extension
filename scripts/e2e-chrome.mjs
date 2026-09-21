#!/usr/bin/env node

/*
 * Run a browser-level smoke test against the unpacked MV3 extension.
 *
 * The URL is supplied at runtime so repository or account information never becomes
 * part of the test source. The browser context is isolated and is discarded after each
 * run. The test uses the extension's structured [html-preview] diagnostics as the primary
 * oracle. data-preview-* attributes and destination URLs verify the resulting contract; a
 * lightweight animation-frame trace is used only to detect a visibly committed intermediate
 * tab during a transition. Screenshots and post-load tab classes are not used as proof of
 * success.
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
const TRACE_TRANSITIONS = process.env.GHPREVIEW_E2E_TRACE_TRANSITIONS === '1';
const TRACE_STARTUP = process.env.GHPREVIEW_E2E_TRACE_STARTUP === '1';
const PRESERVE_TARGET_VIEW = process.env.GHPREVIEW_E2E_PRESERVE_TARGET_VIEW === '1';
const TRUST_FLOW = process.env.GHPREVIEW_E2E_TRUST_FLOW === '1';
const SECOND_TRUST_URL = process.env.GHPREVIEW_E2E_SECOND_URL || '';
const EXPECTED_INITIAL_VIEW = (
  process.env.GHPREVIEW_E2E_EXPECT_INITIAL_VIEW ||
  (PRESERVE_TARGET_VIEW ? 'code' : 'preview')
).toLowerCase();
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

if (!['preview', 'code', 'blame'].includes(EXPECTED_INITIAL_VIEW)) {
  throw new Error('GHPREVIEW_E2E_EXPECT_INITIAL_VIEW must be preview, code, or blame.');
}
if (PRESERVE_TARGET_VIEW && EXPECTED_INITIAL_VIEW === 'code' && target.searchParams.get('plain') !== '1') {
  throw new Error('A direct Code start requires a ?plain=1 source-view URL.');
}
if (PRESERVE_TARGET_VIEW && EXPECTED_INITIAL_VIEW === 'blame' && fileMatch[3] !== 'blame') {
  throw new Error('A direct Blame start requires a /blame/ URL.');
}

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

function initialTestUrl() {
  return PRESERVE_TARGET_VIEW ? TARGET_URL : previewUrl(TARGET_URL);
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
        if (manifest && manifest.name === 'HTML Preview') {
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

async function configureSettingsThroughPopup(context, worker, { addRepository = true } = {}) {
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

  if (addRepository) {
    await popup.locator('#repository-input').fill(repository);
    await popup.locator('.add-button').click();
    const repositoryItem = popup.locator(`[data-repository="${repository}"]`);
    await repositoryItem.waitFor({ state: 'attached', timeout: TIMEOUT });

    await popup.locator('#repository-input').fill(repository);
    await popup.locator('.add-button').click();
    await waitFor('duplicate repository error', async () => {
      return (await popup.locator('#repository-error').innerText()).includes('already trusted');
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
  }
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
    const warning = document.querySelector('#ghpreview-warning');
    const viewRoot = document.querySelector('ul[aria-label="File view"]');
    const items = viewRoot
      ? Array.from(viewRoot.querySelectorAll('li[data-component="SegmentedControl.Button"]'))
      : [];
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
      root.dataset.previewState ||
      frame?.dataset.previewState ||
      error?.dataset.previewState ||
      warning?.dataset.previewState ||
      null;
    const errorCode =
      root.dataset.previewErrorCode ||
      frame?.dataset.previewErrorCode ||
      error?.dataset.previewErrorCode ||
      warning?.dataset.previewErrorCode ||
      null;
    return {
      state,
      errorCode,
      requestId:
        root.dataset.previewRequestId ||
        frame?.dataset.previewRequestId ||
        error?.dataset.previewRequestId ||
        warning?.dataset.previewRequestId ||
        null,
      sessionId:
        root.dataset.previewSessionId ||
        frame?.dataset.previewSessionId ||
        error?.dataset.previewSessionId ||
        warning?.dataset.previewSessionId ||
        null,
      previewAvailable: Boolean(document.querySelector('[data-ghpreview-link]')),
      previewLinkCount: document.querySelectorAll('[data-ghpreview-link]').length,
      views,
      hasFrame: Boolean(frame),
      hasError: Boolean(error),
      hasTrust: Boolean(document.querySelector('#ghpreview-trust')),
      hasWarning: Boolean(warning),
    };
  });
}

/**
 * Record the native file-view state from document start.
 *
 * The extension and GitHub both mutate this control. A post-load snapshot can miss a
 * transient selection, so this recorder starts before navigation and keeps only meaningful
 * state changes. It is an E2E diagnostic oracle, not a product runtime dependency.
 */
async function installDomTrace(page) {
  await page.addInitScript(() => {
    const entries = [];
    let lastKey = null;
    let lastFrameKey = null;
    let observer = null;
    let raf = null;

    function readState() {
      const viewRoot = document.querySelector('ul[aria-label="File view"]');
      const items = viewRoot
        ? Array.from(viewRoot.querySelectorAll('li[data-component="SegmentedControl.Button"]'))
        : [];
      return {
        labels: items.map(item => (item.querySelector('a, button') || item).textContent.trim()),
        selected: items
          .filter(item => {
            const control = item.matches('a, button') ? item : item.querySelector('a, button');
            return (
              item.hasAttribute('data-selected') ||
              item.getAttribute('aria-selected') === 'true' ||
              control?.getAttribute('aria-pressed') === 'true'
            );
          })
          .map(item => (item.querySelector('a, button') || item).textContent.trim()),
        previewLinkCount: document.querySelectorAll('[data-ghpreview-link]').length,
        viewRootPresent: viewRoot !== null,
        visibility: viewRoot ? getComputedStyle(viewRoot).visibility : null,
        display: viewRoot ? getComputedStyle(viewRoot).display : null,
        opacity: viewRoot ? getComputedStyle(viewRoot).opacity : null,
      };
    }

    function capture(source, detail = {}, force = false) {
      const state = readState();
      const key = JSON.stringify(state);
      if (source === 'raf') {
        if (key === lastFrameKey) {
          return;
        }
        lastFrameKey = key;
      } else if (!force && key === lastKey) {
        return;
      }
      lastKey = key;
      entries.push({ source, at: performance.now(), state, detail });
      if (entries.length > 4000) {
        entries.shift();
      }
    }

    function install() {
      if (observer !== null || document.documentElement === null) {
        return;
      }
      observer = new MutationObserver(() => capture('mutation'));
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ['data-selected', 'aria-selected', 'aria-pressed', 'aria-current'],
      });
      document.addEventListener(
        'click',
        event => {
          const target = event.target instanceof Element ? event.target : null;
          const item = target?.closest('li[data-component="SegmentedControl.Button"]');
          if (item !== null) {
            capture(
              'click',
              { label: (item.querySelector('a, button') || item).textContent.trim() },
              true,
            );
          }
        },
        true,
      );

      const pushState = history.pushState;
      history.pushState = function (...args) {
        capture('pushState:before', { hasDestination: typeof args[2] === 'string' }, true);
        const result = pushState.apply(this, args);
        capture('pushState:after', undefined, true);
        return result;
      };
      const replaceState = history.replaceState;
      history.replaceState = function (...args) {
        capture('replaceState:before', { hasDestination: typeof args[2] === 'string' }, true);
        const result = replaceState.apply(this, args);
        capture('replaceState:after', undefined, true);
        return result;
      };
      addEventListener('popstate', () => capture('popstate', {}, true));
      capture('document-start', {}, true);
      const frame = () => {
        capture('raf');
        raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
    }

    window.__ghpreviewDomTrace = {
      entries,
      reset() {
        entries.length = 0;
        lastKey = null;
        lastFrameKey = null;
        capture('initial', {}, true);
      },
      stop() {
        if (raf !== null) {
          cancelAnimationFrame(raf);
          raf = null;
        }
        observer?.disconnect();
        return entries;
      },
    };
    if (document.documentElement !== null) {
      install();
    } else {
      addEventListener('DOMContentLoaded', install, { once: true });
    }
  });
}

async function resetDomTrace(page) {
  await page.evaluate(() => window.__ghpreviewDomTrace?.reset());
}

async function readDomTrace(page) {
  return page.evaluate(() => window.__ghpreviewDomTrace?.entries || []);
}

function assertStartupPresentation(trace, expectedView, label) {
  const expected = expectedView.toLowerCase();
  let previewWasPresented = false;
  const failures = [];
  for (const entry of trace || []) {
    const state = entry.state;
    const labels = state.labels.map(value => value.toLowerCase());
    if (state.previewLinkCount === 1 && labels.includes('preview')) {
      previewWasPresented = true;
    }
    const visible =
      state.visibility !== 'hidden' && state.display !== 'none' && state.opacity !== '0';
    if (!previewWasPresented || entry.source !== 'raf' || !visible) {
      continue;
    }
    if (state.selected.length !== 1 || state.selected[0].toLowerCase() !== expected) {
      failures.push({
        source: entry.source,
        selected: state.selected,
        labels: state.labels,
        visibility: state.visibility,
        display: state.display,
        opacity: state.opacity,
      });
    }
  }
  assert(
    failures.length === 0,
    label + ' changed presentation after Preview became available: ' + JSON.stringify(failures),
  );
}

function committedSelectionSequence(trace) {
  const sequence = [];
  trace.forEach(entry => {
    const labels = entry.state.labels.map(label => label.toLowerCase());
    const selected = entry.state.selected.map(label => label.toLowerCase());
    if (!labels.includes('code') || !labels.includes('blame') || selected.length !== 1) {
      return;
    }
    const label = selected[0];
    if (sequence.at(-1) !== label) {
      sequence.push(label);
    }
  });
  return sequence;
}

function visibleFrameTrace(trace) {
  return (trace || []).filter(entry => {
    if (entry.source === 'before') {
      return true;
    }
    if (entry.source !== 'raf') {
      return false;
    }
    const state = entry.state;
    return state.visibility !== 'hidden' && state.display !== 'none' && state.opacity !== '0';
  });
}

function visibleFrameSelectionSequence(trace) {
  return committedSelectionSequence(visibleFrameTrace(trace));
}

function assertSelectionSequence(trace, expected, label) {
  const actual = committedSelectionSequence(trace);
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    label +
      ' changed selection as ' +
      JSON.stringify(actual) +
      '; expected ' +
      JSON.stringify(expected) +
      '. Trace: ' +
      JSON.stringify(
        trace.map(entry => ({
          source: entry.source,
          selected: entry.state.selected,
          labels: entry.state.labels,
        })),
      ),
  );
}

function visiblePresentationFacts(trace) {
  return (trace || [])
    .filter(entry => entry.source === 'raf')
    .filter(entry => {
      const state = entry.state;
      return state.visibility !== 'hidden' && state.display !== 'none' && state.opacity !== '0';
    })
    .map(entry => ({
      selected: entry.state.selected,
      labels: entry.state.labels,
      previewLinkCount: entry.state.previewLinkCount,
      visibility: entry.state.visibility,
      display: entry.state.display,
      opacity: entry.state.opacity,
    }));
}

function assertNoVisibleIntermediate(trace, label) {
  const frames = visiblePresentationFacts(trace);
  const invalidSelection = frames.filter(frame => {
    const labels = frame.labels.map(value => value.toLowerCase());
    return labels.includes('preview') && labels.includes('code') && labels.includes('blame') &&
      frame.selected.length !== 1;
  });
  assert(
    invalidSelection.length === 0,
    label + ' exposed an invalid selected-tab state in a rendered frame: ' +
      JSON.stringify(invalidSelection),
  );

  const missingPreview = frames.filter(frame => {
    const labels = frame.labels.map(value => value.toLowerCase());
    return labels.includes('code') && labels.includes('blame') && frame.previewLinkCount !== 1;
  });
  assert(
    missingPreview.length === 0,
    label + ' dropped the Preview control in a rendered frame: ' + JSON.stringify(missingPreview),
  );
}

function assertSidebarContinuity(trace, label) {
  const frames = (trace || []).filter(entry => entry.source === 'raf');
  const missing = frames.filter(frame => {
    const sidebar = frame.state.sidebar;
    return sidebar === undefined ||
      !sidebar.present ||
      sidebar.visibility === 'hidden' ||
      sidebar.display === 'none';
  });
  assert(
    missing.length === 0,
    label + ' hid or removed the repository file tree during the transition: ' +
      JSON.stringify(missing),
  );
}

async function startTransitionTrace(page) {
  await page.evaluate(() => {
    const trace = [];
    let previousFrameKey = null;
    const capture = source => {
      const viewRoot = document.querySelector('ul[aria-label="File view"]');
      const items = viewRoot
        ? Array.from(viewRoot.querySelectorAll('li[data-component="SegmentedControl.Button"]'))
        : [];
      const selected = items
        .filter(item => {
          const control = item.matches('a, button') ? item : item.querySelector('a, button');
          return (
            item.hasAttribute('data-selected') ||
            item.getAttribute('aria-selected') === 'true' ||
            control?.getAttribute('aria-pressed') === 'true'
          );
        })
        .map(item => (item.querySelector('a, button') || item).textContent.trim());
      const state = {
        selected,
        labels: items.map(item => (item.querySelector('a, button') || item).textContent.trim()),
        classes: items.map(item => ({
          label: (item.querySelector('a, button') || item).textContent.trim(),
          item: String(item.className || ''),
          control: String((item.querySelector('a, button') || {}).className || ''),
          focused: item.contains(document.activeElement),
          active: item.matches(':active') || Boolean(item.querySelector('a, button')?.matches(':active')),
        })),
        visibility: viewRoot ? getComputedStyle(viewRoot).visibility : null,
        display: viewRoot ? getComputedStyle(viewRoot).display : null,
        opacity: viewRoot ? getComputedStyle(viewRoot).opacity : null,
        previewLinkCount: document.querySelectorAll('[data-ghpreview-link]').length,
        sidebar: (() => {
          const files = document.querySelector('[aria-label="Files"]');
          return {
            present: files !== null,
            visibility: files ? getComputedStyle(files).visibility : null,
            display: files ? getComputedStyle(files).display : null,
          };
        })(),
      };
      const previous = trace[trace.length - 1];
      const key = JSON.stringify(state);
      if (source === 'raf') {
        if (key === previousFrameKey) {
          return;
        }
        previousFrameKey = key;
      }
      if (!previous || JSON.stringify(previous.state) !== JSON.stringify(state) || source === 'raf') {
        trace.push({ source, at: performance.now(), state });
      }
    };
    const observer = new MutationObserver(records => {
      if (
        records.some(
          record =>
            record.type === 'childList' ||
            ['class', 'style', 'data-selected', 'aria-selected', 'aria-pressed'].includes(
              record.attributeName,
            ),
        )
      ) {
        capture('mutation');
      }
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'data-selected', 'aria-selected', 'aria-pressed'],
    });
    const frame = () => {
      capture('raf');
      window.__ghpreviewTransitionTrace.raf = requestAnimationFrame(frame);
    };
    window.__ghpreviewTransitionTrace = { trace, observer, raf: requestAnimationFrame(frame) };
    capture('before');
  });
}

async function stopTransitionTrace(page) {
  return page
    .evaluate(() => {
      const handle = window.__ghpreviewTransitionTrace;
      if (!handle) {
        return [];
      }
      cancelAnimationFrame(handle.raf);
      handle.observer.disconnect();
      return handle.trace;
    })
    .catch(() => null);
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
      !snapshot.hasError &&
      !snapshot.hasWarning
      ? snapshot
      : false;
  });
}

async function waitForTrustRequired(page) {
  return waitFor('the inline repository trust state', async () => {
    const snapshot = await inspect(page);
    return snapshot.state === 'trust-required' &&
      snapshot.errorCode === 'repository-not-allowed' &&
      snapshot.hasTrust &&
      !snapshot.hasFrame &&
      snapshot.previewAvailable
      ? snapshot
      : false;
  });
}

async function waitForTerminalState(page, expectedState = EXPECTED_STATE) {
  return waitFor('a stable terminal Preview state', async () => {
    const snapshot = await inspect(page);
    if (!['ready', 'failed', 'disabled', 'trust-required'].includes(snapshot.state)) {
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

function diagnosticEventsSince(startIndex) {
  return logs
    .slice(startIndex)
    .map(entry => {
      const prefix = '[html-preview] ';
      if (!entry.text.startsWith(prefix)) {
        return null;
      }
      try {
        return JSON.parse(entry.text.slice(prefix.length));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function assertMetadata(snapshot) {
  assert(snapshot.state, 'Preview did not expose data-preview-state.');
  assert(snapshot.requestId, 'Preview did not expose data-preview-request-id.');
  if (snapshot.state === 'ready' || snapshot.hasFrame) {
    assert(snapshot.sessionId, 'Preview did not expose data-preview-session-id.');
  }
  if (snapshot.state === 'failed' || snapshot.state === 'trust-required') {
    assert(snapshot.errorCode, 'Failed Preview did not expose data-preview-error-code.');
  }
}

function assertSelected(snapshot, label) {
  const selected = snapshot.views.filter(view => view.selected).map(view => view.label);
  assert(selected.length === 1, 'Expected exactly one selected file view, got ' + JSON.stringify(selected));
  assert(
    selected[0].toLowerCase() === label.toLowerCase(),
    label + ' is not selected: ' + JSON.stringify(snapshot.views),
  );
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

async function observeViewTransition(page, action, label, expectedView) {
  const logStart = logs.length;
  const before = await inspect(page);
  const beforeSelected = before.views.filter(view => view.selected).map(view => view.label.toLowerCase());
  await resetDomTrace(page);
  await startTransitionTrace(page);
  let actionError = null;
  let complete = false;
  const actionPromise = Promise.resolve()
    .then(action)
    .catch(error => {
      actionError = error;
    })
    .finally(() => {
      complete = true;
    });
  const deadline = Date.now() + 2000;
  while (!complete && Date.now() < deadline) {
    if (TRACE_TRANSITIONS) {
      await inspect(page).catch(() => null);
    }
    await page.waitForTimeout(16);
  }
  await actionPromise;
  assert(actionError === null, label + ' interaction failed: ' + actionError);

  const nativeView = expectedView === 'preview' ? 'code' : expectedView;
  const facts = await waitFor(label + ' lifecycle diagnostics', async () => {
    const diagnostics = diagnosticEventsSince(logStart);
    const navigationIndex = diagnostics.findIndex(
      event =>
        event.event === 'native-navigation-started' &&
        event.detail &&
        event.detail.target === expectedView,
    );
    const previewCommitIndex = diagnostics.findIndex(
      (event, index) =>
        index >= Math.max(navigationIndex, -1) &&
        expectedView === 'preview' &&
        event.event === 'preview-transition-committed',
    );
    const settledIndex = diagnostics.findIndex(
      (event, index) =>
        index >= Math.max(navigationIndex, -1) &&
        event.event === 'view-transition-host-settled' &&
        event.detail &&
        event.detail.expected === nativeView &&
        event.detail.selected === nativeView,
    );
    const appliedIndex = diagnostics.findIndex(
      (event, index) =>
        index >= Math.max(navigationIndex, -1) &&
        event.event === 'view-selection-applied' &&
        event.detail &&
        event.detail.selectedView === expectedView,
    );

    if (appliedIndex < 0) {
      return false;
    }
    if (
      expectedView !== 'code' &&
      (navigationIndex < 0 ||
        (expectedView === 'preview'
          ? previewCommitIndex < navigationIndex
          : settledIndex < navigationIndex))
    ) {
      return false;
    }
    return {
      navigationIndex,
      settledIndex: expectedView === 'preview' ? previewCommitIndex : settledIndex,
      appliedIndex,
    };
  });

  await waitFor(label + ' visible settled presentation', async () => {
    return page.evaluate(expected => {
      const root = document.querySelector('ul[aria-label="File view"]');
      if (root === null) {
        return false;
      }
      const style = getComputedStyle(root);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
        return false;
      }
      const items = Array.from(root.querySelectorAll('li[data-component="SegmentedControl.Button"]'));
      const selected = items
        .filter(item => {
          const control = item.matches('a, button') ? item : item.querySelector('a, button');
          return (
            item.hasAttribute('data-selected') ||
            item.getAttribute('aria-selected') === 'true' ||
            control?.getAttribute('aria-pressed') === 'true'
          );
        })
        .map(item => (item.querySelector('a, button') || item).textContent.trim().toLowerCase());
      return selected.length === 1 && selected[0] === expected &&
        document.querySelectorAll('[data-ghpreview-link]').length === 1;
    }, expectedView);
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve(true))));

  const trace = await stopTransitionTrace(page);
  const domTrace = await readDomTrace(page);
  const mutationSelectionSequence = committedSelectionSequence(domTrace);
  const frameSelectionSequence = trace === null ? [] : visibleFrameSelectionSequence(trace);
  const selectionSequence = frameSelectionSequence.length > 0
    ? frameSelectionSequence
    : mutationSelectionSequence;
  if (trace !== null) {
    assertNoVisibleIntermediate(trace, label);
  }
  if (label.endsWith('Blame -> Code')) {
    assert(
      trace !== null && trace.length > 0,
      label + ' caused a full document navigation instead of preserving the GitHub SPA shell.',
    );
    assertSidebarContinuity(trace, label);
  }
  if (beforeSelected.length === 1) {
    const documentNavigationToCode =
      beforeSelected[0] === 'blame' &&
      expectedView === 'code' &&
      JSON.stringify(mutationSelectionSequence) === JSON.stringify(['code']) &&
      frameSelectionSequence.length === 0;
    if (!documentNavigationToCode) {
      try {
        assertSelectionSequence(
          frameSelectionSequence.length > 0 ? visibleFrameTrace(trace) : domTrace,
          [beforeSelected[0], expectedView],
          label,
        );
      } catch (error) {
        if (trace !== null) {
          error.message +=
            ' Visible trace: ' +
            JSON.stringify(
              trace.map(entry => ({
                source: entry.source,
                selected: entry.state.selected,
                labels: entry.state.labels,
                visibility: entry.state.visibility,
                display: entry.state.display,
              })),
            );
        }
        throw error;
      }
    }
  }
  const diagnostics = diagnosticEventsSince(logStart);
  const eventNames = diagnostics.map(event => event.event);
  return {
    label,
    oracle: 'structured-diagnostics',
    facts,
    events: eventNames,
    selectionSequence,
    mutationSelectionSequence,
    selectionObservation:
      beforeSelected.length === 1 &&
      beforeSelected[0] === 'blame' &&
      expectedView === 'code' &&
      JSON.stringify(mutationSelectionSequence) === JSON.stringify(['code']) &&
      frameSelectionSequence.length === 0
        ? 'new-document-destination-only'
        : frameSelectionSequence.length > 0
          ? 'animation-frame'
          : 'mutation-only',
    ...(TRACE_TRANSITIONS && trace !== null ? { trace } : {}),
  };
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
  assert(snapshot.previewAvailable, 'Preview control is missing before navigation.');
  assert(snapshot.previewLinkCount === 1, 'Preview control is duplicated before navigation.');

  const previewToCode = await observeViewTransition(
    page,
    () => clickView(page, 'Code'),
    'Preview -> Code',
    'code',
  );
  snapshot = await waitForView(
    page,
    current =>
      new URL(page.url()).searchParams.get('plain') === '1' &&
      current.previewAvailable,
    'Preview -> Code',
  );
  assert(snapshot.previewLinkCount === 1, 'Preview control was duplicated after Preview -> Code.');
  assertSelected(snapshot, 'Code');

  const codeToBlame = await observeViewTransition(
    page,
    () => clickView(page, 'Blame'),
    'Code -> Blame',
    'blame',
  );
  snapshot = await waitForView(
    page,
    current => page.url().includes('/blame/') && current.previewAvailable,
    'Code -> Blame',
  );
  assert(snapshot.previewLinkCount === 1, 'Preview control was duplicated after Code -> Blame.');
  assertSelected(snapshot, 'Blame');

  const blameToPreview = await observeViewTransition(
    page,
    () => clickPreview(page),
    'Blame -> Preview',
    'preview',
  );
  snapshot = await waitForView(
    page,
    current =>
      page.url().includes('/blob/') &&
      !new URL(page.url()).searchParams.has('plain') &&
      current.previewAvailable,
    'Blame -> Preview',
  );
  assert(snapshot.previewLinkCount === 1, 'Preview control was duplicated after Blame -> Preview.');
  assertSelected(snapshot, 'Preview');

  const previewToBlame = await observeViewTransition(
    page,
    () => clickView(page, 'Blame'),
    'Preview -> Blame',
    'blame',
  );
  snapshot = await waitForView(
    page,
    current => page.url().includes('/blame/') && current.previewAvailable,
    'Preview -> Blame',
  );
  assert(snapshot.previewLinkCount === 1, 'Preview control was duplicated after Preview -> Blame.');
  assertSelected(snapshot, 'Blame');

  const blameToCode = await observeViewTransition(
    page,
    () => clickView(page, 'Code'),
    'Blame -> Code',
    'code',
  );
  snapshot = await waitForView(
    page,
    current =>
      page.url().includes('/blob/') &&
      new URL(page.url()).searchParams.get('plain') === '1' &&
      current.previewAvailable,
    'Blame -> Code',
  );
  assert(snapshot.previewLinkCount === 1, 'Preview control was duplicated after Blame -> Code.');
  assertSelected(snapshot, 'Code');

  return { previewToCode, codeToBlame, blameToPreview, previewToBlame, blameToCode };
}

async function waitForNativeView(page, expectedView) {
  return waitFor('a stable direct ' + expectedView + ' view', async () => {
    const snapshot = await inspect(page);
    const isSourceUrl = new URL(page.url()).searchParams.get('plain') === '1';
    const routeMatches = expectedView === 'blame'
      ? page.url().includes('/blame/')
      : isSourceUrl;
    if (!routeMatches || snapshot.state !== 'idle' || !snapshot.previewAvailable) {
      return false;
    }
    const selected = snapshot.views.filter(view => view.selected).map(view => view.label.toLowerCase());
    if (selected.length !== 1 || selected[0] !== expectedView) {
      return false;
    }
    await page.waitForTimeout(1000);
    const stable = await inspect(page);
    const stableSelected = stable.views.filter(view => view.selected).map(view => view.label.toLowerCase());
    return stable.state === 'idle' &&
      stable.previewAvailable &&
      stableSelected.length === 1 &&
      stableSelected[0] === expectedView
      ? stable
      : false;
  });
}

async function runDirectSourceContract(page) {
  const initialTrace = await readDomTrace(page);
  assertSelectionSequence(initialTrace, ['code'], 'Direct ?plain=1 startup');

  await resetDomTrace(page);
  const codeToBlame = await observeViewTransition(
    page,
    () => clickView(page, 'Blame'),
    'Direct Code -> Blame',
    'blame',
  );
  const snapshot = await waitForView(
    page,
    current => page.url().includes('/blame/') && current.previewAvailable,
    'Direct Code -> Blame',
  );
  assert(snapshot.previewLinkCount === 1, 'Preview control was duplicated after direct Code -> Blame.');
  assertSelected(snapshot, 'Blame');
  assertSelectionSequence(
    await readDomTrace(page),
    ['code', 'blame'],
    'Direct Code -> Blame',
  );

  return {
    codeToBlame,
    startupSelectionSequence: committedSelectionSequence(initialTrace),
  };
}

async function runDirectBlameContract(page) {
  const initialTrace = await readDomTrace(page);
  assertSelectionSequence(initialTrace, ['blame'], 'Direct Blame startup');

  const blameToCode = await observeViewTransition(
    page,
    () => clickView(page, 'Code'),
    'Direct Blame -> Code',
    'code',
  );
  const snapshot = await waitForView(
    page,
    current =>
      page.url().includes('/blob/') &&
      new URL(page.url()).searchParams.get('plain') === '1' &&
      current.previewAvailable,
    'Direct Blame -> Code',
  );
  assert(snapshot.previewLinkCount === 1, 'Preview control was duplicated after direct Blame -> Code.');
  assertSelected(snapshot, 'Code');
  assertSelectionSequence(
    await readDomTrace(page),
    ['blame', 'code'],
    'Direct Blame -> Code',
  );

  return {
    blameToCode,
    startupSelectionSequence: committedSelectionSequence(initialTrace),
  };
}

async function runTrustFlow(context, page, extensionId) {
  let snapshot = await waitForTrustRequired(page);
  assert(snapshot.previewLinkCount === 1, 'The first trust state duplicated the Preview control.');

  await page.locator('[data-ghpreview-trust="decline"]').click();
  snapshot = await waitFor('declining trust to keep the trust state', async () => {
    const current = await inspect(page);
    return current.state === 'trust-required' && current.hasTrust && !current.hasFrame
      ? current
      : false;
  });
  const declinedPopup = await openSettingsPopup(context, extensionId);
  assert(
    (await declinedPopup.locator('#repository-list > li').count()) === 0,
    'Declining repository trust must not change the allowlist.',
  );
  await declinedPopup.close();

  await page.locator('[data-ghpreview-trust="approve"]').click();
  snapshot = await waitForTerminalState(page, 'ready');
  assert(snapshot.hasFrame, 'Explicit repository trust did not continue into Preview.');
  assert(!snapshot.hasTrust, 'The trust surface remained after the repository was trusted.');

  const trustedPopup = await openSettingsPopup(context, extensionId);
  assert(
    (await trustedPopup.locator('#repository-list > li').count()) === 1,
    'The first trust action did not add exactly one repository entry.',
  );
  await trustedPopup.close();

  // Selecting Preview again exercises the already-trusted path and duplicate prevention.
  await clickView(page, 'Code');
  await waitForNativeView(page, 'code');
  await clickPreview(page);
  snapshot = await waitForTerminalState(page, 'ready');
  assert(snapshot.previewLinkCount === 1, 'Repeated Preview selection duplicated the control.');
  assert(snapshot.hasFrame, 'An already trusted repository did not return to Preview.');

  const removedPopup = await openSettingsPopup(context, extensionId);
  await removedPopup.locator('[data-remove-repository]').click();
  await waitFor('trusted repository removal', async () => {
    return (await removedPopup.locator('#repository-list > li').count()) === 0;
  });
  await removedPopup.close();

  snapshot = await waitForTrustRequired(page);
  assert(snapshot.hasTrust, 'Removing trust did not return the current Preview to trust-required.');
  await page.locator('[data-ghpreview-trust="approve"]').click();
  snapshot = await waitForTerminalState(page, 'ready');

  const restoredPopup = await openSettingsPopup(context, extensionId);
  assert(
    (await restoredPopup.locator('#repository-list > li').count()) === 1,
    'Re-trusting a repository created an unexpected number of entries.',
  );
  await restoredPopup.close();

  if (SECOND_TRUST_URL !== '') {
    const second = new URL(SECOND_TRUST_URL);
    if (second.origin !== 'https://github.com' || !/\/(?:blob|blame)\/.+\.(?:html?|xhtml)$/i.test(second.pathname)) {
      throw new Error('GHPREVIEW_E2E_SECOND_URL must point to an HTML Blob or Blame page.');
    }
    await page.goto(previewUrl(second.href), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    snapshot = await waitForTrustRequired(page);
    assert(snapshot.hasFrame === false, 'A different repository reused the previous Preview frame.');
    await page.locator('[data-ghpreview-trust="decline"]').click();
    snapshot = await waitForTrustRequired(page);
    await page.goto(initialTestUrl(), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    snapshot = await waitForTerminalState(page, 'ready');
    assert(snapshot.hasFrame, 'Returning to the trusted repository did not restore Preview.');
  }

  return {
    firstState: 'trust-required',
    finalState: snapshot.state,
    secondRepositoryChecked: SECOND_TRUST_URL !== '',
  };
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
  await installDomTrace(page);
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
  const extensionId = await configureSettingsThroughPopup(context, worker, {
    addRepository: !TRUST_FLOW,
  });
  await page.goto(initialTestUrl(), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

  const disabled = await waitForPreviewDisabled(page);
  console.log(JSON.stringify({ step: 'master-switch-off', ...disabled }));

  await setPreviewEnabledThroughPopup(context, extensionId, true);
  await page.goto(initialTestUrl(), { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

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
  } else if (TRUST_FLOW) {
    await waitForPreviewControl(page);
    const initialTrust = await waitForTrustRequired(page);
    assertMetadata(initialTrust);
    console.log(JSON.stringify({ step: 'trust-required', ...initialTrust }));
    const trustFlow = await runTrustFlow(context, page, extensionId);
    console.log(JSON.stringify({ step: 'trust-flow', ...trustFlow }));
    console.log('E2E passed.');
  } else {
    await waitForPreviewControl(page);

    const initial = EXPECTED_INITIAL_VIEW === 'preview'
      ? await waitForTerminalState(page)
      : await waitForNativeView(page, EXPECTED_INITIAL_VIEW);
    assertMetadata(initial);
    console.log(JSON.stringify({ step: 'terminal', ...initial }));
    if (EXPECTED_STATE) {
      assert(
        initial.state === EXPECTED_STATE,
        'Expected state ' + EXPECTED_STATE + ', got ' + initial.state + '.',
      );
    }
    if (EXPECTED_ERROR_CODE) {
      assert(
        initial.errorCode === EXPECTED_ERROR_CODE,
        'Expected error code ' + EXPECTED_ERROR_CODE + ', got ' + initial.errorCode + '.',
      );
    }
    if (EXPECTED_ERROR_CODE === 'sandbox-runtime-error') {
      assert(initial.state === 'ready', 'Runtime errors must preserve the ready Preview state.');
      assert(initial.hasFrame, 'Runtime errors must preserve the rendered Preview frame.');
      assert(!initial.hasError, 'Runtime errors must not replace the rendered document with an error surface.');
      assert(initial.hasWarning, 'Runtime errors must expose the extension-owned warning surface.');
    }

    const startupTrace = await readDomTrace(page);
    if (TRACE_STARTUP) {
      console.log(JSON.stringify({
        step: 'startup-trace',
        entries: startupTrace.map(entry => ({
          source: entry.source,
          selected: entry.state.selected,
          labels: entry.state.labels,
          previewLinkCount: entry.state.previewLinkCount,
          visibility: entry.state.visibility,
          display: entry.state.display,
          opacity: entry.state.opacity,
        })),
      }));
    }
    assertStartupPresentation(
      startupTrace,
      EXPECTED_INITIAL_VIEW,
      EXPECTED_INITIAL_VIEW === 'preview' ? 'Preview startup' : 'Direct ' + EXPECTED_INITIAL_VIEW + ' startup',
    );

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
      const navigation = EXPECTED_INITIAL_VIEW === 'code'
        ? await runDirectSourceContract(page)
        : EXPECTED_INITIAL_VIEW === 'blame'
          ? await runDirectBlameContract(page)
          : await runNavigationContract(page);
      console.log(JSON.stringify({ step: 'navigation-transition', ...navigation }));
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
