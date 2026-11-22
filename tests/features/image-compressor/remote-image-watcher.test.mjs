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
  disabled.auto.pageAllowlist[rootID] = { grantedAt: 1 };
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

test('ImageCompressorFeature wires all editors, deduplicates same-doc reattach, and destroy-protyle lifecycle', async () => {
  const { readFile } = await import('node:fs/promises');
  const featureSource = await readFile(new URL('../../../src/features/image-compressor/ImageCompressorFeature.ts', import.meta.url), 'utf8');

  assert.match(featureSource, /listEditorsSafe\(getAllEditor/, 'Must safely enumerate editors via listEditorsSafe(getAllEditor, ...)');
  assert.match(featureSource, /"destroy-protyle"/, 'Must listen to destroy-protyle');
  assert.match(featureSource, /entry\.handle\?\.reconcile\(\)/, 'Must reconcile on settings store subscription');
  assert.match(featureSource, /prior && prior\.rootID === rootID && prior\.notebook === notebook/);
  assert.match(featureSource, /initAbort:\s*new AbortController\(\)/);
});

test('RemoteImageWatcher removes record capacity throttling and resolves persisted target in a single DOM parse', async () => {
  const { readFile } = await import('node:fs/promises');
  const watcher = await readFile(new URL('../../../src/features/image-compressor/actions/RemoteImageWatcher.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(watcher, /capacityReached|isRecordCapacityError|lastRecordCount|unsubscribeRecords/);
  assert.doesNotMatch(watcher, /resolveImageOccurrence/);
  assert.match(watcher, /const target: OccurrenceTarget = \{/);
});

test('watchRemoteImages processes >20 added remote images across consecutive batches with desktop concurrency 3', async () => {
  const observers = [];
  class MockMutationObserver {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe() {}
    disconnect() {}
  }

  const prevHTMLElement = globalThis.HTMLElement;
  const prevElement = globalThis.Element;
  const prevMutationObserver = globalThis.MutationObserver;
  const prevDocument = globalThis.document;
  const prevDOMParser = globalThis.DOMParser;

  class FakeElement {}
  class FakeHTMLElement extends FakeElement {}
  globalThis.Element = FakeElement;
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
      recordsReady: Promise.resolve(),
      records: {
        upsert: async () => {},
        markOperation: async () => {},
      },
      ui: { copyablePath() {} },
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
      closest: () => null,
    });
    const doc = { id: rootID, root_id: rootID, box: 'box-1' };
    const scope = { signal: new AbortController().signal, active: true, own: fn => fn };

    const handle = await watchRemoteImages(editor, doc, scope, services, { warn() {} });
    docImgs = Array.from({ length: totalImages }, (_, i) => {
      const blk = `${String(i).padStart(2, '0')}260101000001-blk`;
      return `<div data-node-id="${blk}"><img src="https://cdn.example/img-${i}.png" /></div>`;
    });

    const addedImg = Object.assign(new FakeHTMLElement(), {
      matches: selector => selector === 'img',
      closest: () => null,
      querySelectorAll: () => [],
    });
    observers.at(-1).callback([{ type: 'childList', target: editor, addedNodes: [addedImg], removedNodes: [] }]);
    await new Promise(resolve => setTimeout(resolve, 950));
    handle.dispose();

    assert.equal(compressedCount, totalImages);
    assert.ok(peakReads > 1 && peakReads <= 3, `expected peak concurrency in (1, 3], got ${peakReads}`);
  } finally {
    globalThis.HTMLElement = prevHTMLElement;
    globalThis.Element = prevElement;
    globalThis.MutationObserver = prevMutationObserver;
    globalThis.document = prevDocument;
    globalThis.DOMParser = prevDOMParser;
  }
});

test('RemoteImageWatcher ignores unrelated config reconcile when observing, aborts in-flight reads on revoke/dispose/initSignal, and suppresses warn on aborted reference', async () => {
  const observers = [];
  class MockMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.observing = false;
      observers.push(this);
    }
    observe() { this.observing = true; }
    disconnect() { this.observing = false; }
  }

  const prevHTMLElement = globalThis.HTMLElement;
  const prevElement = globalThis.Element;
  const prevMutationObserver = globalThis.MutationObserver;
  const prevDocument = globalThis.document;

  class FakeElement {}
  class FakeHTMLElement extends FakeElement {}
  globalThis.Element = FakeElement;
  globalThis.HTMLElement = FakeHTMLElement;
  globalThis.MutationObserver = MockMutationObserver;

  const makeImgNode = (blockID, src) => ({
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
        const imgs = matches.map(m => makeImgNode(m[1], m[2]));
        const children = matches.map(m => ({
          getAttribute: name => name === 'data-node-id' ? m[1] : null,
          querySelector: () => null,
          querySelectorAll: selector => selector.includes('img') ? [makeImgNode(m[1], m[2])] : [],
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
    const editor = Object.assign(new FakeHTMLElement(), {
      addEventListener() {},
      removeEventListener() {},
      closest: () => null,
    });
    const doc = { id: rootID, root_id: rootID, box: 'box-1' };

    // 1. Unrelated config change while observing must NOT trigger sweep / getBlockDOM
    {
      const currentConfig = config();
      let docReads = 0;
      const scope = { signal: new AbortController().signal, active: true, own: fn => fn };
      const services = {
        config: () => currentConfig,
        origin: 'http://127.0.0.1:6806',
        userAgent: () => 'TestUA',
        kernel: {
          post: async (_path, body) => {
            if (body.id === rootID) docReads += 1;
            return { code: 0, data: { id: body.id, dom: `<div data-node-id="${body.id}"></div>` } };
          },
        },
      };
      const handle = await watchRemoteImages(editor, doc, scope, services, { warn() {} });
      assert.equal(docReads, 1);

      currentConfig.compression.initialQuality = 0.7;
      await handle.reconcile();
      await new Promise(resolve => setTimeout(resolve, 260));
      assert.equal(docReads, 1, 'unrelated config change must not trigger extra getBlockDOM sweep');
      handle.dispose();
    }

    // 2. Revoking permission while baseline read is in flight aborts the read signal immediately
    {
      const currentConfig = config();
      currentConfig.auto.globalEnabled = false;
      const scope = { signal: new AbortController().signal, active: true, own: fn => fn };
      let capturedSignal;
      let releaseRead;
      const services = {
        config: () => currentConfig,
        origin: 'http://127.0.0.1:6806',
        userAgent: () => 'TestUA',
        kernel: {
          post: (_path, _body, opts) => {
            capturedSignal = opts?.signal;
            return new Promise((resolve, reject) => {
              releaseRead = () => resolve({ code: 0, data: { id: rootID, dom: `<div data-node-id="${rootID}"></div>` } });
              opts?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
            });
          },
        },
      };
      const handle = await watchRemoteImages(editor, doc, scope, services, { warn() {} });
      currentConfig.auto.globalEnabled = true;
      const reconcilePromise = handle.reconcile();
      assert.ok(capturedSignal, 'baseline read should be in flight');
      assert.equal(capturedSignal.aborted, false);

      // Revoke permission before baseline read completes
      currentConfig.auto.globalEnabled = false;
      await handle.reconcile();
      await reconcilePromise;
      assert.equal(capturedSignal.aborted, true, 'revoking permission must abort in-flight baseline read');
      assert.equal(observers.at(-1).observing, false);
      releaseRead?.();
      handle.dispose();
    }

    // 3. initSignal abort cancels initial watchRemoteImages read and returns inert handle
    {
      const currentConfig = config();
      const scope = { signal: new AbortController().signal, active: true, own: fn => fn };
      const initAbort = new AbortController();
      let capturedSignal;
      const services = {
        config: () => currentConfig,
        origin: 'http://127.0.0.1:6806',
        userAgent: () => 'TestUA',
        kernel: {
          post: (_path, _body, opts) => {
            capturedSignal = opts?.signal;
            return new Promise((_resolve, reject) => {
              opts?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
            });
          },
        },
      };
      const pending = watchRemoteImages(editor, doc, scope, services, { warn() {} }, initAbort.signal);
      assert.ok(capturedSignal);
      initAbort.abort();
      const handle = await pending;
      assert.equal(capturedSignal.aborted, true);
      assert.equal(observers.at(-1).observing, false);
      handle.dispose();
    }

    // 4. Reference result "aborted" during remote image compression must not emit a warning
    {
      const currentConfig = config();
      const scope = { signal: new AbortController().signal, active: true, own: fn => fn };
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
      const warnings = [];
      let docDom = `<div data-node-id="${rootID}"></div>`;
      const blk = '20260101000009-blk';
      let blockSrc = 'https://cdn.example/abort-case.png';
      const services = {
        config: () => currentConfig,
        origin: 'http://127.0.0.1:6806',
        mobile: false,
        userAgent: () => 'TestUA',
        kernel: {
          post: async (_path, body) => {
            if (body.id === rootID) return { code: 0, data: { id: rootID, dom: docDom } };
            return { code: 0, data: { id: blk, dom: `<div data-node-id="${blk}"><img src="${blockSrc}" /></div>` } };
          },
        },
        reader: {
          read: async () => ({ blob: new Blob([pngBytes], { type: 'image/png' }), name: 'abort-case.png' }),
        },
        assets: {
          upload: async () => 'assets/local-abort.png',
        },
        recordsReady: Promise.resolve(),
        records: {
          upsert: async () => {},
          markOperation: async () => {},
        },
        ui: { copyablePath() {} },
        references: {
          commitOccurrence: async (_target, nextPath) => {
            blockSrc = nextPath;
            return 'replaced';
          },
        },
        compressOccurrence: async () => ({ status: 'saved', path: 'assets/comp-abort.webp', reference: 'aborted' }),
      };

      const handle = await watchRemoteImages(editor, doc, scope, services, { warn: (...args) => warnings.push(args) });
      docDom = `<div data-node-id="${blk}"><img src="https://cdn.example/abort-case.png" /></div>`;
      const addedImg = Object.assign(new FakeHTMLElement(), {
        matches: selector => selector === 'img',
        closest: () => null,
        querySelectorAll: () => [],
      });
      observers.at(-1).callback([{ type: 'childList', target: editor, addedNodes: [addedImg], removedNodes: [] }]);
      await new Promise(resolve => setTimeout(resolve, 600));
      handle.dispose();
      assert.deepEqual(warnings, [], 'aborted compression reference must not log warn');
    }

    // 5. Stray resume() (e.g. sync-fail without prior sync-start) when not paused must be a no-op
    {
      const currentConfig = config();
      let docReads = 0;
      const scope = { signal: new AbortController().signal, active: true, own: fn => fn };
      const services = {
        config: () => currentConfig,
        origin: 'http://127.0.0.1:6806',
        mobile: false,
        userAgent: () => 'TestUA',
        kernel: {
          post: async () => {
            docReads += 1;
            return { code: 0, data: { id: rootID, dom: `<div data-node-id="${rootID}"></div>` } };
          },
        },
        reader: { read: async () => { throw new Error('unexpected'); } },
        assets: { upload: async () => 'assets/unused.png' },
        recordsReady: Promise.resolve(),
        records: { upsert: async () => {}, markOperation: async () => {} },
        ui: { copyablePath() {} },
        references: { commitOccurrence: async () => 'replaced' },
        compressOccurrence: async () => ({ status: 'skipped', reason: 'no-benefit' }),
      };

      const handle = await watchRemoteImages(editor, doc, scope, services, { warn() {} });
      assert.equal(docReads, 1);
      handle.resume();
      await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(docReads, 1, 'resume() while not paused must not trigger baseline rebuild');
      handle.dispose();
    }

    // 6. Auto remote image compression reports single-image notice (with sizes) and multi-image summary via onNotice
    {
      const currentConfig = config();
      const scope = { signal: new AbortController().signal, active: true, own: fn => fn };
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
      const notices = [];
      let docDom = `<div data-node-id="${rootID}"></div>`;
      const blkA = '20260101000010-blk';
      const blkB = '20260101000011-blk';
      const blockSrcs = new Map([
        [blkA, 'https://cdn.example/remote-one.png'],
        [blkB, 'https://cdn.example/remote-two.png'],
      ]);
      const services = {
        config: () => currentConfig,
        origin: 'http://127.0.0.1:6806',
        mobile: false,
        userAgent: () => 'TestUA',
        kernel: {
          post: async (_path, body) => {
            if (body.id === rootID) return { code: 0, data: { id: rootID, dom: docDom } };
            return { code: 0, data: { id: body.id, dom: `<div data-node-id="${body.id}"><img src="${blockSrcs.get(body.id)}" /></div>` } };
          },
        },
        reader: {
          read: async () => ({ blob: new Blob([pngBytes], { type: 'image/png' }), name: 'remote.png' }),
        },
        assets: {
          upload: async () => 'assets/local-remote.png',
        },
        recordsReady: Promise.resolve(),
        records: {
          upsert: async () => {},
          markOperation: async () => {},
        },
        ui: { copyablePath() {} },
        references: {
          commitOccurrence: async (target, nextPath) => {
            blockSrcs.set(target.blockID, nextPath);
            return 'replaced';
          },
        },
        compressOccurrence: async () => ({
          status: 'saved',
          path: 'assets/comp-remote.webp',
          reference: 'replaced',
          originalBytes: 2048,
          compressedBytes: 512,
        }),
      };

      const handle = await watchRemoteImages(editor, doc, scope, services, { warn() {} }, undefined, n => notices.push(n));
      const addedImg = Object.assign(new FakeHTMLElement(), {
        matches: selector => selector === 'img',
        closest: () => null,
        querySelectorAll: () => [],
      });

      // Single remote image -> detailed single-image AutoUploadNotice
      docDom = `<div data-node-id="${blkA}"><img src="https://cdn.example/remote-one.png" /></div>`;
      observers.at(-1).callback([{ type: 'childList', target: editor, addedNodes: [addedImg], removedNodes: [] }]);
      await new Promise(resolve => setTimeout(resolve, 600));
      assert.equal(notices.length, 1);
      assert.deepEqual(notices[0], {
        total: 1,
        successful: 1,
        skipped: 0,
        failed: 0,
        singleReason: 'success',
        originalBytes: 2048,
        compressedBytes: 512,
      });

      // Multi remote images in one sweep -> summary notice without singleReason
      blockSrcs.set(blkA, 'https://cdn.example/remote-m1.png');
      blockSrcs.set(blkB, 'https://cdn.example/remote-m2.png');
      docDom = `<div data-node-id="${blkA}"><img src="https://cdn.example/remote-m1.png" /></div><div data-node-id="${blkB}"><img src="https://cdn.example/remote-m2.png" /></div>`;
      observers.at(-1).callback([{ type: 'childList', target: editor, addedNodes: [addedImg], removedNodes: [] }]);
      await new Promise(resolve => setTimeout(resolve, 600));
      assert.equal(notices.length, 2);
      assert.equal(notices[1].total, 2);
      assert.equal(notices[1].successful, 2);
      assert.equal(notices[1].singleReason, undefined);
      handle.dispose();
    }

    // 7. Remote localization persists url->localPath record before commitOccurrence and updates status; persistence failure blocks commit
    {
      const currentConfig = config();
      const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
      const blk = '20260101000012-blk';
      const remoteUrl = 'https://cdn.example/persist-test.png';
      let currentSrc = remoteUrl;
      let docDom = `<div data-node-id="${rootID}"></div>`;
      const callOrder = [];
      const copyPrompts = [];
      let failUpsert = false;

      const scope = { signal: new AbortController().signal, active: true, own: fn => fn };
      const services = {
        config: () => currentConfig,
        origin: 'http://127.0.0.1:6806',
        mobile: false,
        userAgent: () => 'TestUA',
        kernel: {
          post: async (_path, body) => {
            if (body.id === rootID) return { code: 0, data: { id: rootID, dom: docDom } };
            return { code: 0, data: { id: blk, dom: `<div data-node-id="${blk}"><img src="${currentSrc}" /></div>` } };
          },
        },
        reader: {
          read: async () => ({ blob: new Blob([pngBytes], { type: 'image/png' }), name: 'persist-test.png' }),
        },
        assets: {
          upload: async () => {
            callOrder.push('upload');
            return 'assets/local-persist.png';
          },
        },
        recordsReady: Promise.resolve(),
        records: {
          upsert: async (orig, comp) => {
            callOrder.push(`upsert:${orig}->${comp}`);
            if (failUpsert) throw new Error('disk full');
          },
          markOperation: async (orig, comp, status) => {
            callOrder.push(`mark:${orig}->${comp}:${status}`);
          },
        },
        ui: {
          copyablePath: p => copyPrompts.push(p),
        },
        references: {
          commitOccurrence: async (_target, nextPath) => {
            callOrder.push(`commit:${nextPath}`);
            currentSrc = nextPath;
            return 'replaced';
          },
        },
        compressOccurrence: async () => {
          callOrder.push('compressOccurrence');
          return { status: 'skipped' };
        },
      };

      const handle = await watchRemoteImages(editor, doc, scope, services, { warn() {} });
      const addedImg = Object.assign(new FakeHTMLElement(), {
        matches: selector => selector === 'img',
        closest: () => null,
        querySelectorAll: () => [],
      });
      docDom = `<div data-node-id="${blk}"><img src="${remoteUrl}" /></div>`;
      observers.at(-1).callback([{ type: 'childList', target: editor, addedNodes: [addedImg], removedNodes: [] }]);
      await new Promise(resolve => setTimeout(resolve, 600));
      assert.deepEqual(callOrder, [
        'upload',
        `upsert:${remoteUrl}->assets/local-persist.png`,
        'commit:assets/local-persist.png',
        `mark:${remoteUrl}->assets/local-persist.png:replaced`,
        'compressOccurrence',
      ]);

      // When record persistence fails, commitOccurrence must NOT run and copyablePath is shown
      callOrder.length = 0;
      failUpsert = true;
      currentSrc = 'https://cdn.example/persist-fail.png';
      docDom = `<div data-node-id="${blk}"><img src="${currentSrc}" /></div>`;
      observers.at(-1).callback([{ type: 'childList', target: editor, addedNodes: [addedImg], removedNodes: [] }]);
      await new Promise(resolve => setTimeout(resolve, 600));
      assert.deepEqual(callOrder, [
        'upload',
        'upsert:https://cdn.example/persist-fail.png->assets/local-persist.png',
      ]);
      assert.deepEqual(copyPrompts, ['assets/local-persist.png']);
      handle.dispose();
    }
  } finally {
    globalThis.HTMLElement = prevHTMLElement;
    globalThis.Element = prevElement;
    globalThis.MutationObserver = prevMutationObserver;
    globalThis.document = prevDocument;
  }
});

test('ImageCompressorFeature attaches all editors via getAllEditor and skips rebuild on same-doc reattach', async () => {
  const { readFile } = await import('node:fs/promises');
  const { stripTypeScriptTypes } = await import('node:module');

  const prevHTMLElement = globalThis.HTMLElement;
  class FakeHTMLElement {}
  globalThis.HTMLElement = FakeHTMLElement;

  const featureFile = new URL('../../../src/features/image-compressor/ImageCompressorFeature.ts', import.meta.url);
  const src = await readFile(featureFile, 'utf8');
  const watchCalls = [];
  const disposedWatches = [];
  let watchSeq = 0;

  globalThis.__omnikitTestWatchRemoteImages = (element, doc, _scope, _services, _logger, initSignal) => {
    const id = ++watchSeq;
    let reconcileCalls = 0;
    const entry = {
      id,
      element,
      doc,
      initSignal,
      get reconcileCalls() { return reconcileCalls; },
    };
    watchCalls.push(entry);
    return Promise.resolve({
      dispose() { disposedWatches.push(id); },
      pause() {},
      resume() {},
      async reconcile() { reconcileCalls += 1; },
    });
  };

  const baseFeatureUrl = new URL('../../../src/core/framework/BaseFeature.ts', import.meta.url).href;
  const uiFeedbackUrl = new URL('../../../src/core/feedback/UiFeedback.ts', import.meta.url).href;
  const allowlistUrl = new URL('../../../src/features/image-compressor/policy/PageAllowlist.ts', import.meta.url).href;
  const docIdUrl = new URL('../../../src/features/image-compressor/policy/DocumentIdentity.ts', import.meta.url).href;
  const protyleAdapterUrl = new URL('../../../src/core/host/ProtyleAdapter.ts', import.meta.url).href;
  const parseCfgUrl = new URL('../../../src/features/image-compressor/policy/parseImageConfig.ts', import.meta.url).href;
  const taskRegUrl = new URL('../../../src/features/image-compressor/policy/TaskRegistry.ts', import.meta.url).href;
  const settingsUrl = new URL('../../../src/features/image-compressor/policy/settings.ts', import.meta.url).href;
  const autoPolicyUrl = new URL('../../../src/features/image-compressor/policy/AutoPolicy.ts', import.meta.url).href;
  const translateUrl = new URL('../../../src/i18n/translate.ts', import.meta.url).href;

  const runnable = stripTypeScriptTypes(src
    .replace(/import\s*\{[^}]*\}\s*from\s*"siyuan";/, 'const getActiveEditor = () => undefined; const getAllEditor = () => globalThis.__omnikitTestAllEditors ?? [];')
    .replace(/import\s*\{\s*KernelClient\s*\}\s*from\s*["'][^"']+["'];?/, 'class KernelClient { post() { return Promise.resolve({ data: {} }); } }')
    .replace(/import\s*\{\s*registerAutoUpload\s*\}\s*from\s*["'][^"']+["'];?/, 'const registerAutoUpload = () => {};')
    .replace(/import\s*\{\s*imageMenuContributions\s*\}\s*from\s*["'][^"']+["'];?/, 'const imageMenuContributions = () => [];')
    .replace(/import\s*\{\s*type\s+SingleImageEditorContext\s*\}\s*from\s*["'][^"']+["'];?/, '')
    .replace(/import\s*\{\s*ImageController\s*\}\s*from\s*["'][^"']+["'];?/, 'class ImageController {}')
    .replace(/import\s*\{\s*createImageServices\s*\}\s*from\s*["'][^"']+["'];?/, 'const createImageServices = () => ({});')
    .replace(/import\s*\{\s*watchRemoteImages[^}]*\}\s*from\s*["'][^"']+["'];?/, 'const watchRemoteImages = (...args) => globalThis.__omnikitTestWatchRemoteImages(...args);')
    .replace(/from\s*["'][^"']*BaseFeature\.ts["']/, `from "${baseFeatureUrl}"`)
    .replace(/from\s*["'][^"']*UiFeedback\.ts["']/, `from "${uiFeedbackUrl}"`)
    .replace(/from\s*["'][^"']*PageAllowlist\.ts["']/, `from "${allowlistUrl}"`)
    .replace(/from\s*["'][^"']*DocumentIdentity\.ts["']/, `from "${docIdUrl}"`)
    .replace(/from\s*["'][^"']*ProtyleAdapter\.ts["']/, `from "${protyleAdapterUrl}"`)
    .replace(/from\s*["'][^"']*parseImageConfig\.ts["']/, `from "${parseCfgUrl}"`)
    .replace(/from\s*["'][^"']*TaskRegistry\.ts["']/, `from "${taskRegUrl}"`)
    .replace(/from\s*["'][^"']*settings\.ts["']/, `from "${settingsUrl}"`)
    .replace(/from\s*["'][^"']*AutoPolicy\.ts["']/, `from "${autoPolicyUrl}"`)
    .replace(/from\s*["'][^"']*translate\.ts["']/, `from "${translateUrl}"`),
  );

  const { ImageCompressorFeature } = await import(`data:text/javascript,${encodeURIComponent(runnable)}`);

  try {
    const bus = new Map();
    const el1 = new FakeHTMLElement();
    const el2 = new FakeHTMLElement();
    const protyle1 = { element: el1, block: { rootID: '20260101000000-doc1', box: 'box-1' } };
    const protyle2 = { element: el2, block: { rootID: '20260101000000-doc2', box: 'box-2' } };
    globalThis.__omnikitTestAllEditors = [{ protyle: protyle1 }, { protyle: protyle2 }];

    const plugin = {
      i18n: { 'feature.image-compressor.title': 'Image', 'feature.image-compressor.description': 'Desc' },
      eventBus: {
        on(name, fn) { if (!bus.has(name)) bus.set(name, new Set()); bus.get(name).add(fn); },
        off(name, fn) { bus.get(name)?.delete(fn); },
        emit(name, detail) { for (const fn of bus.get(name) ?? []) fn({ detail }); },
      },
    };
    const settings = {
      store: () => ({ subscribe: () => () => {} }),
      getFeature: () => defaultImageFeatureConfig(),
      getFeatureEnabled: () => true,
    };
    const ctx = {
      plugin,
      settings,
      logger: { warn() {}, debug() {}, error() {}, info() {} },
      feedback: { forScope() { return this; }, notify() {} },
      menus: { contribute() {} },
    };

    const feature = new ImageCompressorFeature(plugin, settings);
    await feature.activate(ctx);
    await Promise.resolve();

    assert.equal(watchCalls.length, 2, 'must attach both split-pane editors from getAllEditor()');
    assert.deepEqual(disposedWatches, []);

    // Same document re-emitted on el1: must NOT dispose or rebuild watchRemoteImages
    plugin.eventBus.emit('switch-protyle', { protyle: protyle1 });
    await Promise.resolve();
    assert.equal(watchCalls.length, 2, 'same-doc switch-protyle must not rebuild watcher');
    assert.deepEqual(disposedWatches, []);
    assert.equal(watchCalls[0].reconcileCalls, 1);

    // Switching el1 to a different rootID: must abort previous initSignal, dispose old watcher, and attach new one
    const protyle1Next = { element: el1, block: { rootID: '20260101000000-doc3', box: 'box-1' } };
    plugin.eventBus.emit('switch-protyle', { protyle: protyle1Next });
    await Promise.resolve();
    assert.equal(watchCalls.length, 3);
    assert.equal(watchCalls[0].initSignal.aborted, true);
    assert.deepEqual(disposedWatches, [1]);

    await feature.deactivate();
    assert.equal(watchCalls[1].initSignal.aborted, true);
    assert.equal(watchCalls[2].initSignal.aborted, true);
  } finally {
    delete globalThis.__omnikitTestAllEditors;
    delete globalThis.__omnikitTestWatchRemoteImages;
    globalThis.HTMLElement = prevHTMLElement;
  }
});

test('scanImageRefs returns empty on blank DOM, skips orphan img nodes, and returns parsed ImageSource', async () => {
  const { scanImageRefs } = await import('../../../src/features/image-compressor/policy/dom.ts');
  const prevDoc = globalThis.document;
  try {
    assert.deepEqual(scanImageRefs('   ', 'http://127.0.0.1:6806'), []);

    const orphanImg = {
      hasAttribute: name => name === 'src',
      getAttribute: name => (name === 'src' ? 'https://cdn.example/orphan.png' : null),
      closest: () => null,
    };
    const validImg = {
      hasAttribute: name => name === 'src',
      getAttribute: name => (name === 'src' ? 'https://cdn.example/valid.png' : null),
      closest: sel => (sel === '[data-node-id]' ? { getAttribute: () => '20260101000001-blk' } : null),
    };
    globalThis.document = {
      createElement: () => ({
        innerHTML: '',
        content: {
          querySelectorAll: sel => (sel === 'img' ? [orphanImg, validImg] : []),
        },
      }),
    };

    const refs = scanImageRefs('<div data-node-id="20260101000001-blk"><img src="https://cdn.example/valid.png"/></div>', 'http://127.0.0.1:6806');
    assert.equal(refs.length, 1);
    assert.equal(refs[0].blockID, '20260101000001-blk');
    assert.equal(refs[0].source.kind, 'remote');
    assert.equal(refs[0].source.raw, 'https://cdn.example/valid.png');
  } finally {
    globalThis.document = prevDoc;
  }
});
