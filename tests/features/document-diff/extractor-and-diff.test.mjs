import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeBlockParitySignature,
  extractBlockDomUnits,
  parseHtmlFragmentFallback,
} from "../../../src/features/document-diff/model/BlockDomExtractor.ts";
import {
  alignUnits,
  findNearestMatchedBlockID,
  retainHunkCursor,
} from "../../../src/features/document-diff/model/DiffEngine.ts";
import {
  computeInlineDiffRanges,
  verifiedLineSpans,
} from "../../../src/features/document-diff/model/InlineDiff.ts";
import { matchesDiffFilter } from "../../../src/features/document-diff/model/types.ts";
import { canonicalizeAttributeViewData } from "../../../src/features/document-diff/runtime/KernelSnapshot.ts";
import { verifyVisibleParity } from "../../../src/features/document-diff/runtime/VisibleParity.ts";

test("conflict copy with completely rewritten block IDs, volatile attributes, and internal block refs compares as 0 diffs", () => {
  const leftRoot = "20260101000000-rootlft";
  const rightRoot = "20260102000000-rootrgt";

  const leftDOM = `
    <div data-node-id="20260101000001-hd00001" data-type="NodeHeading" data-subtype="h2" updated="20260101" fold="1">
      <div contenteditable="true">第一章</div><div class="protyle-attr" contenteditable="false"></div>
    </div>
    <div data-node-id="20260101000002-para001" data-type="NodeParagraph" parent-heading="20260101000001-hd00001">
      <div contenteditable="true">参见 <span data-type="block-ref" data-id="20260101000001-hd00001" data-subtype="s">第一章</span> 与 <span data-type="a" data-href="siyuan://blocks/${leftRoot}">本文根链接</span></div>
    </div>
  `;

  const rightDOM = `
    <div data-node-id="20260202000009-hd99999" data-type="NodeHeading" data-subtype="h2" updated="20260202">
      <div contenteditable="true">第一章</div><div class="protyle-attr" contenteditable="false"></div>
    </div>
    <div data-node-id="20260202000010-para999" data-type="NodeParagraph">
      <div contenteditable="true">参见 <span data-type="block-ref" data-id="20260202000009-hd99999" data-subtype="s">第一章</span> 与 <span data-type="a" data-href="siyuan://blocks/${rightRoot}">本文根链接</span></div>
    </div>
  `;

  const left = extractBlockDomUnits(leftRoot, leftDOM);
  const right = extractBlockDomUnits(rightRoot, rightDOM);
  const diff = alignUnits(left.units, right.units);

  assert.equal(diff.hunks.length, 0);
  assert.equal(diff.unresolved, false);
  assert.equal(diff.matches.length, 2);
});

