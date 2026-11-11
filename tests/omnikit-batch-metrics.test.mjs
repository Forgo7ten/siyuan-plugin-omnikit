import test from 'node:test';
import assert from 'node:assert/strict';
import { recordRewrittenReference } from '../src/features/image-compressor/CompressionResult.ts';

function summary() {
  return {
    referencesRewritten: 0,
    succeeded: 0,
    originalReferencedBytes: 0,
    newReferencedBytes: 0,
    logicalReductionBytes: 0,
  };
}

test('rewritten references count individually while resource bytes count once per source path', () => {
  const result = summary();
  const countedPaths = new Set();

  recordRewrittenReference(result, '/assets/a.png', 1000, 400, countedPaths);
  recordRewrittenReference(result, '/assets/a.png', 1000, 400, countedPaths);
  recordRewrittenReference(result, '/assets/b.png', 500, 300, countedPaths);

  assert.equal(result.referencesRewritten, 3);
  assert.equal(result.succeeded, 3);
  assert.equal(result.originalReferencedBytes, 1500);
  assert.equal(result.newReferencedBytes, 700);
  assert.equal(result.logicalReductionBytes, 800);
});
