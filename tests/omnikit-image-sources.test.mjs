import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSource, outputName } from '../src/features/image-compressor/source.ts';
import { SourceReader, requireRemotePermission } from '../src/features/image-compressor/download.ts';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const imageSource = await readFile(new URL('../src/features/image-compressor/image.ts', import.meta.url), 'utf8');
const imageJavascript = ts.transpile(imageSource.replace('import { outputName } from "./source.ts";', 'const outputName = name => name + ".webp";'), { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 });
const imageModule = await import(`data:text/javascript,${encodeURIComponent(imageJavascript)}`);
const { inspectImage } = imageModule;

test('source resolver canonicalizes workspace assets and preserves box identity', () => {
  const source = resolveSource('./assets/a%20b.png?box=20240101000000-abcdefg', 'https://kernel.example');
  assert.equal(source.kind, 'asset');
  assert.equal(source.fetchURL, 'https://kernel.example/assets/a%20b.png?box=20240101000000-abcdefg');
  assert.throws(() => resolveSource('assets/../secret.png', 'https://kernel.example'));
  assert.throws(() => resolveSource('assets/x.png?resize=1', 'https://kernel.example'));
});

test('source resolver handles Windows and file URLs but rejects network shares', () => {
  assert.equal(resolveSource('C:\\images\\cat.png', 'https://kernel.example').kind, 'file');
  assert.equal(resolveSource('file:///C:/images/cat.png', 'https://kernel.example').kind, 'file');
  assert.throws(() => resolveSource('\\\\server\\share\\cat.png', 'https://kernel.example'));
  assert.equal(outputName('../圖 表?.png'), '圖 表_.webp');
});

test('source reader enforces allowed HTTP/HTTPS origins and bounded unauthenticated fetch', async () => {
  assert.throws(() => requireRemotePermission('ftp://images.example/a.png'));
  assert.doesNotThrow(() => requireRemotePermission('http://any-domain.example/a.png'));
  assert.doesNotThrow(() => requireRemotePermission('https://any-domain.example/a.png'));
  let init;
  const reader = new SourceReader(async (_url, options) => { init = options; return new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/png' } }); });
  const source = resolveSource('https://images.example/a.png', 'https://kernel.example');
  const result = await reader.read(source, { maxBytes: 4, timeoutMs: 1000 });
  assert.equal(result.blob.size, 2);
  assert.equal(init.credentials, 'omit');
  assert.equal(init.redirect, 'error');
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