test("detects semantic formatting differences: task checkbox, heading level, code language/indent, and external block ref", () => {
  const leftDOM = `
    <div data-node-id="20260101000001-h000001" data-type="NodeHeading" data-subtype="h2"><div contenteditable="true">标题</div></div>
    <div data-node-id="20260101000002-list001" data-type="NodeList" data-subtype="t">
      <div data-node-id="20260101000003-item001" data-type="NodeListItem" data-subtype="t" class="li">
        <div class="protyle-action protyle-action--task"><svg></svg></div>
        <div data-node-id="20260101000004-p000001" data-type="NodeParagraph"><div contenteditable="true">待办事项</div></div>
      </div>
    </div>
    <div data-node-id="20260101000005-code001" data-type="NodeCodeBlock">
      <div class="protyle-action"><span class="protyle-action__language" contenteditable="false">ts</span></div>
      <div class="hljs"><div contenteditable="true">  const x = 1;</div></div>
    </div>
    <div data-node-id="20260101000006-ext0001" data-type="NodeParagraph">
      <div contenteditable="true"><span data-type="block-ref" data-id="20250101000000-extaaaa" data-subtype="s">外部引用</span></div>
    </div>
  `;

  const rightDOM = `
    <div data-node-id="20260202000001-h000002" data-type="NodeHeading" data-subtype="h3"><div contenteditable="true">标题</div></div>
    <div data-node-id="20260202000002-list002" data-type="NodeList" data-subtype="t">
      <div data-node-id="20260202000003-item002" data-type="NodeListItem" data-subtype="t" class="li protyle-task--done">
        <div class="protyle-action protyle-action--task"><svg></svg></div>
        <div data-node-id="20260202000004-p000002" data-type="NodeParagraph"><div contenteditable="true">待办事项</div></div>
      </div>
    </div>
    <div data-node-id="20260202000005-code002" data-type="NodeCodeBlock">
      <div class="protyle-action"><span class="protyle-action__language" contenteditable="false">js</span></div>
      <div class="hljs"><div contenteditable="true">    const x = 1;</div></div>
    </div>
    <div data-node-id="20260202000006-ext0002" data-type="NodeParagraph">
      <div contenteditable="true"><span data-type="block-ref" data-id="20250101000000-extbbbb" data-subtype="s">外部引用</span></div>
    </div>
  `;

  const left = extractBlockDomUnits("20260101000000-rootlft", leftDOM);
  const right = extractBlockDomUnits("20260202000000-rootrgt", rightDOM);
  const diff = alignUnits(left.units, right.units);

  // All 4 consecutive changed units merge into modified hunk(s), zero matches
  assert.equal(diff.matches.length, 0);
  assert.equal(diff.counts.modified, 1);
  assert.equal(diff.hunks[0].left.length, 4);
  assert.equal(diff.hunks[0].right.length, 4);
});

test("ambiguous internal block references and external attribute views are conservatively marked unresolved", () => {
  const makeDoc = (rootID, idPrefix, targetId) => `
    <div data-node-id="20260101000001-${idPrefix}0001" data-type="NodeParagraph"><div contenteditable="true">重复块</div></div>
    <div data-node-id="20260101000002-${idPrefix}0002" data-type="NodeParagraph"><div contenteditable="true">重复块</div></div>
    <div data-node-id="20260101000003-${idPrefix}0003" data-type="NodeParagraph">
      <div contenteditable="true">引用了 <span data-type="block-ref" data-id="${targetId}" data-subtype="s">重复块</span></div>
    </div>
    <div data-node-id="20260101000004-${idPrefix}0004" data-type="NodeAttributeView" data-av-id="20260101000099-av00001"></div>
  `;

  const left = extractBlockDomUnits("20260101000000-rootlft", makeDoc("20260101000000-rootlft", "lft", "20260101000001-lft0001"));
  const right = extractBlockDomUnits("20260102000000-rootrgt", makeDoc("20260102000000-rootrgt", "rgt", "20260101000002-rgt0002"));
  const diff = alignUnits(left.units, right.units);

  // First two identical paragraphs match; ambiguous ref + AttributeView produce unresolved hunk
  assert.equal(diff.matches.length, 2);
  assert.equal(diff.unresolved, true);
  assert.equal(diff.counts.unresolved, 1);
  assert.equal(matchesDiffFilter(diff.hunks[0], "unresolved"), true);
});

test("repeated lines delete only one occurrence and preserve unique-anchor decomposition under small budget", () => {
  const makeUnit = (text, blockID) => ({
    blockID,
    kind: "NodeParagraph",
    context: "",
    text,
    format: "",
    target: "",
    line: 0,
    reliable: true,
  });

  const left = [
    makeUnit("头锚点", "20260101000000-b000001"),
    makeUnit("重复段落", "20260101000000-b000002"),
    makeUnit("重复段落", "20260101000000-b000003"),
    makeUnit("重复段落", "20260101000000-b000004"),
    makeUnit("中锚点", "20260101000000-b000005"),
    makeUnit("尾段落A", "20260101000000-b000006"),
  ];
  const right = [
    makeUnit("头锚点", "20260202000000-c000001"),
    makeUnit("重复段落", "20260202000000-c000002"),
    makeUnit("重复段落", "20260202000000-c000003"),
    makeUnit("中锚点", "20260202000000-c000005"),
    makeUnit("尾段落B", "20260202000000-c000006"),
  ];

  const diff = alignUnits(left, right, { maxCells: 6 });
  assert.equal(diff.counts.removed, 1);
  assert.equal(diff.counts.modified, 1);
  assert.equal(diff.unresolved, false);

  // Check nearest matched block lookup for left-only hunk on right side
  const removedHunk = diff.hunks.find(h => h.kind === "left-only");
  assert.ok(removedHunk);
  const rightContextID = findNearestMatchedBlockID(diff.matches, removedHunk, "right");
  assert.ok(rightContextID);

  // Check cursor retention when first hunk is fixed
  const secondHunk = diff.hunks[1];
  const afterFix = alignUnits(right, right);
  assert.equal(retainHunkCursor(secondHunk, afterFix.hunks), 0);
});

