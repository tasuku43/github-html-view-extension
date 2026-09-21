/*
 * Render and persist the compact Action Popup settings surface.
 *
 * Every change is saved immediately. The content script and Worker still normalize and
 * enforce the same object, so the Popup is not a security boundary.
 */
(function initPopup(global) {
  'use strict';

  const settingsApi = global.GHPREVIEW.settings;
  const root = document.querySelector('[data-settings-surface]');
  const previewEnabled = document.getElementById('preview-enabled');
  const capabilityInputs = Object.fromEntries(
    settingsApi.CAPABILITIES.map(key => [key, document.getElementById('capability-' + key)]),
  );
  const previewSubtitle = document.getElementById('preview-subtitle');
  const capabilitySummary = document.getElementById('capability-summary');
  const capabilityHelp = document.getElementById('capability-help');
  const repositorySummary = document.getElementById('repository-summary');
  const addButton = document.querySelector('.add-button');
  const repositoryForm = document.getElementById('repository-form');
  const repositoryInput = document.getElementById('repository-input');
  const repositoryError = document.getElementById('repository-error');
  const repositoryList = document.getElementById('repository-list');
  const repositoryTooltip = document.getElementById('repository-tooltip');
  const repositoryEmpty = document.getElementById('repository-empty');
  const footerStatus = document.getElementById('footer-status');
  const activeStatus = document.getElementById('active-status');

  let current = settingsApi.createDefault();
  let saveVersion = 0;
  let tooltipTarget = null;

  function hideRepositoryTooltip(target) {
    if (target && tooltipTarget !== target) {
      return;
    }
    tooltipTarget = null;
    repositoryTooltip.classList.remove('is-visible');
    repositoryTooltip.setAttribute('aria-hidden', 'true');
    repositoryTooltip.hidden = true;
  }

  function showRepositoryTooltip(target) {
    const value = target.dataset.fullName;
    if (!value) {
      return;
    }

    tooltipTarget = target;
    repositoryTooltip.textContent = value;
    repositoryTooltip.hidden = false;
    repositoryTooltip.setAttribute('aria-hidden', 'false');
    repositoryTooltip.style.maxWidth = Math.min(280, window.innerWidth - 24) + 'px';

    const targetRect = target.getBoundingClientRect();
    const tooltipRect = repositoryTooltip.getBoundingClientRect();
    const viewportPadding = 8;
    const left = Math.min(
      Math.max(viewportPadding, targetRect.left),
      Math.max(viewportPadding, window.innerWidth - tooltipRect.width - viewportPadding),
    );
    const aboveTop = targetRect.top - tooltipRect.height - 7;
    const belowTop = targetRect.bottom + 7;
    const top = aboveTop >= viewportPadding
      ? aboveTop
      : Math.min(
          Math.max(viewportPadding, belowTop),
          Math.max(viewportPadding, window.innerHeight - tooltipRect.height - viewportPadding),
        );

    repositoryTooltip.style.left = Math.round(left) + 'px';
    repositoryTooltip.style.top = Math.round(top) + 'px';
    requestAnimationFrame(() => {
      if (tooltipTarget === target) {
        repositoryTooltip.classList.add('is-visible');
      }
    });
  }

  function bindRepositoryName(name) {
    let hovered = false;
    let focused = false;
    const updateTooltip = () => {
      if (hovered || focused) {
        showRepositoryTooltip(name);
      } else {
        hideRepositoryTooltip(name);
      }
    };

    name.addEventListener('mouseenter', () => {
      hovered = true;
      updateTooltip();
    });
    name.addEventListener('mouseleave', () => {
      hovered = false;
      updateTooltip();
    });
    name.addEventListener('focus', () => {
      focused = true;
      updateTooltip();
    });
    name.addEventListener('blur', () => {
      focused = false;
      updateTooltip();
    });
  }

  function setStatus(message, state = 'ready') {
    footerStatus.textContent = message;
    root.dataset.settingsState = state;
  }

  function setRepositoryError(message) {
    repositoryError.textContent = message;
    repositoryInput.setAttribute('aria-invalid', message === '' ? 'false' : 'true');
    addButton.disabled = message !== '';
  }

  function repositoryErrorMessage(error) {
    if (!error || error.valid) {
      return '';
    }
    if (error.code === 'wildcard-not-allowed') {
      return 'Wildcards are not supported. Enter an exact owner/repository value.';
    }
    if (error.code === 'duplicate-repository') {
      return 'That repository is already trusted.';
    }
    return 'Enter a valid owner/repository value, such as owner/repository.';
  }

  function renderRepositories() {
    hideRepositoryTooltip();
    repositoryList.replaceChildren();
    repositorySummary.textContent =
      current.repositories.length +
      (current.repositories.length === 1 ? ' repository' : ' repositories');
    repositoryEmpty.hidden = current.repositories.length > 0;
    current.repositories.forEach(repository => {
      const item = document.createElement('li');
      item.className = 'repository-item';
      item.dataset.repository = repository;

      const dot = document.createElement('span');
      dot.className = 'repo-dot';
      dot.setAttribute('aria-hidden', 'true');

      const name = document.createElement('span');
      name.className = 'repository-name';
      name.dataset.fullName = repository;
      name.tabIndex = 0;
      name.setAttribute('aria-label', 'Full repository name: ' + repository);
      name.setAttribute('aria-describedby', 'repository-tooltip');

      const value = document.createElement('code');
      value.textContent = repository;
      name.append(value);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'button remove-button';
      remove.dataset.removeRepository = repository;
      remove.setAttribute('aria-label', 'Remove ' + repository);
      remove.textContent = 'Remove';

      item.append(dot, name, remove);
      repositoryList.append(item);
      bindRepositoryName(name);
    });
  }

  function render() {
    previewEnabled.checked = current.previewEnabled;
    settingsApi.CAPABILITIES.forEach(key => {
      capabilityInputs[key].checked = current.capabilities[key];
      capabilityInputs[key].disabled = !current.previewEnabled;
    });
    const enabledCapabilities = settingsApi.CAPABILITIES.filter(
      key => current.capabilities[key],
    ).length;
    previewSubtitle.textContent = current.previewEnabled
      ? current.repositories.length > 0
        ? 'Active for trusted repositories'
        : 'Trust a repository from Preview or add one here'
      : 'Preview is currently off';
    capabilitySummary.textContent = !current.previewEnabled
      ? current.repositories.length > 0
        ? 'Ready to configure'
        : 'All off by default'
      : enabledCapabilities > 0
        ? enabledCapabilities + ' enabled'
        : 'Applied globally';
    capabilityHelp.hidden = current.previewEnabled;
    activeStatus.hidden = !(current.previewEnabled && current.repositories.length > 0);
    root.dataset.previewEnabled = String(current.previewEnabled);
    root.dataset.repositoryCount = String(current.repositories.length);
    settingsApi.CAPABILITIES.forEach(key => {
      root.dataset['capability' + key[0].toUpperCase() + key.slice(1)] = String(
        current.capabilities[key],
      );
    });
    renderRepositories();
  }

  function save(next, successMessage = 'Saved') {
    current = settingsApi.normalize(next);
    render();
    const version = ++saveVersion;
    setStatus('Saving…', 'saving');
    chrome.storage.local.set({ [settingsApi.STORAGE_KEY]: current }, () => {
      if (version !== saveVersion) {
        return;
      }
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        setStatus('Could not save changes.', 'error');
        return;
      }
      setStatus(successMessage === 'Saved' ? 'Changes save automatically.' : successMessage, 'saved');
    });
  }

  function load() {
    chrome.storage.local.get(settingsApi.STORAGE_KEY, stored => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) {
        setStatus('Could not load settings.', 'error');
        return;
      }
      current = settingsApi.normalize(stored[settingsApi.STORAGE_KEY]);
      render();
      setStatus('Changes save automatically.', 'ready');
    });
  }

  previewEnabled.addEventListener('change', () => {
    current.previewEnabled = previewEnabled.checked;
    save(current);
  });

  settingsApi.CAPABILITIES.forEach(key => {
    capabilityInputs[key].addEventListener('change', () => {
      current.capabilities[key] = capabilityInputs[key].checked;
      save(current);
    });
  });

  repositoryForm.addEventListener('submit', event => {
    event.preventDefault();
    const result = settingsApi.addRepository(current, repositoryInput.value);
    if (result.error) {
      setRepositoryError(repositoryErrorMessage(result.error));
      setStatus('Fix the repository name to add it.', 'error');
      repositoryInput.focus();
      return;
    }
    setRepositoryError('');
    repositoryInput.value = '';
    save(result.settings, 'Saved');
  });

  repositoryInput.addEventListener('input', () => {
    const value = repositoryInput.value.trim();
    if (value === '') {
      setRepositoryError('');
      return;
    }
    setRepositoryError(repositoryErrorMessage(settingsApi.validateRepository(value)));
  });

  repositoryList.addEventListener('click', event => {
    const button = event.target.closest('[data-remove-repository]');
    if (!button) {
      return;
    }
    const repository = button.dataset.removeRepository;
    current = settingsApi.removeRepository(current, repository);
    save(current, 'Saved');
  });

  repositoryList.addEventListener('scroll', () => hideRepositoryTooltip(), { passive: true });

  load();
})(window);
