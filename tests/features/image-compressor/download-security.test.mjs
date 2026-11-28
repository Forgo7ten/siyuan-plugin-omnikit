import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createDesktopBridge } from '../../../src/features/image-compressor/services/desktop.ts';
import { requireRemotePermission } from '../../../src/features/image-compressor/services/download.ts';
import { resolveSource } from '../../../src/features/image-compressor/policy/source.ts';
import { assertImagePayload } from '../../../src/features/image-compressor/services/ImageProcessingServices.ts';
import { prepareImage } from '../../../src/features/image-compressor/services/ImageProcessingServices.ts';
import { defaultImageFeatureConfig } from '../../../src/features/image-compressor/policy/parseImageConfig.ts';
import { DEFAULT_USER_AGENT, SettingsManager } from '../../../src/core/store/SettingsManager.ts';

function bridgeFor({ responses = [] } = {}) {
  const requests = [];
  const loaded = [];
  const requestModule = { request(url, options, callback) {
    const req = new EventEmitter();
    req.destroy = () => { req.emit('close'); };
    req.end = () => {
      requests.push({ url, options });
      const next = responses.shift() ?? {};
      if (next.hang) return;
      const res = new EventEmitter();
      res.statusCode = next.status ?? 200;
      res.headers = {
        'content-length': String(next.declaredBytes ?? 2),
        'content-type': 'image/png',
        ...(next.location ? { location: next.location } : {}),
      };
      res.destroy = () => {};
      queueMicrotask(() => {
        callback(res);
        if (res.statusCode >= 300 && res.statusCode < 400) res.emit('end');
        else if (next.body) { res.emit('data', Buffer.from(next.body)); res.emit('end'); }
        else { res.emit('data', Buffer.from([1, 2])); res.emit('end'); }
        req.emit('close');
      });
    };
    return req;
  } };
  const load = name => {
    loaded.push(name);
    if (name === 'node:dns/promises') throw new Error('desktop downloader must not resolve DNS');
    return name === 'node:http' || name === 'node:https' ? requestModule : {};
  };
  return { bridge: createDesktopBridge(load), requests, loaded };
}

const options = { maxBytes: 8, timeoutMs: 500 };

test('URL validation permits local, private, IPv6, and proxy fake-IP destinations', () => {
  for (const url of [
    'http://localhost/image.png', 'http://127.0.0.1/image.png',
    'http://192.168.1.1/image.png', 'http://169.254.169.254/image.png',
    'http://198.18.0.42/image.png', 'http://[::1]/image.png',
    'https://images.example/image.png',
  ]) assert.doesNotThrow(() => requireRemotePermission(url), url);
  for (const url of ['ftp://images.example/a.png', 'file:///tmp/a.png',
    'https://user:password@images.example/a.png']) {
    assert.throws(() => requireRemotePermission(url), /HTTP\(S\)/);
  }
});

test('desktop requests the original hostname without a DNS query, IP classifier, or pinned lookup', async () => {
  const host = 'sns-webpic-qc.xhscdn.com';
  const { bridge, requests, loaded } = bridgeFor();
  const result = await bridge.download(`https://${host}/image`, options);
  assert.equal(result.blob.size, 2);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.hostname, host);
  assert.equal('lookup' in requests[0].options, false);
  assert.equal(loaded.includes('node:dns/promises'), false);
});