test("computeInlineDiffRanges and verifiedLineSpans handle surrogate pairs and repeated lines accurately", () => {
  const inline = computeInlineDiffRanges("价格 😀 2025 元", "价格 🚀 2026 元");
  assert.equal(inline.leftRanges.length, 2);
  assert.equal(inline.rightRanges.length, 2);
  assert.equal("价格 😀 2025 元".slice(inline.leftRanges[0].start, inline.leftRanges[0].end), "😀");
  assert.equal("价格 🚀 2026 元".slice(inline.rightRanges[0].start, inline.rightRanges[0].end), "🚀");
  assert.equal("价格 😀 2025 元".slice(inline.leftRanges[1].start, inline.leftRanges[1].end), "5");
  assert.equal("价格 🚀 2026 元".slice(inline.rightRanges[1].start, inline.rightRanges[1].end), "6");

  // Repeated identical lines inside a multi-line code block: line 2 must not match line 0!
  const lines = ["same()", "middle()", "same()"];
  const visible = lines.join("\n");
  const spansLine2 = verifiedLineSpans(visible, lines, 2);
  assert.deepEqual(spansLine2, [{ start: 16, end: 22 }]);

  // Mismatched visible text with non-unique single line returns null instead of guessing first index
  assert.equal(verifiedLineSpans("dup dup", ["dup"], 0), null);
  // Accepts single trailing newline injected on `.hljs` code blocks
  assert.deepEqual(verifiedLineSpans(`${visible}\n`, lines, 1), [{ start: 7, end: 15 }]);
});

