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

test('watchRemoteImages processes >20 added remote images across consecutive batches with desktop concurrency 3', async () => {
  class MockMutationObserver {
    constructor(callback) {
      this.callback = callback;
    }
    observe() {}
    disconnect() {}
  }

  const prevHTMLElement = globalThis.HTMLElement;
  const prevMutationObserver = globalThis.MutationObserver;
  const prevDocument = globalThis.document;
  const prevDOMParser = globalThis.DOMParser;

  class FakeHTMLElement {}
  globalThis.HTMLElement = FakeHTMLElement;
  globalThis.MutationObserver = MockMutationObserver;

  const totalImages = 22;
  let docImgs = ['<div data-node-id="20260101000001-init">initial</div>'];
  const imgObj = (blockID, src) => ({
    tagName: 'IMG',
    closest: selector => selector === '[data-node-id]' ? { getAttribute: () => blockID } : null,
    hasAttribute: name => name === 'src',
    getAttribute: name => name === 'src' ? src : null,
  });

  globalThis.document = {
    createElement: () => ({
      _html: '',
      set innerHTML(val) { this._html = val; },
      get content() {
        const matches = [...this._html.matchAll(/data-node-id="([^"]+)"[^>]*><img src="([^"]+)"/g)];
        const imgs = matches.map(m => imgObj(m[1], m[2]));
        const children = matches.map(m => ({
          getAttribute: name => name === 'data-node-id' ? m[1] : null,
          querySelector: () => null,
          querySelectorAll: selector => selector.includes('img') ? [imgObj(m[1], m[2])] : [],
        }));
        return {
          children,
          querySelectorAll: selector => selector.includes('img') ? imgs : [],
        };
      },
    }),
  };

  try {
    const { watchRemoteImages } = await import('../../../src/features/image-compressor/actions/RemoteImageWatcher.ts');
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
    const currentConfig = config();
    let activeReads = 0;
    let peakReads = 0;
    let compressedCount = 0;
    const blockSrc = new Map();

    const services = {
      config: () => currentConfig,
      origin: 'http://127.0.0.1:6806',
      mobile: false,
      userAgent: () => 'TestUA',
      kernel: {
        post: async (_path, body) => {
          if (body.id === rootID) {
            return { code: 0, data: { id: rootID, dom: docImgs.join('') } };
          }
          const idx = Number(body.id.slice(0, 2));
          const src = blockSrc.get(body.id) ?? `https://cdn.example/img-${idx}.png`;
          return { code: 0, data: { id: body.id, dom: `<div data-node-id="${body.id}"><img src="${src}" /></div>` } };
        },
      },
      reader: {
        read: async source => {
          activeReads += 1;
          peakReads = Math.max(peakReads, activeReads);
          await new Promise(resolve => setTimeout(resolve, 10));
          activeReads -= 1;
          return { blob: new Blob([pngBytes], { type: 'image/png' }), name: `${source.raw.split('/').pop()}` };
        },
      },
      assets: {
        upload: async file => `assets/local-${file.name.match(/\d+/)?.[0]}.png`,
      },
      references: {
        commitOccurrence: async (target, nextPath) => {
          blockSrc.set(target.blockID, nextPath);
          return 'replaced';
        },
      },
      compressOccurrence: async () => {
        compressedCount += 1;
        return { status: 'saved', path: 'assets/comp.webp', reference: 'replaced', originalBytes: 100, compressedBytes: 40 };
      },
    };

    const editor = Object.assign(new FakeHTMLElement(), {
      addEventListener() {},
      removeEventListener() {},
    });
    const doc = { id: rootID, root_id: rootID, box: 'box-1' };
    const scope = { signal: new AbortController().signal, active: true, own: fn => fn };

    const handle = await watchRemoteImages(editor, doc, scope, services, { warn() {} });
    docImgs = Array.from({ length: totalImages }, (_, i) => {
      const blk = `${String(i).padStart(2, '0')}260101000001-blk`;
      return `<div data-node-id="${blk}"><img src="https://cdn.example/img-${i}.png" /></div>`;
    });

    await handle.reconcile();
    await new Promise(resolve => setTimeout(resolve, 650));
    handle.dispose();

    assert.equal(compressedCount, totalImages);
    assert.ok(peakReads > 1 && peakReads <= 3, `expected peak concurrency in (1, 3], got ${peakReads}`);
  } finally {
    globalThis.HTMLElement = prevHTMLElement;
    globalThis.MutationObserver = prevMutationObserver;
    globalThis.document = prevDocument;
    globalThis.DOMParser = prevDOMParser;
  }
});
