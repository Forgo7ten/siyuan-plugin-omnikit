import test from 'node:test';
import assert from 'node:assert/strict';
import { scanDocumentImageDOM } from '../src/features/image-compressor/DocumentImageScanner.ts';

const image = (blockId, source) => ({
  closest: () => ({ getAttribute: () => blockId }),
  getAttribute: (name) => name === 'src' ? source : null,
});

test('full kernel DOM scan includes folded, nested and unmounted content and assigns each image to its nearest block', () => {
  const oldParser = globalThis.DOMParser;
  const blocks = ['root', 'folded', 'nested', 'long-tail'];
  const images = [
    image('folded', 'assets/a.png'),
    image('nested', 'assets/a.png'), // same resource referenced twice
    image('long-tail', 'assets/b.jpg'), // represented by the kernel AST, not mounted editor DOM
  ];
  globalThis.DOMParser = class {
    parseFromString() { return { querySelector: () => null, querySelectorAll: selector => selector === 'img' ? images : blocks.map(id => ({ id })) }; }
  };
  try {
    const result = scanDocumentImageDOM('<complete-kernel-dom/>', {});
    assert.equal(result.scannedBlocks, 4);
    assert.deepEqual(result.occurrences.map(item => [item.blockId, item.source]), [
      ['folded', 'assets/a.png'], ['nested', 'assets/a.png'], ['long-tail', 'assets/b.jpg'],
    ]);
  } finally { globalThis.DOMParser = oldParser; }
});

test('scan rejects an unowned local image instead of reporting a complete document', () => {
  const oldParser = globalThis.DOMParser;
  globalThis.DOMParser = class {
    parseFromString() {
      return {
        querySelector: () => null,
        querySelectorAll: selector => selector === 'img'
          ? [{ closest: () => null, getAttribute: name => name === 'src' ? 'assets/orphan.png' : null }]
          : [{ id: 'root' }],
      };
    }
  };
  try { assert.throws(() => scanDocumentImageDOM('<incomplete>', {}), /owning block/); }
  finally { globalThis.DOMParser = oldParser; }
});