test('desktop downloads directly from a local HTTP URL', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'image/png', 'content-length': '2' });
    response.end(Buffer.from([1, 2]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const bridge = createDesktopBridge(createRequire(import.meta.url));
    const result = await bridge.download(`http://127.0.0.1:${port}/a.png`, options);
    assert.equal(result.blob.size, 2);
    assert.equal(result.name, 'a.png');
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('desktop keeps custom User-Agent and sends no Cookie or Authorization', async () => {
  const { bridge, requests } = bridgeFor();
  await bridge.download('https://images.example/a.png', { ...options, userAgent: 'OmniKit/1.0' });
  assert.equal(requests[0].options.headers['User-Agent'], 'OmniKit/1.0');
  assert.equal(requests[0].options.headers.Cookie, undefined);
  assert.equal(requests[0].options.headers.Authorization, undefined);
  await assert.rejects(bridge.download('https://images.example/a.png',
    { ...options, userAgent: 'bad\r\nHeader: yes' }), /User-Agent/);
});

test('redirects can target local addresses while protocol and embedded credentials stay checked', async () => {
  const { bridge, requests } = bridgeFor({ responses: [
    { status: 302, location: 'http://127.0.0.1/image.png' },
  ] });
  const result = await bridge.download('https://images.example/a.png', options);
  assert.equal(result.blob.size, 2);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].url.hostname, '127.0.0.1');

  for (const location of ['file:///tmp/image.png', 'https://user:pass@images.example/a.png']) {
    const denied = bridgeFor({ responses: [{ status: 302, location }] });
    await assert.rejects(denied.bridge.download('https://images.example/a.png', options), /HTTP\(S\)/);
    assert.equal(denied.requests.length, 1);
  }
});

test('desktop follows more than 3 redirects while guarding against infinite redirect loops (D03)', async () => {
  const fiveHops = bridgeFor({
    responses: [
      { status: 302, location: 'https://cdn1.example/step1.png' },
      { status: 301, location: 'https://cdn2.example/step2.png' },
      { status: 307, location: 'https://cdn3.example/step3.png' },
      { status: 308, location: 'https://cdn4.example/step4.png' },
      { status: 302, location: 'https://cdn5.example/final.png' },
    ],
  });
  const ok = await fiveHops.bridge.download('https://images.example/start.png', options);
  assert.equal(ok.blob.size, 2);
  assert.equal(ok.name, 'final.png');
  assert.equal(fiveHops.requests.length, 6);

  const loopResponses = Array.from({ length: 25 }, (_, i) => ({
    status: 302,
    location: `https://loop.example/${i}`,
  }));
  const infinite = bridgeFor({ responses: loopResponses });
  await assert.rejects(infinite.bridge.download('https://loop.example/start.png', options), /Too many redirects/);
});

test('desktop enforces declared and streamed response byte limits', async () => {
  const declared = bridgeFor({ responses: [{ declaredBytes: 9 }] });
  await assert.rejects(declared.bridge.download('https://images.example/a.png', options), /byte limit/);
  const streamed = bridgeFor({ responses: [{ declaredBytes: 2, body: new Uint8Array(9) }] });
  await assert.rejects(streamed.bridge.download('https://images.example/a.png', options), /byte limit/);
});

