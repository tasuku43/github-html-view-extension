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

  const { inline } = global.GHPREVIEW;

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
    viewSwitchSpare: 'li[data-component="SegmentedControl.Button"]:not([data-selected])',
    // File header toolbar. It defines the boundary for hiding file content and is the
    // fallback insertion point when the view switch is unavailable.
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
    console.warn('[ghpreview] ' + message);
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
  // cloned item in the view switch and to the link itself in the toolbar fallback.
  const LINK_MARK = 'data-ghpreview-link';
  const LINK_SELECTOR = '[' + LINK_MARK + ']';
  const FRAME_ID = 'ghpreview-frame';
  const ERROR_ID = 'ghpreview-error';
  const FRAME_PENDING_CLASS = 'ghpreview-frame-pending';
  const FRAME_OVERLAY_CLASS = 'ghpreview-frame-overlay';
  const STYLE_ID = 'ghpreview-style';
  const PREVIEW_TOP_GAP_PX = 32;
  let activeErrorCode = null;

  /**
   * Add Preview at the start of the Code / Blame switch.
   *
   * Follow the shape GitHub uses for `.md` files. Do not create a separate panel or
   * toolbar (GOAL.md).
   */
  function insertPreviewLink(handlers) {
    if (document.querySelector(LINK_SELECTOR) !== null) {
      return true;
    }

    const viewSwitch = findFirst(SELECTORS.viewSwitch);
    if (viewSwitch !== null) {
      return insertIntoViewSwitch(viewSwitch, handlers);
    }

    const anchorPoint = findFirst(SELECTORS.toolbar);
    if (anchorPoint === null) {
      warn('toolbar', 'The file toolbar was not found; Preview cannot be inserted');
      return false;
    }
    return insertBeside(anchorPoint, handlers);
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
    const spare =
      viewSwitch.querySelector(SELECTORS.viewSwitchSpare) ||
      viewSwitch.querySelector(SELECTORS.viewSwitchItem);
    if (spare === null) {
      warn('view-switch', 'The view switch has no items; falling back beside Raw');
      const anchorPoint = findFirst(SELECTORS.toolbar);
      return anchorPoint === null ? false : insertBeside(anchorPoint, handlers);
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
      warn('view-switch', 'The view switch has no clickable control; falling back beside Raw');
      const anchorPoint = findFirst(SELECTORS.toolbar);
      return anchorPoint === null ? false : insertBeside(anchorPoint, handlers);
    }

    setLabel(clone, control, 'Preview');
    control.addEventListener('click', event => {
      event.preventDefault();
      handlers.onPreview();
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

  /**
   * Reflect the current selection in the view switch.
   *
   * Preview is a peer option; omitting this would make it look unselected after a click.
   */
  function markPreviewSelected(isPreview) {
    const ours = document.querySelector(LINK_SELECTOR);
    if (ours === null || !ours.matches(SELECTORS.viewSwitchItem)) {
      return;
    }
    const viewSwitch = ours.parentElement;
    // GitHub may have inserted the new view with its native selection before the
    // controller runs. Capture that selection before changing any item; otherwise the
    // first reconciliation records the marker but leaves every item visually unselected.
    const nativeSelected = new Set(
      Array.from(viewSwitch.children).filter(
        item =>
          item.hasAttribute('data-selected') ||
          item.getAttribute('aria-selected') === 'true' ||
          item.querySelector('a, button')?.getAttribute('aria-pressed') === 'true',
      ),
    );
    nativeSelected.forEach(item => {
      if (!item.hasAttribute(LINK_MARK)) {
        item.setAttribute(ORIGINAL_MARK, '');
      }
    });
    Array.from(viewSwitch.children).forEach(item => {
      const selected =
        item === ours ? isPreview : !isPreview && (wasSelected(item) || nativeSelected.has(item));
      setSelected(item, selected);
    });
  }

  /*
   * Remember the originally selected item. It must be restored when leaving Preview, so
   * the original selection cannot be lost.
   */
  const ORIGINAL_MARK = 'data-ghpreview-was-selected';

  function wasSelected(item) {
    return item.hasAttribute(ORIGINAL_MARK);
  }

  function setSelected(item, selected) {
    if (item.hasAttribute('data-selected') && !item.hasAttribute(LINK_MARK)) {
      item.setAttribute(ORIGINAL_MARK, '');
    }
    if (selected) {
      item.setAttribute('data-selected', '');
    } else {
      item.removeAttribute('data-selected');
    }
    const control = item.querySelector('a, button');
    if (control !== null && control.hasAttribute('aria-pressed')) {
      control.setAttribute('aria-pressed', selected ? 'true' : 'false');
    }
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

  /** Fallback insertion point beside Raw when the view switch is unavailable. */
  function insertBeside(anchorPoint, handlers) {
    const link = document.createElement('a');
    link.setAttribute(LINK_MARK, '');
    link.className = 'ghpreview-link';
    link.href = '#';
    link.textContent = 'Preview';
    link.addEventListener('click', event => {
      event.preventDefault();
      handlers.onPreview();
    });

    const holder = anchorPoint.closest('div') || anchorPoint.parentElement;
    holder.parentElement.insertBefore(link, holder.nextSibling);
    return true;
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
        frame.classList.contains(FRAME_PENDING_CLASS) ||
        frame.classList.contains(FRAME_OVERLAY_CLASS);
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

  function hasError() {
    return document.getElementById(ERROR_ID) !== null;
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
      (frame.classList.contains(FRAME_PENDING_CLASS) || frame.classList.contains(FRAME_OVERLAY_CLASS))
    ) {
      return true;
    }
    const error = document.getElementById(ERROR_ID);
    return error !== null && error.classList.contains('ghpreview-error-overlay');
  }

  function getErrorCode() {
    const region = document.getElementById(ERROR_ID);
    return region?.getAttribute('data-preview-error-code') || activeErrorCode;
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
    // controls repository scripts separately in inlineDocument; it must not disable the
    // bootstrap that enforces the opaque-origin message boundary.
    const tokens = ['allow-scripts'];
    if (capabilities.forms === true) {
      tokens.push('allow-forms');
    }
    if (capabilities.popups === true) {
      tokens.push('allow-popups');
    }
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
      frame.classList.remove('ghpreview-frame-inline', FRAME_OVERLAY_CLASS);
      frame.classList.add(FRAME_PENDING_CLASS);
      frame.setAttribute('aria-hidden', 'true');
      return false;
    }

    const body = expandToFileBody(container);
    if (body.parentElement === null) {
      return false;
    }

    frame.classList.remove(FRAME_PENDING_CLASS, FRAME_OVERLAY_CLASS);
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
    // Set the known bundled entry point before insertion, matching the baseline startup
    // path. The callback lets the parent subscribe before the browsing context starts.
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
    if (hiddenContainer !== null) {
      hiddenContainer.style.display = '';
      hiddenContainer = null;
    }
    // The next document may have a similar height. Reset the previous value so the first
    // measurement is not suppressed by the change guard.
    appliedHeight = 0;
  }

  /**
   * Fold fetched HTML into one document without relative resource references.
   *
   * DOMParser avoids differences in attribute quoting, casing, and line breaks. String
   * replacement would eventually miss a form. This document is detached, so nothing runs
   * during parsing.
   *
   * @param load returns {text, dataUri} for a URL, or null when it cannot be loaded
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

  async function inlineDocument(htmlText, base, load, sessionId = '', capabilities = {}) {
    const doc = new DOMParser().parseFromString(htmlText, 'text/html');
    const notes = [];

    applyCapabilities(doc, capabilities);

    // A remaining <base> could redirect an unresolved reference unexpectedly.
    doc.querySelectorAll('base').forEach(element => element.remove());

    for (const rule of inline.RULES) {
      const elements = Array.from(doc.querySelectorAll(rule.select));
      for (const element of elements) {
        await applyRule(element, rule, base, load, notes);
      }
    }

    // Rewrite url() values in inline <style> elements too.
    const styles = Array.from(doc.querySelectorAll('style'));
    for (const style of styles) {
      const rewritten = await inline.rewriteCssUrls(style.textContent, base, url =>
        load(url).then(got => (got === null ? null : got.dataUri)),
      );
      style.textContent = rewritten.text;
      notes.push(...rewritten.notes);
    }

    addHeightReporter(doc, sessionId);

    return { html: '<!doctype html>\n' + doc.documentElement.outerHTML, notes };
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
    '    parent.postMessage(Object.assign({ type: type, sessionId: sessionId }, payload || {}), "https://github.com");',
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
    );
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
      frame.classList.contains(FRAME_PENDING_CLASS) ||
      frame.classList.contains(FRAME_OVERLAY_CLASS)
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

  async function applyRule(element, rule, base, load, notes) {
    const value = element.getAttribute(rule.attribute);

    if (rule.as === 'srcset') {
      const rewritten = await inline.rewriteSrcset(value, base, url =>
        load(url).then(got => (got === null ? null : got.dataUri)),
      );
      element.setAttribute(rule.attribute, rewritten.value);
      notes.push(...rewritten.notes);
      return;
    }

    const decided = inline.classify(value, base);
    if (decided.kind === 'unsupported') {
      notes.push(decided.reason);
      return;
    }
    if (decided.kind !== 'inline') {
      return;
    }

    const got = await load(decided.url);
    if (got === null) {
      notes.push('Could not load reference: ' + value);
      return;
    }

    if (rule.as === 'css') {
      const rewritten = await inline.rewriteCssUrls(got.text, decided.url, url =>
        load(url).then(inner => (inner === null ? null : inner.dataUri)),
      );
      notes.push(...rewritten.notes);
      const style = element.ownerDocument.createElement('style');
      style.textContent = rewritten.text;
      element.replaceWith(style);
      return;
    }

    if (rule.as === 'js') {
      const script = element.ownerDocument.createElement('script');
      // Preserve execution attributes such as type and defer, but remove src.
      Array.from(element.attributes).forEach(attribute => {
        if (attribute.name !== 'src') {
          script.setAttribute(attribute.name, attribute.value);
        }
      });
      script.textContent = inline.escapeScriptText(got.text);
      element.replaceWith(script);
      return;
    }

    element.setAttribute(rule.attribute, got.dataUri);
  }

  global.GHPREVIEW.githubDom = {
    SELECTORS,
    isMissingFilePage,
    insertPreviewLink,
    removePreviewLink,
    markPreviewSelected,
    onLeavePreview,
    ensureStyle,
    mountFrame,
    removeFrame,
    showError,
    removeError,
    hasError,
    hasPreviewLink,
    hasFrame,
    needsReconcile,
    getErrorCode,
    setPreviewMetadata,
    reconcileError,
    resizeFrame,
    inlineDocument,
    warn,
  };
})(typeof window === 'undefined' ? globalThis : window);
