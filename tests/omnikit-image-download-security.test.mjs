import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createDesktopBridge } from '../src/features/image-compressor/desktop.ts';
import { requireRemotePermission } from '../src/features/image-compressor/download.ts';
import { assertImagePayload } from '../src/features/image-compressor/RemoteImageWatcher.ts';

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
  return { bridge: createDesktopBridge(load, async () => false), requests, loaded };
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
    const bridge = createDesktopBridge(createRequire(import.meta.url), async () => false);
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