test("extracts standalone and inline images, Mermaid/ECharts render code blocks, HTML, media, query embeds, AttributeViews, tabs, and mindmaps", () => {
  const leftRoot = "20260301000000-rootlft";
  const rightRoot = "20260302000000-rootrgt";

  const avSigSame = canonicalizeAttributeViewData({
    id: "20260301000099-avleft1",
    name: "任务表",
    keyIDs: ["k-title", "k-status"],
    keyValues: [
      {
        key: { id: "k-title", name: "标题", type: "block" },
        values: [{ id: "v1", keyID: "k-title", blockID: "row1", createdAt: 1, updatedAt: 2, block: { id: "b-left", content: "里程碑A" } }],
      },
      {
        key: { id: "k-status", name: "状态", type: "select", options: [{ name: "进行中", color: "1" }] },
        values: [{ id: "v2", keyID: "k-status", blockID: "row1", mSelect: [{ content: "进行中", color: "1" }] }],
      },
    ],
    views: [{ id: "view-left", name: "默认表格", type: "table", sorts: [{ column: "k-status", order: 0 }] }],
  });

  const avSigCopiedSameContent = canonicalizeAttributeViewData({
    id: "20260302000099-avrght2",
    name: "任务表",
    keyIDs: ["col-new-1", "col-new-2"],
    keyValues: [
      {
        key: { id: "col-new-1", name: "标题", type: "block" },
        values: [{ id: "v9", keyID: "col-new-1", blockID: "row9", createdAt: 99, updatedAt: 100, block: { id: "b-right", content: "里程碑A" } }],
      },
      {
        key: { id: "col-new-2", name: "状态", type: "select", options: [{ name: "进行中", color: "1" }] },
        values: [{ id: "v8", keyID: "col-new-2", blockID: "row9", mSelect: [{ content: "进行中", color: "1" }] }],
      },
    ],
    views: [{ id: "view-right", name: "默认表格", type: "table", sorts: [{ column: "col-new-2", order: 0 }] }],
  });
  assert.equal(avSigSame, avSigCopiedSameContent);

  const buildRichDoc = ({
    anchorID,
    imgSrc,
    imgTitleAttr,
    mermaidCode,
    videoSrc,
    htmlContent,
    avID,
    mindmapDoneClass,
    tabTitle,
    tabsActiveID,
  }) => `
    <div data-node-id="${anchorID}" data-type="NodeHeading" data-subtype="h2" custom-avs="av1" av-names="任务表" custom-sy-av-s-text-av1="缓存">
      <div contenteditable="true">章节锚点</div>
    </div>
    <div data-node-id="20260301000002-imgblk1" data-type="NodeParagraph">
      <div contenteditable="true"><span contenteditable="false" data-type="img" class="img" style="width: 320px;"><span> </span><span><img src="${imgSrc}" data-src="${imgSrc}" alt="架构图" ${imgTitleAttr} /></span><span> </span></span></div>
    </div>
    <div data-node-id="20260301000003-merm001" data-type="NodeCodeBlock" class="render-node" data-subtype="mermaid" data-content="${mermaidCode}">
      <div contenteditable="false"><svg></svg></div>
    </div>
    <div data-node-id="20260301000004-vid0001" data-type="NodeVideo">
      <div class="iframe-content" style="width: 480px;"><video src="${videoSrc}" data-src="${videoSrc}" poster="assets/cover.png"></video></div>
    </div>
    <div data-node-id="20260301000005-html001" data-type="NodeHTMLBlock">
      <div><protyle-html data-content="${htmlContent}"></protyle-html></div>
    </div>
    <div data-node-id="20260301000006-qemb001" data-type="NodeBlockQueryEmbed" data-content="SELECT * FROM blocks WHERE parent_id = '${anchorID}'">
      <div class="protyle-wysiwyg__embed"><div data-node-id="20260301999999-embchild" data-type="NodeParagraph"><div contenteditable="true">嵌入预览缓存忽略</div></div></div>
    </div>
    <div data-node-id="20260301000007-avblk01" data-type="NodeAttributeView" data-av-id="${avID}" data-av-type="table"></div>
    <div data-node-id="20260301000008-mm00001" data-type="NodeMindmap">
      <div data-node-id="20260301000009-mmi0001" data-type="NodeMindmapItem" data-subtype="t" class="${mindmapDoneClass}">
        <div data-node-id="20260301000010-mmp0001" data-type="NodeParagraph"><div contenteditable="true">脑图节点</div></div>
      </div>
    </div>
    <div data-node-id="20260301000011-tabs001" data-type="NodeTabs" data-active="${tabsActiveID}">
      <div data-node-id="20260301000012-tabi001" data-type="NodeTabItem">
        <div class="tab-item-info"><span class="tab-item-title callout-title" contenteditable="true">${tabTitle}</span></div>
        <div class="tab-item-content">
          <div data-node-id="20260301000013-tabp001" data-type="NodeParagraph"><div contenteditable="true">页签正文</div></div>
        </div>
      </div>
    </div>
  `;

  // 1. Identical semantic content (even with `title` vs `data-title`, remapped internal query ID, different `data-active`, and copied AV) => 0 diffs!
  const leftIdentical = extractBlockDomUnits(
    leftRoot,
    buildRichDoc({
      anchorID: "20260301000001-ancleft",
      imgSrc: "assets/arch-v1.png",
      imgTitleAttr: 'title="图注"',
      mermaidCode: "flowchart LR\n  A --> B",
      videoSrc: "assets/demo-v1.mp4",
      htmlContent: "<div>卡片A</div>",
      avID: "20260301000099-avleft1",
      mindmapDoneClass: "li",
      tabTitle: "概览",
      tabsActiveID: "20260301000012-tabi001",
    }),
    { avSignatures: new Map([["20260301000099-avleft1", avSigSame]]) },
  );

  const rightIdentical = extractBlockDomUnits(
    rightRoot,
    buildRichDoc({
      anchorID: "20260302000001-ancrght",
      imgSrc: "assets/arch-v1.png",
      imgTitleAttr: 'data-title="图注"',
      mermaidCode: "flowchart LR\n  A --> B",
      videoSrc: "assets/demo-v1.mp4",
      htmlContent: "<div>卡片A</div>",
      avID: "20260302000099-avrght2",
      mindmapDoneClass: "li",
      tabTitle: "概览",
      tabsActiveID: "20260302999999-otherid",
    }),
    { avSignatures: new Map([["20260302000099-avrght2", avSigCopiedSameContent]]) },
  );

  const zeroDiff = alignUnits(leftIdentical.units, rightIdentical.units);
  assert.equal(zeroDiff.hunks.length, 0);
  assert.equal(zeroDiff.unresolved, false);

  // 2. Modify image `data-src`, Mermaid arrow, video file, HTML content, AV cell, mindmap checkbox, and tab title => all detected deterministically!
  const avSigChanged = canonicalizeAttributeViewData({
    id: "20260302000099-avrght2",
    name: "任务表",
    keyIDs: ["col-new-1"],
    keyValues: [
      {
        key: { id: "col-new-1", name: "标题", type: "block" },
        values: [{ id: "v9", keyID: "col-new-1", blockID: "row9", block: { id: "b-right", content: "里程碑B（已改）" } }],
      },
    ],
    views: [],
  });

  const rightModified = extractBlockDomUnits(
    rightRoot,
    buildRichDoc({
      anchorID: "20260302000001-ancrght",
      imgSrc: "assets/arch-v2.png",
      imgTitleAttr: 'data-title="图注"',
      mermaidCode: "flowchart LR\n  A --> C",
      videoSrc: "assets/demo-v2.mp4",
      htmlContent: "<div>卡片B</div>",
      avID: "20260302000099-avrght2",
      mindmapDoneClass: "li protyle-task--done",
      tabTitle: "详情",
      tabsActiveID: "20260302999999-otherid",
    }),
    { avSignatures: new Map([["20260302000099-avrght2", avSigChanged]]) },
  );

  const modDiff = alignUnits(leftIdentical.units, rightModified.units);
  assert.equal(modDiff.unresolved, false);
  // Anchor heading, Mermaid line 0 ("flowchart LR"), and normalized QueryEmbed match, separating the modified blocks into 3 hunks!
  assert.equal(modDiff.counts.modified, 3);
  assert.ok(modDiff.hunks.flatMap(h => h.right).some(u => u.format.includes("assets/arch-v2.png")));
  assert.ok(modDiff.hunks.flatMap(h => h.right).some(u => u.kind === "NodeCodeBlock" && u.text === "  A --> C"));
  assert.ok(modDiff.hunks.flatMap(h => h.right).some(u => u.kind === "NodeVideo" && u.text === "assets/demo-v2.mp4"));
  assert.ok(modDiff.hunks.flatMap(h => h.right).some(u => u.kind === "NodeHTMLBlock" && u.text === "<div>卡片B</div>"));
  assert.ok(modDiff.hunks.flatMap(h => h.right).some(u => u.kind === "NodeAttributeView"));
});

