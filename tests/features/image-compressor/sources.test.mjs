import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSource,
  outputName,
  sameAsset,
  buildReplacementPath,
} from '../../../src/features/image-compressor/policy/source.ts';
import { SourceReader, requireRemotePermission } from '../../../src/features/image-compressor/services/download.ts';
import { inspectImage } from '../../../src/features/image-compressor/services/image.ts';

test('source resolver preserves literal asset paths, box identity, and decorative query/hash suffixes', () => {
  const literalPercent = resolveSource('./assets/a%20b.png?box=20240101000000-abcdefg', 'https://kernel.example');
  assert.equal(literalPercent.kind, 'asset');
  assert.equal(literalPercent.kernelPath, 'assets/a%20b.png?box=20240101000000-abcdefg');
  assert.equal(literalPercent.fetchURL, 'https://kernel.example/assets/a%2520b.png?box=20240101000000-abcdefg');

  const urlEncodedFromKernel = resolveSource('https://kernel.example/assets/a%20b.png?box=20240101000000-abcdefg&width=200#preview', 'https://kernel.example');
  assert.equal(urlEncodedFromKernel.kind, 'asset');
  assert.equal(urlEncodedFromKernel.kernelPath, 'assets/a b.png?box=20240101000000-abcdefg');
  assert.equal(urlEncodedFromKernel.fetchURL, 'https://kernel.example/assets/a%20b.png?box=20240101000000-abcdefg');

  const decorated = resolveSource('assets/x.png?resize=1&width=320#fig', 'https://kernel.example');
  assert.equal(decorated.kind, 'asset');
  assert.equal(decorated.kernelPath, 'assets/x.png');
  assert.equal(decorated.key, 'asset:assets/x.png');

  assert.throws(() => resolveSource('assets/../secret.png', 'https://kernel.example'));
  assert.throws(() => resolveSource('assets/x.png?box=bad', 'https://kernel.example'));
});

test('source resolver separates 100%.png vs 100%25.png, preserves case sensitivity, and builds safe replacements', () => {
  const pct = resolveSource('assets/100%.png', 'https://kernel.example');
  const pct25 = resolveSource('assets/100%25.png', 'https://kernel.example');
  assert.equal(pct.kernelPath, 'assets/100%.png');
  assert.equal(pct25.kernelPath, 'assets/100%25.png');
  assert.notEqual(pct.key, pct25.key);
  assert.equal(pct.fetchURL, 'https://kernel.example/assets/100%25.png');
  assert.equal(pct25.fetchURL, 'https://kernel.example/assets/100%2525.png');

  const upper = resolveSource('assets/Photo.png', 'https://kernel.example');
  const lower = resolveSource('assets/photo.png', 'https://kernel.example');
  assert.notEqual(upper.key, lower.key);
  assert.equal(sameAsset('assets/Photo.png?width=100#top', 'assets/Photo.png', 'https://kernel.example'), true);
  assert.equal(sameAsset('assets/Photo.png', 'assets/photo.png', 'https://kernel.example'), false);

  assert.equal(
    buildReplacementPath('assets/a.png?width=200#top', 'assets/a.webp?box=20240101000000-abcdefg', 'https://kernel.example'),
    'assets/a.webp?box=20240101000000-abcdefg#top',
  );
  assert.equal(
    buildReplacementPath('assets/a.png?box=20240101000000-abcdefg&width=200', 'assets/a.webp', 'https://kernel.example'),
    'assets/a.webp',
  );
  assert.equal(
    buildReplacementPath('assets/a.png?resize=1&width=200&height=100#fig', 'assets/a.webp?box=20240101000000-abcdefg', 'https://kernel.example'),
    'assets/a.webp?box=20240101000000-abcdefg#fig',
  );
  assert.equal(
    buildReplacementPath('https://cdn.example/photo.png?token=secret&width=100#section', 'assets/a.webp?box=20240101000000-abcdefg', 'https://kernel.example'),
    'assets/a.webp?box=20240101000000-abcdefg',
  );
  assert.equal(
    buildReplacementPath('file:///C:/images/cat.png#frag', 'assets/a.webp', 'https://kernel.example'),
    'assets/a.webp',
  );
  assert.equal(
    buildReplacementPath('assets/a.png?box=20240101000000-abcdefg&box=20240101000000-hijklmn&width=200#frag', 'assets/a.webp?box=20240101000000-abcdefg', 'https://kernel.example'),
    'assets/a.webp?box=20240101000000-abcdefg',
  );
});

test('source resolver handles Windows and file URLs but rejects network shares', () => {
  assert.equal(resolveSource('C:\\images\\cat.png', 'https://kernel.example').kind, 'file');
  assert.equal(resolveSource('file:///C:/images/cat.png', 'https://kernel.example').kind, 'file');
  assert.throws(() => resolveSource('\\\\server\\share\\cat.png', 'https://kernel.example'));
  assert.equal(outputName('../圖 表?.png'), '圖 表_.webp');
});

test('source reader enforces allowed HTTP/HTTPS origins and bounded unauthenticated fetch following redirects', async () => {
  assert.throws(() => requireRemotePermission('ftp://images.example/a.png'));
  assert.doesNotThrow(() => requireRemotePermission('http://any-domain.example/a.png'));
  assert.doesNotThrow(() => requireRemotePermission('https://any-domain.example/a.png'));
  let init;
  const reader = new SourceReader(async (_url, options) => { init = options; return new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/png' } }); });
  const source = resolveSource('https://images.example/a.png', 'https://kernel.example');
  const result = await reader.read(source, { maxBytes: 4, timeoutMs: 1000 });
  assert.equal(result.blob.size, 2);
  assert.equal(init.credentials, 'omit');
  assert.equal(init.redirect, 'follow');
  const tooLarge = new SourceReader(async () => new Response(new Uint8Array(5)));
  await assert.rejects(tooLarge.read(source, { maxBytes: 4, timeoutMs: 1000 }), /byte limit/);
});

test('image inspection refuses animated PNG and malformed output containers', () => {
  const png = new Uint8Array(8 + 25 + 12 + 13 + 12);
  png.set([137,80,78,71,13,10,26,10]);
  const view = new DataView(png.buffer);
  view.setUint32(8, 13); png.set([73,72,68,82], 12); view.setUint32(16, 1); view.setUint32(20, 1);
  png.set([8,6,0,0,0], 24); view.setUint32(33, 0); png.set([97,99,84,76], 37);
  view.setUint32(45, 1); png.set([73,68,65,84,1], 49); view.setUint32(58, 0); png.set([73,69,78,68], 62);
  // Structural parser must recognize the APNG control chunk before any decoder is invoked.
  assert.equal(inspectImage(png).animated, true);
  assert.throws(() => inspectImage(new Uint8Array([82,73,70,70,0,0,0,0,87,69,66,80])), /length mismatch/);
});
