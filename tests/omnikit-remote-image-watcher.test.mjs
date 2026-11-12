import test from 'node:test';
import assert from 'node:assert/strict';
import { addedRemoteCandidates } from '../src/features/image-compressor/RemoteImageWatcher.ts';
import { defaultImageFeatureConfig } from '../src/features/image-compressor/parseImageConfig.ts';

const rootID = '20260101000000-abcdefg';
const candidate = (url, blockID = '20260101000001-abcdefg', count = 1) => ({
  blockID, count, source: { kind: 'remote', key: `remote:${url}`, raw: url, url, name: 'image.png' },
});
const identity = value => `${value.blockID}\n${value.source.key}`;
const config = () => {
  const value = defaultImageFeatureConfig();
  value.auto.globalEnabled = true;
  value.auto.remoteImages = true;
  return value;
};

test('persisted baseline suppresses existing images and only count increases are candidates', () => {
  const before = candidate('https://images.example/a.png', undefined, 2);
  const after = candidate('https://images.example/a.png', undefined, 2);
  assert.deepEqual(addedRemoteCandidates(new Map([[identity(before), before]]), new Map([[identity(after), after]]), config(), rootID), []);

  const inserted = candidate('https://images.example/a.png', undefined, 3);
  assert.deepEqual(addedRemoteCandidates(new Map([[identity(before), before]]), new Map([[identity(inserted), inserted]]), config(), rootID), [inserted]);
});

test('automatic candidates require remote-image setting and page permission', () => {
  const item = candidate('https://images.example/a.png');
  const current = new Map([[identity(item), item]]);
  assert.equal(addedRemoteCandidates(new Map(), current, config(), rootID).length, 1);
  const disabled = config(); disabled.auto.remoteImages = false;
  assert.equal(addedRemoteCandidates(new Map(), current, disabled, rootID).length, 0);
  assert.equal(addedRemoteCandidates(new Map(), current, config(), 'invalid').length, 0);

  for (const url of ['http://images.example/a.png', 'https://images.example.evil/a.png', 'https://other.example/a.png']) {
    const candidateItem = candidate(url);
    assert.equal(addedRemoteCandidates(new Map(), new Map([[identity(candidateItem), candidateItem]]), config(), rootID).length, 1);
  }
});