test("normalizes live Protyle decorations (hljs line numbers, trailing newline, inline-math cursor newline, word joiners, virtual-block-ref, untitled doc) in parity checks", () => {
  const docID = "20260401000000-doc0001";
  const kernelHtml = `
    <div data-node-id="20260401000001-code001" data-type="NodeCodeBlock" class="code-block">
      <div class="protyle-action"><span class="protyle-action__language">ts</span></div>
      <div class="hljs"><div contenteditable="true">const a = 1;\nconst b = 2;</div></div>
    </div>
    <div data-node-id="20260401000002-para001" data-type="NodeParagraph">
      <div contenteditable="true">前置文本 <code>x</code> 与公式 <span contenteditable="false" data-type="inline-math" data-content="E=mc^2"></span></div>
    </div>
  `;

  const liveHtml = `
    <div data-node-id="20260401000001-code001" data-type="NodeCodeBlock" class="code-block" style="line-height: 22px; display: block;">
      <div class="protyle-action"><span class="protyle-action__language">ts</span></div>
      <div class="hljs"><div class="protyle-linenumber__rows" contenteditable="false"><span></span><span></span></div><div contenteditable="true">const a = 1;\nconst b = 2;\n</div></div>
    </div>
    <div data-node-id="20260401000002-para001" data-type="NodeParagraph">
      <div contenteditable="true"><span data-type="virtual-block-ref">前置文本</span> \u2060<code>x</code>\u200B 与公式 <span contenteditable="false" data-type="inline-math" data-content="E=mc^2"><span class="katex">E=mc2</span></span>\n</div>
    </div>
  `;

  const extracted = extractBlockDomUnits(docID, kernelHtml);
  const liveRoot = parseHtmlFragmentFallback(liveHtml);
  const liveBlocks = [liveRoot.children[0], liveRoot.children[1]];

  for (const liveBlock of liveBlocks) {
    const id = liveBlock.getAttribute("data-node-id");
    assert.equal(computeBlockParitySignature(liveBlock, liveRoot), extracted.parityByBlockID.get(id));
  }

  // Verify untitled document (`titleEmpty: true`, kernel returns "Untitled", live title editor is "")
  const mockLiveView = {
    block: { rootID: docID },
    title: { getText: () => "" },
    wysiwyg: {
      element: {
        querySelectorAll: () => [],
      },
    },
  };
  assert.equal(
    verifyVisibleParity(mockLiveView, {
      id: docID,
      title: "Untitled",
      titleEmpty: true,
      notebook: "box1",
      units: [],
      parityByBlockID: new Map(),
      rootBlockIndexByBlockID: new Map(),
      rootBlockIDs: [],
    }),
    true,
  );
});

