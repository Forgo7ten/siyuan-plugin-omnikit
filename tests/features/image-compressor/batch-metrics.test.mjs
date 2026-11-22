import test from 'node:test';
import assert from 'node:assert/strict';
import { recordRewrittenReference } from '../../../src/features/image-compressor/policy/CompressionResult.ts';

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

test('DocumentBatchAction does not call ui.notify directly or emit capacityReached', async () => {
  const { readFile } = await import('node:fs/promises');
  const [batch, controller] = await Promise.all([
    readFile(new URL('../../../src/features/image-compressor/actions/DocumentBatchAction.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../../src/features/image-compressor/ImageController.ts', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(batch, /capacityReached|isRecordCapacityError/);
  assert.doesNotMatch(batch, /services\.ui\.notify\(/);
  assert.doesNotMatch(controller, /capacityReached|capacityNotice/);
  assert.doesNotMatch(batch, /diskReclaimedBytes/);
  assert.doesNotMatch(controller, /diskReclaimedBytes/);
});

test('ImageController formats non-zero batch & auto-upload summaries, localizes status bar, and supports MB', async () => {
  const { readFile } = await import('node:fs/promises');
  const { FeatureScope } = await import('../../../src/core/framework/FeatureScope.ts');
  const { TaskRegistry } = await import('../../../src/features/image-compressor/policy/TaskRegistry.ts');
  const { ImageController } = await import('../../../src/features/image-compressor/ImageController.ts');
  const { translate } = await import('../../../src/i18n/translate.ts');

  const [zhRaw, enRaw] = await Promise.all([
    readFile(new URL('../../../src/i18n/zh-CN.json', import.meta.url), 'utf8'),
    readFile(new URL('../../../src/i18n/en.json', import.meta.url), 'utf8'),
  ]);
  const zh = JSON.parse(zhRaw);
  const en = JSON.parse(enRaw);

  const notices = [];
  const statusUpdates = [];
  const scope = new FeatureScope();
  const tasks = new TaskRegistry();
  const controller = new ImageController(
    {
      plugin: { i18n: zh },
      feedback: { notify(msg, type) { notices.push({ msg, type }); } },
      logger: { warn() {}, error() {}, debug() {} },
      statusBar: { update(id, text) { statusUpdates.push({ id, text }); }, clear() {} },
    },
    scope,
    { ui: { copyablePath() {}, notify() {}, progress: () => ({ close() {} }) } },
    tasks,
  );

  // Auto-upload single success shows detailed size & signed ratio notice
  controller.reportAutoUploadNotice({
    total: 1,
    successful: 1,
    skipped: 0,
    failed: 0,
    singleReason: 'success',
    originalBytes: 2 * 1024 * 1024,
    compressedBytes: 512 * 1024,
  });
  assert.equal(notices.at(-1).msg, '图片压缩成功：2.00 MB → 512.0 KB（-75.0%）');

  // Auto-upload allSuccess shortcut
  controller.reportAutoUploadNotice({ total: 2, successful: 2, skipped: 0, failed: 0 });
  assert.equal(notices.at(-1).msg, '已自动压缩 2 张图片');

  // Auto-upload mixed: omits 0-count items and reuses image.batch.unknownCount
  controller.reportAutoUploadNotice({ total: 3, successful: 1, skipped: 1, failed: 0, unknown: 1 });
  assert.equal(notices.at(-1).msg, '自动压缩完成：共 3 张，成功 1 张，跳过 1 张，结果未知 1 处');

  // Verify English auto-upload formatting too
  const enStatusUpdates = [];
  const enNotices = [];
  const { defaultImageFeatureConfig } = await import('../../../src/features/image-compressor/policy/parseImageConfig.ts');
  const rootID = '20260101000001-abcdef0';
  const blockID = '20260101000002-abcdef0';
  const twoMiB = 2 * 1024 * 1024;
  const halfMiB = 512 * 1024;
  const mockServices = {
    origin: 'http://localhost:6806',
    mobile: false,
    config: () => defaultImageFeatureConfig(),
    userAgent: () => 'TestUA',
    ui: {
      copyablePath() {},
      notify() {},
      progress: () => ({ update() {}, close() {} }),
    },
    kernel: {
      post: async (path) => {
        if (path === '/api/block/getBlockInfo') return { code: 0, data: { id: rootID, rootID, box: 'nb-1', type: 'd' } };
        if (path === '/api/block/getBlockDOM') return { code: 0, data: { id: rootID, dom: `<div data-node-id="${rootID}"></div>` } };
        throw new Error(`unexpected kernel call: ${path}`);
      },
    },
    compressOccurrence: async (target) => ({
      status: 'saved',
      path: target.oldPath.replace(/\.png$/, '.webp'),
      originalBytes: twoMiB,
      compressedBytes: halfMiB,
      reference: 'not-requested',
    }),
    records: {
      markOperation: async () => {},
    },
    references: {
      commitOccurrenceDetailed: async (target) => (
        target.oldPath === 'assets/big.png' ? { status: 'replaced' } : { status: 'unknown' }
      ),
    },
  };
  const enController = new ImageController(
    {
      plugin: { i18n: en },
      feedback: { notify(msg, type) { enNotices.push({ msg, type }); } },
      logger: { warn() {}, error() {}, debug() {} },
      statusBar: { update(id, text) { enStatusUpdates.push({ id, text }); }, clear() {} },
    },
    scope,
    mockServices,
    tasks,
  );
  enController.reportAutoUploadNotice({ total: 2, successful: 1, skipped: 0, failed: 1 });
  assert.equal(enNotices.at(-1).msg, 'Auto-compression complete: 2 total, 1 succeeded, 1 failed.');

  // Run real compressDocument to verify non-zero batch summary, MB formatting, and localized status bar
  const priorDOMParser = globalThis.DOMParser;
  const fakeImg = (src) => ({
    closest: selector => selector === '[data-node-id]' ? { getAttribute: () => blockID } : null,
    hasAttribute: name => name === 'src',
    getAttribute: name => name === 'src' ? src : null,
  });
  globalThis.DOMParser = class {
    parseFromString() {
      return {
        querySelector: () => null,
        querySelectorAll: selector => selector === 'img'
          ? [fakeImg('assets/big.png'), fakeImg('assets/uncertain.png')]
          : [{ id: blockID }],
      };
    }
  };
  try {
    await enController.compressDocument({ protyle: { block: { rootID, box: 'nb-1' } } }, rootID);
    assert.ok(enStatusUpdates.length > 0, 'compressDocument must update statusBar');
    assert.equal(
      enStatusUpdates.every(u => u.text.startsWith(`${en['feature.imageCompressor.title']} `) && !u.text.includes('图片压缩')),
      true,
      `expected localized English statusBar updates, got: ${JSON.stringify(enStatusUpdates)}`,
    );
    assert.equal(
      enNotices.at(-1).msg,
      'Complete: 2 total, replaced 1, unknown outcome 1; referenced size reduced by 1.50 MB.',
    );

    const zhInfoLogs = [];
    const zhBatchController = new ImageController(
      {
        plugin: { i18n: zh },
        feedback: { notify(msg, type) { notices.push({ msg, type }); } },
        logger: { info(msg, data) { zhInfoLogs.push({ msg, data }); }, warn() {}, error() {}, debug() {} },
        statusBar: { update(id, text) { statusUpdates.push({ id, text }); }, clear() {} },
      },
      scope,
      mockServices,
      tasks,
    );
    await zhBatchController.compressDocument({ protyle: { block: { rootID, box: 'nb-1' } } }, rootID);
    assert.ok(statusUpdates.length > 0);
    assert.equal(statusUpdates.every(u => u.text.startsWith(`${zh['feature.imageCompressor.title']} `)), true);
    assert.equal(
      notices.at(-1).msg,
      '处理完成：共 2 处，替换 1 处，结果未知 1 处；引用体积减少 1.50 MB。',
    );
    assert.equal(
      zhInfoLogs.some(e => e.data?.sourcePath === 'assets/big.png' && e.data?.reference === 'replaced'),
      true,
      'document batch apply phase must log real replaced reference status via info',
    );
    assert.equal(
      zhInfoLogs.some(e => e.data?.sourcePath === 'assets/uncertain.png' && e.data?.reference === 'unknown'),
      true,
      'document batch apply phase must log real unknown reference status via info',
    );

    // Document batch with total === 1 && succeeded === 1 switches to single-image detailed notice
    globalThis.DOMParser = class {
      parseFromString() {
        return {
          querySelector: () => null,
          querySelectorAll: selector => selector === 'img'
            ? [fakeImg('assets/big.png')]
            : [{ id: blockID }],
        };
      }
    };
    await zhBatchController.compressDocument({ protyle: { block: { rootID, box: 'nb-1' } } }, rootID);
    assert.equal(notices.at(-1).msg, '图片压缩成功：2.00 MB → 512.0 KB（-75.0%）');

    await enController.compressDocument({ protyle: { block: { rootID, box: 'nb-1' } } }, rootID);
    assert.equal(enNotices.at(-1).msg, 'Image compressed: 2.00 MB → 512.0 KB (-75.0%)');
  } finally {
    globalThis.DOMParser = priorDOMParser;
  }

  // Verify ImageController source contracts for dead state removal
  const controllerSrc = await readFile(new URL('../../../src/features/image-compressor/ImageController.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(controllerSrc, /`图片压缩 /);
  assert.doesNotMatch(controllerSrc, /phase:\s*"failed"|messages:/);

  // Verify ImageTaskUI & ImageTaskPanel contracts
  const [taskUiSrc, taskPanelSrc] = await Promise.all([
    readFile(new URL('../../../src/features/image-compressor/ui/ImageTaskUI.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../../src/features/image-compressor/ui/ImageTaskPanel.svelte', import.meta.url), 'utf8'),
  ]);
  assert.match(taskUiSrc, /export type ImageTaskPhase = "preparing" \| "applying" \| "done" \| "partial" \| "unknown";/);
  assert.doesNotMatch(taskUiSrc, /\bmessages:\s*string\[\]/);
  assert.match(taskPanelSrc, /PHASE_TITLE_KEY:\s*Record<ImageTaskPhase,\s*string>/);
  assert.doesNotMatch(taskPanelSrc, /\|\|\s*"当前文件"/);
  assert.doesNotMatch(taskPanelSrc, /<details>|state\.messages/);
  assert.match(taskPanelSrc, /\{:else if state\.phase === "applying"\}\s*<progress max=\{Math\.max\(1, state\.total\)\} value=\{state\.completed\}/);
  assert.match(taskPanelSrc, /<strong>\{state\.unknown\}<\/strong><span>\{t\("task\.unknownItems"\)\}<\/span>/);
  assert.equal(translate(zh, 'task.unknownItems'), '结果未知');
  assert.equal(translate(en, 'task.unknownItems'), 'Unknown');

  scope.dispose();
});