test('remote SVG validation checks dangerous markup past the first 4096 bytes', async () => {
  await assertImagePayload(new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>']));
  await assert.rejects(
    assertImagePayload(new Blob(['<svg>', ' '.repeat(5000), '<script>alert(1)</script></svg>'])),
    /Unsafe SVG/,
  );
});

test('prepareImage passes Core userAgent from services to reader (default fallback and custom)', async () => {
  function createPlugin(userAgent = '') {
    const storage = new Map([
      ['omnikit-core.json', { schemaVersion: 1, general: { debugLog: false, userAgent }, featureStates: {} }],
    ]);
    const plugin = {
      storage,
      loadDataCalls: 0,
      async loadData(name) { plugin.loadDataCalls += 1; return storage.get(name) ?? ''; },
      async saveData(name, value) { storage.set(name, structuredClone(value)); },
    };
    return plugin;
  }

  function createFileGetFetch(storage, pluginName = 'siyuan-plugin-omnikit') {
    const prefix = `/data/storage/petal/${pluginName}/`;
    return async (url, request) => {
      assert.equal(url, '/api/file/getFile');
      assert.equal(request.method, 'POST');
      const { path } = JSON.parse(request.body);
      assert.ok(path.startsWith(prefix), `Unexpected storage path: ${path}`);
      const name = path.slice(prefix.length);
      assert.equal(path, `/data/storage/petal/${pluginName}/${name}`);
      assert.ok(!name.includes('/'));
      if (!storage.has(name)) {
        return new Response(JSON.stringify({ code: 404, msg: 'not found' }), { status: 202 });
      }
      const raw = storage.get(name);
      return new Response(typeof raw === 'string' ? raw : JSON.stringify(raw), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
  }

  const runWithUA = async (customUA) => {
    let capturedOptions;
    const plugin = createPlugin(customUA);
    const settings = new SettingsManager(plugin, [], createFileGetFetch(plugin.storage));
    await settings.load();
    assert.equal(plugin.loadDataCalls, 0);

    const mockServices = {
      origin: 'http://localhost:6806',
      userAgent: () => settings.getUserAgent(),
      reader: {
        async read(source, options) {
          capturedOptions = options;
          return { blob: new Blob(['x']), name: 'test.png' };
        },
      },
      encoder: {
        async encode() {
          return { kind: 'skipped', reason: 'test' };
        },
      },
      assets: { upload: async () => 'assets/test.webp' },
      references: {},
      records: {},
      recordsReady: Promise.resolve(),
      ui: { copyablePath() {} },
    };
    const source = { kind: 'asset', path: 'assets/test.png', key: 'asset:assets/test.png', name: 'test.png', raw: 'assets/test.png' };
    const config = defaultImageFeatureConfig();
    await prepareImage(mockServices, source, '20250101000000-abcdefg', 'manual-quick', config, new AbortController().signal);
    return capturedOptions;
  };

  const defaultOptions = await runWithUA('');
  assert.equal(defaultOptions?.userAgent, DEFAULT_USER_AGENT);

  const customOptions = await runWithUA('OmniKit-Core/2.0 Custom');
  assert.equal(customOptions?.userAgent, 'OmniKit-Core/2.0 Custom');
});

test('image compressor downloaders read userAgent from services.userAgent instead of private config', async () => {
  const singleAction = await readFile(new URL('../../../src/features/image-compressor/actions/SingleImageAction.ts', import.meta.url), 'utf8');
  const watcher = await readFile(new URL('../../../src/features/image-compressor/actions/RemoteImageWatcher.ts', import.meta.url), 'utf8');
  const processingServices = await readFile(new URL('../../../src/features/image-compressor/services/ImageProcessingServices.ts', import.meta.url), 'utf8');
  const servicesCode = await readFile(new URL('../../../src/features/image-compressor/services/createImageServices.ts', import.meta.url), 'utf8');

  assert.doesNotMatch(singleAction, /config\.remote\.downloadUserAgent/);
  assert.match(singleAction, /userAgent:\s*services\.userAgent\(\)/);

  assert.doesNotMatch(watcher, /config\.remote\.downloadUserAgent/);
  assert.match(watcher, /localizeRemoteAsset/);

  assert.doesNotMatch(processingServices, /config\.remote\.downloadUserAgent/);
  assert.match(processingServices, /userAgent:\s*services\.userAgent\(\)/);

  assert.match(servicesCode, /userAgent:\s*\(\)\s*=>\s*context\.settings\.getUserAgent\(\)/);
});

test('desktop bridge omits readFile/fs/url and resolveSource rejects all local file paths', async () => {
  const { bridge, loaded } = bridgeFor();
  assert.equal('readFile' in bridge, false);
  assert.equal(loaded.includes('node:fs/promises'), false);
  assert.equal(loaded.includes('node:url'), false);

  for (const localRaw of ['file:///tmp/a.png', 'C:\\tmp\\a.png', '\\\\server\\share\\a.png', '/tmp/a.png']) {
    assert.throws(
      () => resolveSource(localRaw, 'http://localhost:6806'),
      /Local file sources are not supported/,
    );
  }
});
