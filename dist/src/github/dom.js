/*
 * The only module that touches GitHub's page. Keep fragile DOM integration here.
 *
 * GitHub does not publish this DOM contract, so selectors are based on the live page.
 * DOM-HOOKS.md records what was checked. **Some selectors still need confirmation.**
 *
 * Silent failure is the hardest failure to diagnose. Try selectors in order, warn when
 * none match, and defer mounting until a safe file-body boundary is available.
 */
(function initGithubDom(global) {
  'use strict';

  const PROTOCOL_VERSION = global.GHPREVIEW.protocol?.VERSION || 1;

  /*
   * Try stronger, more semantic clues before weaker layout clues.
   * Keep this order so the selector that matched can be identified during debugging.
   */
  const SELECTORS = {
    /*
     * Code / Blame switch. This is where GitHub chooses how to view the same file, so it
     * is also the natural home for Preview. The actions on the right (Raw, copy, download,
     * and edit) export or modify the file and have a different purpose.
     */
    viewSwitch: [
      'ul[aria-label="File view"]',
      'ul[data-component="SegmentedControl"]',
    ],
    // One item in the switch. Use an unselected item as the visual template.
    viewSwitchItem: 'li[data-component="SegmentedControl.Button"]',
    // File header toolbar. It defines the boundary for hiding file content.
    toolbar: [
      '[data-testid="raw-button"]',
      '[data-testid="copy-raw-button"]',
      '[aria-label="Raw"]',
    ],
    // File-content container. Hide it and place the preview iframe in its position.
    content: [
      '[data-testid="read-only-cursor-text-area"]',
      '[data-testid="blob-viewer-file-content"]',
      '.react-blob-view-header-sticky ~ section',
      '#read-only-cursor-text-area',
    ],
  };

  const warned = new Set();

  function warn(key, message) {
    if (warned.has(key)) {
      return;
    }
    warned.add(key);
    console.warn(
      '[html-preview] ' +
        JSON.stringify({
          event: 'dom-warning',
          phase: 'dom',
          errorCode: key,
          detail: { message },
        }),
    );
  }

  /** Return the first matching selector. */
  function findFirst(candidates) {
    for (const selector of candidates) {
      const found = document.querySelector(selector);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }

  /**
   * Return true when GitHub has rendered its explicit missing-file response.
   *
   * A URL can still look like an HTML Blob URL after GitHub returns a 404. Do not let
   * the extension turn that error page into a Preview surface. Prefer GitHub's semantic
   * marker and keep the title as a fallback for server-rendered transitions.
   */
  function isMissingFilePage() {
    if (document.querySelector('[data-testid="error-404-description"]') !== null) {
      return true;
    }
    return /^File not found\b/i.test((document.title || '').trim());
  }

  // Mark inserted elements with an attribute rather than an id. The marker belongs to the
  // cloned item in GitHub's file-view switch.
  const LINK_MARK = 'data-ghpreview-link';
  const LINK_SELECTOR = '[' + LINK_MARK + ']';
  const FRAME_ID = 'ghpreview-frame';
  const ERROR_ID = 'ghpreview-error';
  const TRUST_ID = 'ghpreview-trust';
  const WARNING_ID = 'ghpreview-warning';
  const FRAME_PENDING_CLASS = 'ghpreview-frame-pending';
  const FRAME_WARNING_CLASS = 'ghpreview-frame-warning';
  const STYLE_ID = 'ghpreview-style';
  const PREVIEW_TOP_GAP_PX = 32;
  let activeErrorCode = null;
  let activeTrustCode = null;
  let activeWarningCode = null;

  function findViewSwitch() {
    return findFirst(SELECTORS.viewSwitch);
  }

  /**
   * Add Preview at the start of the Code / Blame switch.
   *
   * Follow the shape GitHub uses for `.md` files. Do not create a separate panel or
   * toolbar.
   */
  function insertPreviewLink(handlers) {
    if (document.querySelector(LINK_SELECTOR) !== null) {
      return true;
    }

    const viewSwitch = findViewSwitch();
    if (viewSwitch !== null) {
      return insertIntoViewSwitch(viewSwitch, handlers);
    }
    warn('view-switch', 'The GitHub file-view switch was not found; Preview cannot be inserted');
    return false;
  }

  /**
   * Insert at the start of the view switch.
   *
   * **Clone a neighboring item to borrow its appearance.** Do not depend on GitHub's
   * generated class names; reuse the same structure so minor naming changes are less
   * disruptive (see DOM-HOOKS.md).
   *
   * Prefer an unselected item. Cloning the selected item would copy its active styling.
   */
  function insertIntoViewSwitch(viewSwitch, handlers) {
    const items = Array.from(viewSwitch.querySelectorAll(SELECTORS.viewSwitchItem));
    const spare = items.find(item => !isSelectedItem(item)) || items[0];
    if (spare === null) {
      warn('view-switch', 'The GitHub file-view switch has no items; Preview cannot be inserted');
      return false;
    }

    const clone = spare.cloneNode(true);

    // Keep the visual structure but remove identity markers. Duplicated markers would
    // confuse code that locates the original GitHub items.
    forEachIncludingSelf(clone, node => {
      node.removeAttribute('id');
      node.removeAttribute('data-testid');
      node.removeAttribute('aria-current');
      node.removeAttribute('aria-selected');
      node.removeAttribute('data-selected');
    });

    const control = clone.matches('a, button') ? clone : clone.querySelector('a, button');
    if (control === null) {
      warn('view-switch', 'The GitHub file-view switch has no clickable control; Preview cannot be inserted');
      return false;
    }

    setLabel(clone, control, 'Preview');
    if (typeof handlers.href === 'string' && control.matches('a')) {
      control.href = handlers.href;
    }
    control.addEventListener('click', event => {
      const allowDefault = handlers.onPreview(event) === true;
      if (!allowDefault) {
        event.preventDefault();
      }
    });

    clone.setAttribute(LINK_MARK, '');
    viewSwitch.insertBefore(clone, viewSwitch.firstElementChild);
    return true;
  }

  /**
   * Replace the visible label.
   *
   * **Update `data-text` as well as the visible text.** GitHub uses the duplicate value to
   * reserve width when the selected item becomes bold. Updating only one would shift the
   * switch when Preview is selected.
   */
  function setLabel(clone, control, label) {
    const holder = clone.querySelector('[data-text]');
    if (holder === null) {
      control.textContent = label;
      return;
    }
    holder.textContent = label;
    holder.setAttribute('data-text', label);
  }

  function itemControl(item) {
    return item.matches('a, button') ? item : item.querySelector('a, button');
  }

  function isSelectedItem(item) {
    const control = itemControl(item);
    return (
      item.hasAttribute('data-selected') ||
      item.getAttribute('aria-selected') === 'true' ||
      (control !== null && control.getAttribute('aria-pressed') === 'true')
    );
  }

  /**
   * Reflect the current selection in the view switch.
   *
   * Preview is a peer option; omitting this would make it look unselected after a click.
   */
  function markPreviewSelected(isPreview, preferredNativeLabel = null) {
    const ours = document.querySelector(LINK_SELECTOR);
    if (ours === null || !ours.matches(SELECTORS.viewSwitchItem)) {
      return;
    }
    const viewSwitch = ours.parentElement;
    const nativeItems = Array.from(viewSwitch.children).filter(
      item => !item.hasAttribute(LINK_MARK),
    );
    const nativeSelected = nativeItems.find(isSelectedItem);

    if (isPreview) {
      nativeItems.forEach(item => setSelected(item, false));
      setSelected(ours, true);
      return;
    }

    // When leaving Preview, GitHub is the source of truth. If its click handler has not
    // committed the selection yet, use the route-derived destination as a one-item
    // fallback. Never restore a selection remembered from an earlier route: on Blame that
    // would briefly select both Code and Blame while the SPA replaces the file view.
    const preferred =
      typeof preferredNativeLabel === 'string'
        ? nativeItems.find(item => itemLabel(item) === preferredNativeLabel)
        : undefined;
    const selected = preferred || nativeSelected;
    if (selected !== undefined) {
      nativeItems.forEach(item => setSelected(item, item === selected));
    }
    setSelected(ours, false);
  }

  function setSelected(item, selected) {
    if (selected) {
      item.setAttribute('data-selected', '');
    } else {
      item.removeAttribute('data-selected');
    }
    const control = item.querySelector('a, button');
    if (item.hasAttribute('aria-selected')) {
      item.setAttribute('aria-selected', selected ? 'true' : 'false');
    }
    if (control !== null && control.hasAttribute('aria-pressed')) {
      control.setAttribute('aria-pressed', selected ? 'true' : 'false');
    }
  }

  function itemLabel(item) {
    const control = itemControl(item);
    return (control || item).textContent.trim().toLowerCase();
  }

  /**
   * Read only GitHub-owned selection state, excluding the extension's Preview item.
   * During a SPA route change this is the signal used by preview.js to decide whether
   * the host switch has settled enough for one final reconciliation.
   */
  function viewSwitchState() {
    const viewSwitch = findViewSwitch();
    if (viewSwitch === null) {
      return { ready: false, selected: null, signature: 'missing', root: null };
    }
    const nativeItems = Array.from(viewSwitch.querySelectorAll(SELECTORS.viewSwitchItem)).filter(
      item => !item.hasAttribute(LINK_MARK),
    );
    const labels = nativeItems.map(itemLabel);
    const selected = nativeItems.find(isSelectedItem);
    const selectedLabel = selected ? itemLabel(selected) : null;
    return {
      ready: labels.includes('code') && labels.includes('blame'),
      selected: selectedLabel,
      signature: labels.join('|') + '::' + (selectedLabel || ''),
      root: viewSwitch,
    };
  }

  /**
   * Observe clicks on Code and Blame.
   *
   * These controls do not always change the query, so the controller must apply
   * `?plain=1` itself. **Do not bind only to individual buttons.** GitHub can replace the
   * view, so listen at document level and inspect the clicked item.
   */
  function onLeavePreview(handle) {
    document.addEventListener(
      'click',
      event => {
        const item = event.target.closest
          ? event.target.closest(SELECTORS.viewSwitchItem)
          : null;
        if (item === null || item.hasAttribute(LINK_MARK)) {
          return;
        }
        const control = item.matches('a, button') ? item : item.querySelector('a, button');
        const label = (control || item).textContent.trim().toLowerCase();
        handle({ item, control, label, event });
      },
      true,
    );
  }

  function forEachIncludingSelf(root, handle) {
    handle(root);
    root.querySelectorAll('*').forEach(handle);
  }

  function removePreviewLink() {
    document.querySelectorAll(LINK_SELECTOR).forEach(node => node.remove());
  }

  /** Load extension styles with a ghpreview- namespace to avoid GitHub collisions. */
  function ensureStyle(cssUrl) {
    if (document.getElementById(STYLE_ID) !== null) {
      return;
    }
    const style = document.createElement('link');
    style.id = STYLE_ID;
    style.rel = 'stylesheet';
    style.href = cssUrl;
    // document_start can run before head exists.
    (document.head || document.documentElement).appendChild(style);
  }

  function createAction(label, className, handler) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    button.addEventListener('click', handler);
    return button;
  }

  function createTrustAction(label, className, handler) {
    const button = createAction(label, className, () => {
      if (button.disabled) {
        return;
      }
      button.disabled = true;
      button.textContent = 'Trusting…';
      if (typeof handler === 'function') {
        handler();
      }
    });
    return button;
  }

  function appendIssueLocation(item, issue) {
    const location = issue && typeof issue === 'object' ? issue.location : null;
    if (!location || !Number.isInteger(location.line)) {
      return;
    }

    const details = document.createElement('details');
    details.className = 'ghpreview-error-location';
    details.open = true;

    const summary = document.createElement('summary');
    summary.textContent =
      'Line ' +
      location.line +
      (Number.isInteger(location.column) ? ', column ' + location.column : '') +
      (location.target ? ' · ' + location.target : '');
    details.append(summary);

    const frame = document.createElement('pre');
    const code = document.createElement('code');
    const target = typeof location.target === 'string' ? location.target : 'source';
    const matched = /^([a-z][a-z0-9-]*)\[([a-z][a-z0-9-]*)\]$/i.exec(target);
    code.textContent = matched
      ? '<' + matched[1] + ' ' + matched[2] + '="[redacted]">'
      : '<' + target + '> … </' + target + '>';
    frame.append(code);
    details.append(frame);
    item.append(details);
  }

  /**
   * Show an extension-owned failure surface in the same area as the preview frame.
   *
   * The source container stays hidden while this surface is visible. This keeps the
   * Preview selection stable without allowing an invalid document to reach the sandbox.
   */
  function showError(details) {
    removeError();
    removeTrustRequired();
    removeWarning();

    const errorCode = details.code || details.errorCode || 'preview-failed';
    activeErrorCode = errorCode;

    const region = document.createElement('section');
    region.id = ERROR_ID;
    region.className = 'ghpreview-error-region';
    region.setAttribute('role', 'alert');
    region.setAttribute('data-preview-error-code', errorCode);

    const surface = document.createElement('div');
    surface.className = 'ghpreview-error-surface';

    const heading = document.createElement('div');
    heading.className = 'ghpreview-error-heading';

    const icon = document.createElement('span');
    icon.className = 'ghpreview-error-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '!';

    const title = document.createElement('h2');
    title.textContent = 'Preview unavailable';
    heading.append(icon, title);

    const reason = document.createElement('p');
    reason.className = 'ghpreview-error-reason';
    reason.textContent = details.reason || 'This file could not be previewed.';

    surface.append(heading, reason);

    const issues = Array.isArray(details.issues) ? details.issues : [];
    if (issues.length > 0) {
      const issueTitle = document.createElement('h3');
      issueTitle.textContent = 'Detected issues';
      const issueList = document.createElement('ul');
      issueList.className = 'ghpreview-error-issues';
      issues.forEach(issue => {
        const message = typeof issue === 'string' ? issue : issue && issue.message;
        if (typeof message !== 'string' || message === '') {
          return;
        }
        const item = document.createElement('li');
        const copy = document.createElement('div');
        copy.className = 'ghpreview-error-issue-message';
        copy.textContent = message;
        item.append(copy);
        appendIssueLocation(item, issue);
        issueList.append(item);
      });
      if (issueList.childElementCount > 0) {
        surface.append(issueTitle, issueList);
      }
    }

    const actions = document.createElement('div');
    actions.className = 'ghpreview-error-actions';
    actions.append(
      createAction('Open Code', 'ghpreview-error-button ghpreview-error-button-secondary', () => {
        if (typeof details.onOpenCode === 'function') {
          details.onOpenCode();
        }
      }),
      createAction('Recheck', 'ghpreview-error-button ghpreview-error-button-primary', () => {
        if (typeof details.onRecheck === 'function') {
          details.onRecheck();
        }
      }),
    );
    surface.append(actions);

    const note = document.createElement('p');
    note.className = 'ghpreview-error-note';
    note.textContent = 'Preview remains active. Code and Blame remain available above.';
    surface.append(note);

    const diagnostic = document.createElement('p');
    diagnostic.className = 'ghpreview-error-diagnostic';
    diagnostic.append('Diagnostic code: ');
    const code = document.createElement('code');
    code.textContent = errorCode;
    diagnostic.append(code);
    surface.append(diagnostic);

    region.append(surface);

    const frame = document.getElementById(FRAME_ID);
    if (frame !== null) {
      // A frame can be staged before GitHub has finished inserting its file body. Try
      // the normal placement once more before deciding whether this is an overlay error.
      placeFrame(frame);
      const staged =
        frame.classList.contains(FRAME_PENDING_CLASS);
      if (staged && hideContentForPreview()) {
        frame.remove();
        const body = hiddenContainer;
        applyPreviewTopOffset(region, body.parentElement);
        body.parentElement.insertBefore(region, body);
        setPreviewMetadata({ ...details, errorCode });
        return true;
      }
      if (staged) {
        region.classList.add('ghpreview-error-overlay');
      }
      applyPreviewTopOffset(region, frame.parentElement);
      frame.replaceWith(region);
      setPreviewMetadata({ ...details, errorCode });
      return true;
    }

    if (hideContentForPreview()) {
      const body = hiddenContainer;
      applyPreviewTopOffset(region, body.parentElement);
      body.parentElement.insertBefore(region, body);
      setPreviewMetadata({ ...details, errorCode });
      return true;
    }

    region.classList.add('ghpreview-error-overlay');
    (document.body || document.documentElement).appendChild(region);
    setPreviewMetadata({ ...details, errorCode });
    return true;
  }

  function removeError() {
    const surface = document.getElementById(ERROR_ID);
    if (surface !== null) {
      surface.remove();
    }
    activeErrorCode = null;
  }

  /**
   * Show the explicit repository trust gate without presenting it as a failed Preview.
   * The source body remains hidden while the user decides; no Worker request or sandbox
   * frame is started until the trust action succeeds.
   */
  function showTrustRequired(details = {}) {
    removeTrustRequired();
    removeError();
    removeWarning();

    const errorCode = details.code || details.errorCode || 'repository-not-allowed';
    activeTrustCode = errorCode;

    const region = document.createElement('section');
    region.id = TRUST_ID;
    region.className = 'ghpreview-trust-region';
    region.setAttribute('role', 'region');
    region.setAttribute('aria-labelledby', TRUST_ID + '-title');
    region.setAttribute('data-preview-error-code', errorCode);

    const surface = document.createElement('div');
    surface.className = 'ghpreview-trust-surface';

    const heading = document.createElement('div');
    heading.className = 'ghpreview-trust-heading';

    const icon = document.createElement('span');
    icon.className = 'ghpreview-trust-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '✓';

    const title = document.createElement('h2');
    title.id = TRUST_ID + '-title';
    title.textContent = 'Trust this repository for Preview?';
    heading.append(icon, title);

    const reason = document.createElement('p');
    reason.className = 'ghpreview-trust-reason';
    reason.textContent = details.reason ||
      'HTML Preview is enabled, but this repository is not trusted yet.';

    const repository = document.createElement('p');
    repository.className = 'ghpreview-trust-repository';
    repository.append('Repository: ');
    const repositoryCode = document.createElement('code');
    repositoryCode.textContent = details.repository || 'current repository';
    repository.append(repositoryCode);

    const issues = document.createElement('ul');
    issues.className = 'ghpreview-trust-issues';
    ['Only this exact repository will be added.', 'No page content is sent before you trust it.']
      .forEach(message => {
        const item = document.createElement('li');
        item.textContent = message;
        issues.append(item);
      });

    surface.append(heading, reason, repository, issues);

    const actions = document.createElement('div');
    actions.className = 'ghpreview-trust-actions';
    const trustButton = createTrustAction(
      'Trust repository',
      'ghpreview-trust-button ghpreview-trust-button-primary',
      details.onTrust,
    );
    trustButton.dataset.ghpreviewTrust = 'approve';
    const declineButton = createAction(
      'Not now',
      'ghpreview-trust-button ghpreview-trust-button-secondary',
      details.onDecline,
    );
    declineButton.dataset.ghpreviewTrust = 'decline';
    actions.append(trustButton, declineButton);
    surface.append(actions);

    const note = document.createElement('p');
    note.className = 'ghpreview-trust-note';
    note.textContent = 'You can review or remove trusted repositories from the extension popup.';
    surface.append(note);

    const diagnostic = document.createElement('p');
    diagnostic.className = 'ghpreview-trust-diagnostic';
    diagnostic.append('Trust status: ');
    const code = document.createElement('code');
    code.textContent = errorCode;
    diagnostic.append(code);
    surface.append(diagnostic);

    region.append(surface);

    const frame = document.getElementById(FRAME_ID);
    if (frame !== null) {
      placeFrame(frame);
      const staged = frame.classList.contains(FRAME_PENDING_CLASS);
      if (staged && hideContentForPreview()) {
        frame.remove();
        const body = hiddenContainer;
        applyPreviewTopOffset(region, body.parentElement);
        body.parentElement.insertBefore(region, body);
        setPreviewMetadata({ ...details, state: 'trust-required', errorCode });
        return true;
      }
      if (staged) {
        region.classList.add('ghpreview-trust-overlay');
      }
      applyPreviewTopOffset(region, frame.parentElement);
      frame.replaceWith(region);
      setPreviewMetadata({ ...details, state: 'trust-required', errorCode });
      return true;
    }

    if (hideContentForPreview()) {
      const body = hiddenContainer;
      applyPreviewTopOffset(region, body.parentElement);
      body.parentElement.insertBefore(region, body);
      setPreviewMetadata({ ...details, state: 'trust-required', errorCode });
      return true;
    }

    region.classList.add('ghpreview-trust-overlay');
    (document.body || document.documentElement).appendChild(region);
    setPreviewMetadata({ ...details, state: 'trust-required', errorCode });
    return true;
  }

  function removeTrustRequired() {
    const surface = document.getElementById(TRUST_ID);
    if (surface !== null) {
      surface.remove();
    }
    activeTrustCode = null;
  }

  function hasTrustRequired() {
    return document.getElementById(TRUST_ID) !== null;
  }

  /**
   * Show a non-destructive warning while keeping the rendered document visible.
   * Runtime errors are a property of the document, not a reason to discard its UI.
   */
  function showRuntimeWarning(details = {}) {
    removeTrustRequired();
    removeWarning();

    const errorCode = details.code || details.errorCode || 'sandbox-runtime-error';
    activeWarningCode = errorCode;

    const region = document.createElement('aside');
    region.id = WARNING_ID;
    region.className = 'ghpreview-runtime-warning';
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
    region.setAttribute('data-preview-error-code', errorCode);

    const heading = document.createElement('div');
    heading.className = 'ghpreview-runtime-warning-heading';

    const icon = document.createElement('span');
    icon.className = 'ghpreview-runtime-warning-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '!';

    const title = document.createElement('strong');
    title.textContent = 'Preview warning';
    heading.append(icon, title);

    const reason = document.createElement('p');
    reason.className = 'ghpreview-runtime-warning-reason';
    reason.textContent = details.reason || 'The document reported a runtime error after rendering.';

    const diagnostic = document.createElement('span');
    diagnostic.className = 'ghpreview-runtime-warning-diagnostic';
    diagnostic.textContent = errorCode;

    region.append(heading, reason, diagnostic);

    const frame = document.getElementById(FRAME_ID);
    if (frame !== null && frame.parentElement !== null) {
      placeFrame(frame);
      frame.classList.add(FRAME_WARNING_CLASS);
      applyPreviewTopOffset(region, frame.parentElement);
      frame.parentElement.insertBefore(region, frame);
      setPreviewMetadata({
        state: details.state || 'ready',
        errorCode,
        requestId: details.requestId,
        sessionId: details.sessionId,
      });
      return true;
    }

    // Runtime errors are expected after the frame is mounted. Keep a safe fallback for a
    // race during teardown without hiding or replacing any host-page content.
    region.classList.add('ghpreview-runtime-warning-overlay');
    (document.body || document.documentElement).appendChild(region);
    setPreviewMetadata({
      state: details.state || 'ready',
      errorCode,
      requestId: details.requestId,
      sessionId: details.sessionId,
    });
    return true;
  }

  function removeWarning() {
    const surface = document.getElementById(WARNING_ID);
    if (surface !== null) {
      surface.remove();
    }
    const frame = document.getElementById(FRAME_ID);
    if (frame !== null) {
      frame.classList.remove(FRAME_WARNING_CLASS);
    }
    activeWarningCode = null;
  }

  function hasError() {
    return document.getElementById(ERROR_ID) !== null;
  }

  function hasWarning() {
    return document.getElementById(WARNING_ID) !== null;
  }

  function hasPreviewLink() {
    return document.querySelector(LINK_SELECTOR) !== null;
  }

  function hasFrame() {
    return document.getElementById(FRAME_ID) !== null;
  }

  /**
   * Report whether the host page has exposed a boundary that still needs reconciliation.
   * The controller uses this to distinguish GitHub's incomplete SPA swap from mutations
   * caused by the extension's own iframe, error surface, or lifecycle attributes.
   */
  function needsReconcile() {
    const frame = document.getElementById(FRAME_ID);
    if (
      frame !== null &&
      frame.classList.contains(FRAME_PENDING_CLASS)
    ) {
      return true;
    }
    const error = document.getElementById(ERROR_ID);
    if (error !== null && error.classList.contains('ghpreview-error-overlay')) {
      return true;
    }
    const trust = document.getElementById(TRUST_ID);
    return trust !== null && trust.classList.contains('ghpreview-trust-overlay');
  }

  function getErrorCode() {
    const region = document.getElementById(ERROR_ID);
    return (
      region?.getAttribute('data-preview-error-code') ||
      activeErrorCode ||
      document.getElementById(TRUST_ID)?.getAttribute('data-preview-error-code') ||
      activeTrustCode ||
      document.getElementById(WARNING_ID)?.getAttribute('data-preview-error-code') ||
      activeWarningCode
    );
  }

  /**
   * Keep lifecycle metadata on the extension surface and document root.
   *
   * The root fallback matters during GitHub SPA transitions, when the old surface has
   * already been removed but the new file body has not been inserted yet. Values are
   * generated by preview.js and contain no page content, URL, or repository data.
   */
  function setPreviewMetadata(metadata = {}) {
    const targets = [
      document.documentElement,
      document.getElementById(FRAME_ID),
      document.getElementById(ERROR_ID),
      document.getElementById(TRUST_ID),
      document.getElementById(WARNING_ID),
    ].filter(Boolean);
    const attributes = [
      ['data-preview-state', metadata.state],
      ['data-preview-error-code', metadata.errorCode],
      ['data-preview-request-id', metadata.requestId],
      ['data-preview-session-id', metadata.sessionId],
    ];
    targets.forEach(target => {
      attributes.forEach(([name, value]) => {
        if (value === undefined || value === null || value === '') {
          target.removeAttribute(name);
        } else {
          target.setAttribute(name, String(value));
        }
      });
    });
  }

  /**
   * Move an early error surface into the file body once GitHub has finished its SPA swap.
   *
   * Validation can finish before GitHub exposes the code container. In that window the
   * surface has to be visible somewhere, but it must stop being an overlay as soon as the
   * real insertion boundary becomes available.
   */
  function reconcileError() {
    const region = document.getElementById(ERROR_ID);
    if (region === null || !region.classList.contains('ghpreview-error-overlay')) {
      return region !== null;
    }
    if (!hideContentForPreview()) {
      return false;
    }
    const body = hiddenContainer;
    region.classList.remove('ghpreview-error-overlay');
    if (body.parentElement !== null) {
      applyPreviewTopOffset(region, body.parentElement);
      body.parentElement.insertBefore(region, body);
    }
    return true;
  }

  function reconcileTrust() {
    const region = document.getElementById(TRUST_ID);
    if (region === null || !region.classList.contains('ghpreview-trust-overlay')) {
      return region !== null;
    }
    if (!hideContentForPreview()) {
      return false;
    }
    const body = hiddenContainer;
    region.classList.remove('ghpreview-trust-overlay');
    if (body.parentElement !== null) {
      applyPreviewTopOffset(region, body.parentElement);
      body.parentElement.insertBefore(region, body);
    }
    return true;
  }

  function hideContentForPreview() {
    const container = findFirst(SELECTORS.content);
    if (container === null) {
      return false;
    }
    const body = expandToFileBody(container);
    if (body.parentElement === null) {
      return false;
    }
    body.style.display = 'none';
    hiddenContainer = body;
    return true;
  }

  /**
   * GitHub's sticky file toolbar can visually overflow a zero-height layout wrapper.
   * Calculate the offset from that wrapper's top to the toolbar's visible bottom so the
   * preview still has a real gap after the toolbar instead of hiding the gap underneath it.
   */
  function previewTopOffset(boundary) {
    const toolbar = findFirst(SELECTORS.toolbar);
    if (toolbar === null || boundary === null) {
      return PREVIEW_TOP_GAP_PX;
    }
    const boundaryRect = boundary.getBoundingClientRect();
    const toolbarRect = toolbar.getBoundingClientRect();
    return Math.max(
      PREVIEW_TOP_GAP_PX,
      Math.ceil(toolbarRect.bottom - boundaryRect.top) + PREVIEW_TOP_GAP_PX,
    );
  }

  function applyPreviewTopOffset(surface, boundary) {
    surface.style.setProperty('--ghpreview-top-offset', previewTopOffset(boundary) + 'px');
  }

  function sandboxPolicy(capabilities = {}) {
    // The bundled bootstrap always needs allow-scripts to start. The javascript setting
    // controls repository scripts separately in prepareDocument; it must not disable the
    // bootstrap that enforces the opaque-origin message boundary.
    const tokens = ['allow-scripts'];
    if (capabilities.modals === true) {
      tokens.push('allow-modals');
    }
    return tokens.join(' ');
  }

  /**
   * Mount the iframe.
   *
   * > **Never add `allow-same-origin`.** It would let code from a repository contributor
   * > act as the viewer on github.com. The iframe attribute and sandbox page policy both
   * > enforce this boundary (MODEL.md).
   */
  // Remember the hidden container so it can be restored when the preview is removed.
  let hiddenContainer = null;

  /** Place an existing frame into the GitHub file body when that body is available. */
  function placeFrame(frame) {
    const container = findFirst(SELECTORS.content);
    if (container === null) {
      frame.classList.remove('ghpreview-frame-inline');
      frame.classList.add(FRAME_PENDING_CLASS);
      frame.setAttribute('aria-hidden', 'true');
      return false;
    }

    const body = expandToFileBody(container);
    if (body.parentElement === null) {
      return false;
    }

    frame.classList.remove(FRAME_PENDING_CLASS);
    frame.classList.add('ghpreview-frame-inline');
    frame.removeAttribute('aria-hidden');
    applyPreviewTopOffset(frame, body.parentElement);
    body.style.display = 'none';
    hiddenContainer = body;
    if (frame.parentElement !== body.parentElement || frame.nextSibling !== body) {
      body.parentElement.insertBefore(frame, body);
    }
    return true;
  }

  /**
   * Keep the iframe on the extension-bundled entry point.
   *
   * `srcdoc` takes precedence over `src`. If another page integration or a stale frame
   * leaves an empty `srcdoc` attribute behind, Chrome loads `about:srcdoc` instead of
   * `sandbox.html`; the result is a white frame with no bootstrap or ready message.
  */
  function ensureBundledEntry(frame, sandboxUrl) {
    // Set the fallback navigation first. Removing srcdoc below then activates this
    // already-known entry instead of triggering a second src update afterward.
    const needsSrc = frame.getAttribute('src') !== sandboxUrl;
    if (needsSrc) {
      frame.setAttribute('src', sandboxUrl);
    }

    const hadSrcdoc = frame.hasAttribute('srcdoc');
    if (hadSrcdoc) {
      frame.removeAttribute('srcdoc');
      warn('sandbox-entry', 'Removed an unexpected srcdoc attribute from the sandbox frame');
    }
    return hadSrcdoc;
  }

  /**
   * Mount the iframe. **Do so as soon as the file-content container exists, without
   * waiting for the fetch.**
   *
   * Waiting would leave the source visible and cause a visual jump. The sandbox page
   * owns the loading message, so no placeholder is needed here. Mounting early also
   * gives the document its correct width from the beginning.
   *
   * Repeated calls keep one iframe and return the existing element.
   */
  function mountFrame(sandboxUrl, capabilities, beforeInsert) {
    const policy = sandboxPolicy(capabilities);
    const existing = document.getElementById(FRAME_ID);
    if (existing !== null) {
      existing.setAttribute('sandbox', policy);
      // Prepare the listener before repairing an entry that may already be navigating.
      if (typeof beforeInsert === 'function') {
        beforeInsert(existing, false);
      }
      const entryRepaired = ensureBundledEntry(existing, sandboxUrl);
      placeFrame(existing);
      return {
        frame: existing,
        hidden: hiddenContainer,
        created: false,
        entryRepaired,
      };
    }

    // GitHub may still be replacing the file body. Do not create a frame outside the
    // known content boundary: moving an already-running sandbox later can reset its
    // document, and an overlay can cover the entire GitHub page.
    if (findFirst(SELECTORS.content) === null) {
      warn('content', 'The file-content container was not found; delaying sandbox mount');
      return { frame: null, hidden: hiddenContainer, created: false };
    }

    const frame = document.createElement('iframe');
    frame.id = FRAME_ID;
    frame.setAttribute('sandbox', policy);
    // Set the known bundled entry point before insertion. The callback lets the parent
    // subscribe before the browsing context starts.
    frame.src = sandboxUrl;
    if (typeof beforeInsert === 'function') {
      beforeInsert(frame, true);
    }
    placeFrame(frame);
    // Remove any srcdoc attribute added while the host page reconciled the inserted node.
    // The listener is already active, so a corrective navigation cannot lose the handshake.
    const entryRepaired = ensureBundledEntry(frame, sandboxUrl);
    return { frame, hidden: hiddenContainer, created: true, entryRepaired };
  }

  /**
   * Expand the hidden range to cover the complete file-content region.
   *
   * The selector can match only the text area; **line-number columns are siblings**. Hiding
   * only the text area leaves line numbers below the preview (see DOM-HOOKS.md).
   *
   * Do not use class names for expansion. Walk outward until the parent contains the
   * Raw / Blame toolbar; that boundary separates content to hide from controls to keep.
   */
  function expandToFileBody(element) {
    const toolbar = findFirst(SELECTORS.toolbar);
    if (toolbar === null) {
      // Do not expand when the boundary is unknown; hiding too much is worse.
      return element;
    }
    let node = element;
    while (
      node.parentElement !== null &&
      node.parentElement !== document.body &&
      node.parentElement !== document.documentElement &&
      !node.parentElement.contains(toolbar)
    ) {
      node = node.parentElement;
    }
    return node;
  }

  function removeFrame() {
    const frame = document.getElementById(FRAME_ID);
    if (frame !== null) {
      frame.remove();
    }
    removeError();
    removeTrustRequired();
    removeWarning();
    if (hiddenContainer !== null) {
      hiddenContainer.style.display = '';
      hiddenContainer = null;
    }
    // The next document may have a similar height. Reset the previous value so the first
    // measurement is not suppressed by the change guard.
    appliedHeight = 0;
  }

  /**
   * Prepare the validated HTML for the sandbox.
   *
   * Validation has already rejected every relative or external resource. This step must
   * not fetch or inline anything; it only removes repository scripts and inline handlers
   * when the corresponding capability is disabled, removes a document base element that
   * could change navigation resolution, and adds the parent height reporter.
   */
  function applyCapabilities(doc, capabilities = {}) {
    if (capabilities.javascript === true) {
      return;
    }

    // The sandbox bootstrap remains enabled, but repository code must not execute when
    // the JavaScript capability is off. Remove both script elements and inline handlers
    // before the document is serialized and sent to the sandbox.
    doc.querySelectorAll('script').forEach(element => element.remove());
    doc.querySelectorAll('*').forEach(element => {
      Array.from(element.attributes).forEach(attribute => {
        if (/^on/i.test(attribute.name)) {
          element.removeAttribute(attribute.name);
        }
      });
    });
  }

  function prepareDocument(htmlText, sessionId = '', capabilities = {}) {
    const doc = new DOMParser().parseFromString(htmlText, 'text/html');

    applyCapabilities(doc, capabilities);

    // A remaining <base> could redirect an unresolved reference unexpectedly.
    doc.querySelectorAll('base').forEach(element => element.remove());

    addHeightReporter(doc, sessionId);

    return '<!doctype html>\n' + doc.documentElement.outerHTML;
  }

  /*
   * Add a height reporter for the parent page.
   *
   * A fixed iframe height creates a second scrollbar and makes the document feel like a
   * window. Matching the document height lets the page's own scrollbar do the work.
   *
   * This is the only code injected into the document. It posts only to github.com, and
   * preview.js verifies the sender window.
   */
  const HEIGHT_REPORTER = [
    '(function(){',
    '  var sessionId = __GHPREVIEW_SESSION_ID__;',
    '  var renderReady = false;',
    '  function post(type, payload){',
    '    parent.postMessage(Object.assign({ protocolVersion: __GHPREVIEW_PROTOCOL_VERSION__, type: type, sessionId: sessionId }, payload || {}), "https://github.com");',
    '  }',
    '  function announceReady(){',
    '    if (renderReady) { return; }',
    '    renderReady = true;',
    '    post("ghpreview:render-ready");',
    '  }',
    '  function measure(){',
    '    var d = document.documentElement;',
    '    var b = document.body;',
    '    return Math.max(',
    '      d ? d.scrollHeight : 0, d ? d.offsetHeight : 0,',
    '      b ? b.scrollHeight : 0, b ? b.offsetHeight : 0,',
    '    );',
    '  }',
    '  function report(){',
    '    announceReady();',
    '    post("ghpreview:height", { height: measure() });',
    '  }',
    '  window.addEventListener("error", function(){',
    '    post("ghpreview:runtime-error", { errorCode: "sandbox-runtime-error" });',
    '  });',
    '  window.addEventListener("unhandledrejection", function(){',
    '    post("ghpreview:runtime-error", { errorCode: "sandbox-runtime-error" });',
    '  });',
    '  document.addEventListener("DOMContentLoaded", announceReady);',
    '  window.addEventListener("load", report);',
    '  if (typeof ResizeObserver === "function") {',
    '    new ResizeObserver(report).observe(document.documentElement);',
    '    if (document.body) { new ResizeObserver(report).observe(document.body); }',
    '  }',
    '  // Fonts can change the height after the initial layout.',
    '  if (document.fonts && document.fonts.ready) { document.fonts.ready.then(report); }',
    '  // Recheck after delayed layout work; repeated measurements are harmless.',
    '  [0, 250, 1000].forEach(function(wait){ setTimeout(report, wait); });',
    '})();',
  ].join('\n');

  function addHeightReporter(doc, sessionId) {
    const script = doc.createElement('script');
    script.textContent = HEIGHT_REPORTER.replace(
      '__GHPREVIEW_SESSION_ID__',
      JSON.stringify(typeof sessionId === 'string' ? sessionId : ''),
    ).replace('__GHPREVIEW_PROTOCOL_VERSION__', String(PROTOCOL_VERSION));
    (doc.head || doc.body || doc.documentElement).appendChild(script);
  }

  /*
   * Match the document height without imposing a maximum; the page handles scrolling.
   *
   * Add a small slack value. An exact fit can leave a few pixels of internal scroll space,
   * causing small wheel movements to be consumed by the iframe instead of the page.
   */
  const SLACK_PX = 8;
  let appliedHeight = 0;

  function resizeFrame(height) {
    const frame = document.getElementById(FRAME_ID);
    if (frame === null || !Number.isFinite(height) || height <= 0) {
      return;
    }
    if (
      frame.classList.contains(FRAME_PENDING_CLASS)
    ) {
      return;
    }
    /*
     * Ignore measurements within the slack range. Otherwise a document using `height: 100%`
     * could grow by the slack amount on every measure.
     */
    if (Math.abs(height - appliedHeight) <= SLACK_PX) {
      return;
    }
    appliedHeight = Math.ceil(height) + SLACK_PX;
    frame.style.height = appliedHeight + 'px';
  }

  global.GHPREVIEW.githubDom = {
    SELECTORS,
    isMissingFilePage,
    insertPreviewLink,
    removePreviewLink,
    markPreviewSelected,
    viewSwitchState,
    onLeavePreview,
    ensureStyle,
    mountFrame,
    removeFrame,
    showError,
    removeError,
    hasError,
    showTrustRequired,
    removeTrustRequired,
    hasTrustRequired,
    showRuntimeWarning,
    removeWarning,
    hasWarning,
    hasPreviewLink,
    hasFrame,
    needsReconcile,
    sandboxPolicy,
    getErrorCode,
    setPreviewMetadata,
    reconcileError,
    reconcileTrust,
    resizeFrame,
    prepareDocument,
    warn,
  };
})(typeof window === 'undefined' ? globalThis : window);
