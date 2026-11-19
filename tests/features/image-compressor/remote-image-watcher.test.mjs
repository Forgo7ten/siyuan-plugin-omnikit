import test from 'node:test';
import assert from 'node:assert/strict';
import { addedRemoteCandidates } from '../../../src/features/image-compressor/actions/RemoteImageWatcher.ts';
import { defaultImageFeatureConfig } from '../../../src/features/image-compressor/policy/parseImageConfig.ts';

const rootID = '20260101000000-abcdefg';
const candidate = (url, blockID = '20260101000001-abcdefg', count = 1) => ({
  blockID, count, source: { kind: 'remote', key: `remote:${url}`, raw: url, url, name: 'image.png' },
});
const identity = value => `${value.blockID}\n${value.source.key}`;
const config = () => {
  const value = defaultImageFeatureConfig();
  value.auto.globalEnabled = true;
  return value;
};

test('persisted baseline suppresses existing images and only count increases are candidates', () => {
  const before = candidate('https://images.example/a.png', undefined, 2);
  const after = candidate('https://images.example/a.png', undefined, 2);
  assert.deepEqual(addedRemoteCandidates(new Map([[identity(before), before]]), new Map([[identity(after), after]]), config(), rootID), []);

  const inserted = candidate('https://images.example/a.png', undefined, 3);
  assert.deepEqual(addedRemoteCandidates(new Map([[identity(before), before]]), new Map([[identity(inserted), inserted]]), config(), rootID), [inserted]);
});

test('automatic candidates use only global authorization or the exact page allowlist', () => {
  const item = candidate('https://images.example/a.png');
  const current = new Map([[identity(item), item]]);
  assert.equal(addedRemoteCandidates(new Map(), current, config(), rootID).length, 1);
  const disabled = config(); disabled.auto.globalEnabled = false;
  assert.equal(addedRemoteCandidates(new Map(), current, disabled, rootID).length, 0);
  disabled.auto.pageAllowlist[rootID] = { grantedAt: 1, title: 'authorized' };
  assert.equal(addedRemoteCandidates(new Map(), current, disabled, rootID).length, 1);
  assert.equal(addedRemoteCandidates(new Map(), current, config(), 'invalid').length, 0);

  for (const url of ['http://images.example/a.png', 'https://images.example.evil/a.png', 'https://other.example/a.png']) {
    const candidateItem = candidate(url);
    assert.equal(addedRemoteCandidates(new Map(), new Map([[identity(candidateItem), candidateItem]]), config(), rootID).length, 1);
  }
});

test('watchRemoteImages guards against unauthorized documents and reconciles on allowlist changes', async () => {
  class MockMutationObserver {
    static instances = [];
    constructor(callback) {
      this.callback = callback;
      this.observing = false;
      MockMutationObserver.instances.push(this);
    }
    observe(target, options) {
      this.observing = true;
    }
    disconnect() {
      this.observing = false;
    }
  }

  const prevHTMLElement = globalThis.HTMLElement;
  const prevMutationObserver = globalThis.MutationObserver;
  const prevDocument = globalThis.document;

  class FakeHTMLElement {}
  globalThis.HTMLElement = FakeHTMLElement;
  globalThis.MutationObserver = MockMutationObserver;
  globalThis.document = {
    createElement: () => ({ innerHTML: '', content: { querySelectorAll: () => [] } }),
  };

  try {
    const { watchRemoteImages } = await import('../../../src/features/image-compressor/actions/RemoteImageWatcher.ts');

    let postCalls = 0;
    const currentConfig = defaultImageFeatureConfig();
    currentConfig.auto.globalEnabled = false;

    const kernel = {
      post: async (url, body) => {
        postCalls++;
        return { code: 0, data: { id: body.id, dom: `<div data-node-id="${body.id}"></div>` } };
      },
    };
    const services = {
      config: () => currentConfig,
      kernel,
      origin: 'http://127.0.0.1:6806',
      userAgent: () => 'TestUA',
    };

    const listeners = new Map();
    const editor = Object.assign(new FakeHTMLElement(), {
      addEventListener: (event, fn) => listeners.set(event, fn),
      removeEventListener: (event, fn) => listeners.delete(event),
    });

    const doc = { id: rootID, root_id: rootID, box: 'box-1' };
    const scope = {
      signal: new AbortController().signal,
      active: true,
      own: fn => fn,
    };

    // 1. Initial watch on unauthorized doc: should NOT invoke getBlockDOM or start observing
    const handle = await watchRemoteImages(editor, doc, scope, services);
    assert.equal(postCalls, 0, 'Must not post to kernel when doc is not auto-allowed');
    const observer = MockMutationObserver.instances[MockMutationObserver.instances.length - 1];
    assert.equal(observer?.observing ?? false, false, 'Observer must not be active');

    // 2. Reconcile after enabling global auto: should take snapshot and start observing
    currentConfig.auto.globalEnabled = true;
    await handle.reconcile();
    assert.equal(postCalls, 1, 'Snapshot must query getBlockDOM on authorized reconciliation');
    const activeObserver = MockMutationObserver.instances[MockMutationObserver.instances.length - 1];
    assert.equal(activeObserver.observing, true, 'Observer must be active after authorized reconcile');

    // 3. Reconcile after disabling global auto: should disconnect observer
    currentConfig.auto.globalEnabled = false;
    await handle.reconcile();
    assert.equal(activeObserver.observing, false, 'Observer must disconnect after unauthorized reconcile');

    // 4. Dispose handle: releases listeners
    handle.dispose();
    assert.equal(listeners.has('beforeinput'), false, 'Undo listener must be cleaned up on dispose');
  } finally {
    globalThis.HTMLElement = prevHTMLElement;
    globalThis.MutationObserver = prevMutationObserver;
    globalThis.document = prevDocument;
  }
});

test('ImageCompressorFeature wires active editor and destroy-protyle lifecycle', async () => {
  const { readFile } = await import('node:fs/promises');
  const featureSource = await readFile(new URL('../../../src/features/image-compressor/ImageCompressorFeature.ts', import.meta.url), 'utf8');

  assert.match(featureSource, /getActiveEditor\(\)/, 'Must connect to getActiveEditor()');
  assert.match(featureSource, /"destroy-protyle"/, 'Must listen to destroy-protyle');
  assert.match(featureSource, /entry\.handle\?\.reconcile\(\)/, 'Must reconcile on settings store subscription');
});

test('RemoteImageWatcher removes record capacity throttling and resolves persisted target in a single DOM parse', async () => {
  const { readFile } = await import('node:fs/promises');
  const watcher = await readFile(new URL('../../../src/features/image-compressor/actions/RemoteImageWatcher.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(watcher, /capacityReached|isRecordCapacityError|lastRecordCount|unsubscribeRecords/);
  assert.doesNotMatch(watcher, /resolveImageOccurrence/);
  assert.match(watcher, /const target: OccurrenceTarget = \{/);
});
