import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadScript } from './helpers/load.mjs';

const window = {};
loadScript('view-coordinator.js', { window });
const { viewCoordinator } = window.GHPREVIEW;

test('keeps Preview intent separate from the native carrier view', () => {
  const coordinator = viewCoordinator.create(viewCoordinator.VIEWS.BLAME);

  const started = coordinator.begin(viewCoordinator.VIEWS.PREVIEW, viewCoordinator.VIEWS.BLAME);
  assert.equal(started.phase, 'intent');
  assert.equal(started.desiredView, 'preview');
  assert.equal(started.presentedView, 'blame');

  coordinator.beginHostNavigation();
  const observed = coordinator.observeHost({
    view: viewCoordinator.VIEWS.CODE,
    ready: true,
    signature: 'code|blame::code',
  });

  assert.equal(observed.phase, 'handoff');
  assert.equal(observed.desiredView, 'preview');
  assert.equal(observed.hostView, 'code');
});

test('commits the Preview presentation without changing the host route contract', () => {
  const coordinator = viewCoordinator.create(viewCoordinator.VIEWS.BLAME);
  coordinator.begin(viewCoordinator.VIEWS.PREVIEW, viewCoordinator.VIEWS.BLAME);
  coordinator.beginHostNavigation();
  coordinator.observeHost({ view: viewCoordinator.VIEWS.CODE, ready: true, signature: 'new' });

  const committed = coordinator.commitPresented(viewCoordinator.VIEWS.PREVIEW);
  assert.equal(committed.phase, 'settled');
  assert.equal(committed.presentedView, 'preview');
  assert.equal(committed.hostView, 'code');
  assert.equal(committed.desiredView, 'preview');
});

test('settles a native Code or Blame transition only after the host agrees', () => {
  const coordinator = viewCoordinator.create(viewCoordinator.VIEWS.PREVIEW);
  coordinator.begin(viewCoordinator.VIEWS.BLAME, viewCoordinator.VIEWS.PREVIEW);
  coordinator.beginHostNavigation();

  const waiting = coordinator.observeHost({
    view: viewCoordinator.VIEWS.CODE,
    ready: true,
    signature: 'code|blame::code',
  });
  assert.equal(waiting.phase, 'host-navigation');

  const settled = coordinator.observeHost({
    view: viewCoordinator.VIEWS.BLAME,
    ready: true,
    signature: 'code|blame::blame',
  });
  assert.equal(settled.phase, 'settled');
  assert.equal(settled.hostView, 'blame');
});

test('finish releases the transition lock while preserving the presented view', () => {
  const coordinator = viewCoordinator.create(viewCoordinator.VIEWS.BLAME);
  coordinator.begin(viewCoordinator.VIEWS.PREVIEW, viewCoordinator.VIEWS.BLAME);
  coordinator.commitPresented(viewCoordinator.VIEWS.PREVIEW);

  const finished = coordinator.finish();
  assert.equal(finished.phase, 'stable');
  assert.equal(finished.desiredView, 'preview');
  assert.equal(finished.presentedView, 'preview');
  assert.equal(finished.transactionId, null);
  assert.equal(coordinator.isLocked(), false);
});