test("detects inline image or inline formula position moves within the same text line and rejects null AttributeView data", () => {
  const docID = "20260402000000-docpos1";
  const imgBefore = `
    <div data-node-id="20260402000001-p111111" data-type="NodeParagraph">
      <div contenteditable="true">甲<span contenteditable="false" data-type="img" class="img"><img src="assets/a.png" data-src="assets/a.png" alt="图" /></span>乙</div>
    </div>
  `;
  const imgAfter = `
    <div data-node-id="20260402000002-p222222" data-type="NodeParagraph">
      <div contenteditable="true">甲乙<span contenteditable="false" data-type="img" class="img"><img src="assets/a.png" data-src="assets/a.png" alt="图" /></span></div>
    </div>
  `;
  const mathBefore = `
    <div data-node-id="20260402000003-m111111" data-type="NodeParagraph">
      <div contenteditable="true">甲<span contenteditable="false" data-type="inline-math" data-content="x+1"></span>乙</div>
    </div>
  `;
  const mathAfter = `
    <div data-node-id="20260402000004-m222222" data-type="NodeParagraph">
      <div contenteditable="true">甲乙<span contenteditable="false" data-type="inline-math" data-content="x+1"></span></div>
    </div>
  `;

  const extImgBefore = extractBlockDomUnits(docID, imgBefore);
  const extImgAfter = extractBlockDomUnits(docID, imgAfter);
  assert.equal(alignUnits(extImgBefore.units, extImgAfter.units).counts.modified, 1);

  const extMathBefore = extractBlockDomUnits(docID, mathBefore);
  const extMathAfter = extractBlockDomUnits(docID, mathAfter);
  assert.equal(alignUnits(extMathBefore.units, extMathAfter.units).counts.modified, 1);

  // Null or empty payload without `keyValues` / `views` must return undefined so the block becomes `unresolved`
  assert.equal(canonicalizeAttributeViewData(null), undefined);
  assert.equal(canonicalizeAttributeViewData({}), undefined);
  assert.equal(canonicalizeAttributeViewData({ av: null }), undefined);
});
