(function () {
  'use strict';

  const status = document.querySelector('#fixture-status');
  const note = document.querySelector('#fixture-script-note');
  document.documentElement.dataset.repositoryScript = 'executed';
  if (status) {
    status.textContent = 'Fixture ready · script executed';
  }
  if (note) {
    note.textContent = 'The repository classic script ran inside the isolated Preview sandbox.';
  }
})();
