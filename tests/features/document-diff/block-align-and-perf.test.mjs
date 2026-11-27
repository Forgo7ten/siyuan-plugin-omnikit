import { test } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { extractBlockDomUnits } from "../../../src/features/document-diff/model/BlockDomExtractor.ts";
import {
  emitDenseBlockDP,
  emitSparseBlockFenwickDP,
} from "../../../src/features/document-diff/model/blockAlign.ts";
import { mapBlockAcrossDiff } from "../../../src/features/document-diff/model/blockMapping.ts";
import { buildBlockGroups } from "../../../src/features/document-diff/model/blockSimilarity.ts";
import { alignUnits } from "../../../src/features/document-diff/model/DiffEngine.ts";
import { semanticKey } from "../../../src/features/document-diff/model/types.ts";
import { DiffPainter } from "../../../src/features/document-diff/runtime/DiffPainter.ts";

class LiteMockText {
  constructor(data) {
    this.nodeType = 3;
    this.data = String(data);
    this.parentElement = null;
  }
  get textContent() {
    return this.data;
  }
}

class LiteMockElement {
  constructor(tagName = "DIV", attrs = {}) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.attrs = new Map(Object.entries(attrs).map(([k, v]) => [k.toLowerCase(), String(v)]));
    this.childNodes = [];
    this.parentElement = null;
    this.isConnected = true;
    this._rect = { left: 0, top: 0, right: 500, bottom: 300, width: 500, height: 300 };
    const styleStore = {};
    this.style = new Proxy(styleStore, {
      get(target, prop) {
        if (prop === "setProperty") {
          return (k, v) => {
            target[k] = v;
          };
        }
        return target[prop] ?? "";
      },
      set(target, prop, value) {
        target[prop] = value;
        return true;
      },
    });
  }

  get children() {
    return this.childNodes.filter(n => n.nodeType === 1);
  }

  get className() {
    return this.attrs.get("class") ?? "";
  }

  set className(val) {
    this.attrs.set("class", String(val));
  }

  get textContent() {
    return this.childNodes.map(c => c.textContent ?? "").join("");
  }

  set textContent(val) {
    this.childNodes = val ? [new LiteMockText(String(val))] : [];
    for (const c of this.childNodes) c.parentElement = this;
  }

  hasAttribute(name) {
    return this.attrs.has(name.toLowerCase());
  }

  getAttribute(name) {
    return this.attrs.get(name.toLowerCase()) ?? null;
  }

  setAttribute(name, val) {
    this.attrs.set(name.toLowerCase(), String(val));
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node.parentElement) node.remove?.();
      node.parentElement = this;
      node.isConnected = this.isConnected;
      this.childNodes.push(node);
    }
  }

  replaceChildren(...nodes) {
    this.childNodes = [];
    this.append(...nodes);
  }

  remove() {
    if (this.parentElement) {
      const idx = this.parentElement.childNodes.indexOf(this);
      if (idx >= 0) this.parentElement.childNodes.splice(idx, 1);
      this.parentElement = null;
    }
    this.isConnected = false;
  }

  matches(selector) {
    for (const raw of selector.split(",")) {
      const s = raw.trim();
      if (!s) continue;
      if (s.startsWith(".") && (this.attrs.get("class") ?? "").split(/\s+/).includes(s.slice(1))) {
        return true;
      }
      const exact = /^\[([a-zA-Z0-9_-]+)="([^"]+)"\]$/.exec(s);
      if (exact && this.getAttribute(exact[1]) === exact[2]) return true;
      const word = /^\[([a-zA-Z0-9_-]+)~="([^"]+)"\]$/.exec(s);
      if (word && (this.getAttribute(word[1]) ?? "").split(/\s+/).includes(word[2])) return true;
      if (this.tagName === s.toUpperCase()) return true;
    }
    return false;
  }

  closest(selector) {
    let cur = this;
    while (cur) {
      if (cur.matches?.(selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  querySelectorAll(selector) {
    const out = [];
    const walk = el => {
      for (const child of el.children) {
        if (child.matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }

  getBoundingClientRect() {
    return this._rect;
  }
}

function readRangeText(range) {
  const { startContainer, startOffset, endContainer, endOffset } = range;
  if (startContainer === endContainer) {
    return startContainer.data.slice(startOffset, endOffset);
  }
  let root = startContainer;
  while (root.parentElement) root = root.parentElement;
  const textNodes = [];
  const walk = n => {
    if (n.nodeType === 3) textNodes.push(n);
    else for (const c of n.childNodes ?? []) walk(c);
  };
  walk(root);
  let collecting = false;
  let result = "";
  for (const tn of textNodes) {
    if (tn === startContainer) {
      collecting = true;
      result += tn.data.slice(startOffset);
    } else if (tn === endContainer) {
      result += tn.data.slice(0, endOffset);
      break;
    } else if (collecting) {
      result += tn.data;
    }
  }
  return result;
}

function withHighlightDomEnv(fn) {
  const prevDoc = globalThis.document;
  const prevNode = globalThis.Node;
  const prevCSS = globalThis.CSS;
  const prevHighlight = globalThis.Highlight;

  const registry = new Map();
  globalThis.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
  globalThis.Highlight = class MockHighlight {
    constructor() {
      this.ranges = [];
    }
    add(r) {
      this.ranges.push(r);
    }
    clear() {
      this.ranges.length = 0;
    }
  };
  globalThis.CSS = { highlights: registry };
  globalThis.document = {
    createElement: tag => new LiteMockElement(tag),
    createRange() {
      return {
        startContainer: null,
        startOffset: 0,
        endContainer: null,
        endOffset: 0,
        setStart(node, offset) {
          this.startContainer = node;
          this.startOffset = offset;
        },
        setEnd(node, offset) {
          this.endContainer = node;
          this.endOffset = offset;
        },
      };
    },
  };

  try {
    return fn(registry);
  } finally {
    globalThis.document = prevDoc;
    globalThis.Node = prevNode;
    globalThis.CSS = prevCSS;
    globalThis.Highlight = prevHighlight;
  }
}

function makeBlockID(prefix, idx) {
  return `20260701000000-${prefix}${String(idx).padStart(6, "0")}`;
}

function escapeHtml(raw) {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildCodeBlockHtml(id, lang, code) {
  return `<div data-node-id="${id}" data-type="NodeCodeBlock"><div class="protyle-action"><span class="protyle-action__language">${escapeHtml(lang)}</span></div><div class="hljs"><div contenteditable="true">${escapeHtml(code)}\n</div></div></div>`;
}

function buildLiveCodeBlock(id, lang, code, top = 20, height = 180) {
  const block = new LiteMockElement("DIV", { "data-node-id": id, "data-type": "NodeCodeBlock", class: "code-block" });
  block._rect = { left: 16, top, right: 480, bottom: top + height, width: 464, height };
  const action = new LiteMockElement("DIV", { class: "protyle-action" });
  const langSpan = new LiteMockElement("SPAN", { class: "protyle-action__language", contenteditable: "false" });
  langSpan.textContent = lang;
  action.append(langSpan);
  const hljs = new LiteMockElement("DIV", { class: "hljs" });
  const editable = new LiteMockElement("DIV", { contenteditable: "true" });
  editable.textContent = `${code}\n`;
  hljs.append(editable);
  block.append(action, hljs);
  return block;
}

function buildPaintableProtyle(blocks) {
  const root = new LiteMockElement("DIV", { class: "protyle" });
  root._rect = { left: 0, top: 0, right: 500, bottom: 2000, width: 500, height: 2000 };
  const content = new LiteMockElement("DIV", { class: "protyle-content" });
  content._rect = root._rect;
  const wysiwyg = new LiteMockElement("DIV", { class: "protyle-wysiwyg" });
  wysiwyg.append(...blocks);
  content.append(wysiwyg);
  root.append(content);
  return {
    element: root,
    contentElement: content,
    wysiwyg: { element: wysiwyg },
  };
}

function inspectPaintedSide(protyle, registry) {
  const overlay = protyle.element.children.find(c => c.className === "omnikit-document-diff-overlay");
  const boxes = (overlay?.children ?? []).map(box => ({
    borderInlineStart: box.style.borderInlineStart,
    backgroundColor: box.style["background-color"] || box.style.backgroundColor || "",
    top: box.style.top,
  }));
  let ranges = [];
  for (const [, hl] of registry) {
    if (hl.ranges.length > 0) {
      ranges = hl.ranges.map(readRangeText);
    }
  }
  return { boxes, ranges };
}

test("7-line and 80-line code variable renames (old -> record) and SQL alias renames (u -> acct) pair as modified in both 1v1 and 2v2 gaps with exact token highlights", () => {
  const build7LineCode = varName => [
    `const ${varName} = await repository.loadAccount(accountId);`,
    `if (!${varName} || ${varName}.archived) {`,
    `  throw new Error("Account unavailable: " + accountId);`,
    `}`,
    `${varName}.lastVisitedAt = clock.nowIsoString();`,
    `await repository.saveAccount(${varName});`,
    `return ${varName}.profileSummary;`,
  ].join("\n");

  const build80LineCode = varName => {
    const lines = [
      `export async function syncAccountLedger(accountId: string, batchId: number) {`,
      `  const ${varName} = await ledgerStore.fetchSnapshot(accountId);`,
      `  if (!${varName}) return { synced: false, batchId };`,
    ];
    for (let step = 1; step <= 25; step++) {
      lines.push(`  // Validate stage ${step} invariants before committing`);
      lines.push(`  if (${varName}.balanceCents >= ${step * 100}) {`);
      lines.push(`    ${varName}.auditTrail.push("stage-${step}:" + batchId);`);
    }
    lines.push(`  await ledgerStore.persistSnapshot(${varName});`);
    lines.push(`  return { synced: true, version: ${varName}.version };`);
    return lines.join("\n");
  };

  assert.equal(build80LineCode("old").split("\n").length, 80);

  const buildSqlAliasQuery = alias => [
    `SELECT ${alias}.id, ${alias}.username, ${alias}.email, ${alias}.role_code`,
    `FROM accounts ${alias}`,
    `INNER JOIN organizations org ON org.id = ${alias}.org_id`,
    `WHERE ${alias}.tenant_key = :tenantKey`,
    `  AND ${alias}.deleted_at IS NULL`,
    `ORDER BY ${alias}.created_at DESC`,
    `LIMIT 100;`,
  ].join("\n");

  // 1. Isolated 1 vs 1 for 7-line TS code rename + DiffPainter token highlight verification
  const id7L = makeBlockID("l", 1);
  const id7R = makeBlockID("r", 1);
  const code7Left = build7LineCode("old");
  const code7Right = build7LineCode("record");
  const ext7L = extractBlockDomUnits(makeBlockID("l", 0), buildCodeBlockHtml(id7L, "ts", code7Left));
  const ext7R = extractBlockDomUnits(makeBlockID("r", 0), buildCodeBlockHtml(id7R, "ts", code7Right));
  const diff7 = alignUnits(ext7L.units, ext7R.units);

  assert.equal(diff7.counts.removed, 0);
  assert.equal(diff7.counts.added, 0);
  assert.ok(diff7.counts.modified >= 1);
  assert.ok(diff7.hunks.every(h => h.kind === "modified"));

  withHighlightDomEnv(registry => {
    const leftProtyle = buildPaintableProtyle([buildLiveCodeBlock(id7L, "ts", code7Left, 20, 160)]);
    const leftPainter = new DiffPainter(leftProtyle, "left");
    leftPainter.paint(diff7, ext7L.units);
    const leftVis = inspectPaintedSide(leftProtyle, registry);
    assert.equal(leftVis.boxes.length, 1);
    assert.equal(leftVis.boxes[0].backgroundColor, "", "Must not whole-block fill renamed 7-line code block");
    // Note: "old" and "record" share 'o' and 'd' in order, so character-level LCS highlights ONLY the changed
    // characters inside the identifier ("l" on left, "rec"/"r" on right) and NEVER touches surrounding code!
    assert.ok(leftVis.ranges.length >= 6);
    assert.ok(leftVis.ranges.every(tok => "old".includes(tok) && tok.length > 0));
    leftPainter.dispose();

    const rightProtyle = buildPaintableProtyle([buildLiveCodeBlock(id7R, "ts", code7Right, 20, 160)]);
    const rightPainter = new DiffPainter(rightProtyle, "right");
    rightPainter.paint(diff7, ext7R.units);
    const rightVis = inspectPaintedSide(rightProtyle, registry);
    assert.equal(rightVis.boxes.length, 1);
    assert.equal(rightVis.boxes[0].backgroundColor, "");
    assert.ok(rightVis.ranges.length >= 6);
    assert.ok(rightVis.ranges.every(tok => "record".includes(tok) && tok.length > 0));
    rightPainter.dispose();
  });

  // 2. Adjacent 2 vs 2 rewritten blocks (80-line TS variable rename + SQL table alias u -> acct) without anchor between them
  const id80L = makeBlockID("l", 10);
  const idSqlL = makeBlockID("l", 11);
  const id80R = makeBlockID("r", 10);
  const idSqlR = makeBlockID("r", 11);
  const code80Left = build80LineCode("old");
  const code80Right = build80LineCode("record");
  const sqlLeft = buildSqlAliasQuery("u");
  const sqlRight = buildSqlAliasQuery("acct");

  const html2v2Left = buildCodeBlockHtml(id80L, "ts", code80Left) + buildCodeBlockHtml(idSqlL, "sql", sqlLeft);
  const html2v2Right = buildCodeBlockHtml(id80R, "ts", code80Right) + buildCodeBlockHtml(idSqlR, "sql", sqlRight);
  const ext2v2L = extractBlockDomUnits(makeBlockID("l", 0), html2v2Left);
  const ext2v2R = extractBlockDomUnits(makeBlockID("r", 0), html2v2Right);
  const diff2v2 = alignUnits(ext2v2L.units, ext2v2R.units);

  assert.equal(diff2v2.counts.removed, 0, "2 vs 2 adjacent renamed code blocks must not degrade to left-only");
  assert.equal(diff2v2.counts.added, 0, "2 vs 2 adjacent renamed code blocks must not degrade to right-only");
  assert.ok(diff2v2.counts.modified >= 1);
  assert.ok(diff2v2.hunks.every(h => h.kind === "modified"));

  withHighlightDomEnv(registry => {
    const rightProtyle = buildPaintableProtyle([
      buildLiveCodeBlock(id80R, "ts", code80Right, 20, 600),
      buildLiveCodeBlock(idSqlR, "sql", sqlRight, 640, 180),
    ]);
    const rightPainter = new DiffPainter(rightProtyle, "right");
    rightPainter.paint(diff2v2, ext2v2R.units);
    const rightVis = inspectPaintedSide(rightProtyle, registry);
    assert.equal(rightVis.boxes.length, 2);
    assert.equal(rightVis.boxes[0].backgroundColor, "", "80-line renamed block uses 3px bar without fill");
    assert.equal(rightVis.boxes[1].backgroundColor, "", "SQL alias renamed block uses 3px bar without fill");
    assert.ok(rightVis.ranges.includes("acct"), "SQL alias `acct` is highlighted at token level");
    rightPainter.dispose();
  });
});

test("upfront anchor splitting isolates 1v1 same-language rewrites as modified while rejecting incompatible code languages", () => {
  const tsDocLeft = [
    buildCodeBlockHtml(makeBlockID("l", 1), "ts", "export function alpha(x: number) {\n  return x * 2;\n}"),
    `<div data-node-id="${makeBlockID("l", 2)}" data-type="NodeHeading" data-subtype="h2"><div contenteditable="true">核心处理流水线</div></div>`,
    buildCodeBlockHtml(makeBlockID("l", 3), "ts", "export function beta(items: string[]) {\n  return items.filter(Boolean);\n}"),
  ].join("\n");

  const tsDocRight = [
    buildCodeBlockHtml(makeBlockID("r", 1), "ts", "const DEFAULT_TIMEOUT = 3000;\nclass RetryQueue {\n  clear() {}\n}"),
    `<div data-node-id="${makeBlockID("r", 2)}" data-type="NodeHeading" data-subtype="h2"><div contenteditable="true">核心处理流水线</div></div>`,
    buildCodeBlockHtml(makeBlockID("r", 3), "ts", "interface MetricsCollector {\n  recordLatency(ms: number): void;\n}"),
  ].join("\n");

  const tsL = extractBlockDomUnits(makeBlockID("l", 0), tsDocLeft);
  const tsR = extractBlockDomUnits(makeBlockID("r", 0), tsDocRight);
  const tsDiff = alignUnits(tsL.units, tsR.units);

  // Heading splits the document into two isolated 1v1 same-language (`ts`) slots -> 2 `modified` hunks!
  assert.ok(tsDiff.matches.some(m => m.leftBlockID === makeBlockID("l", 2)));
  assert.equal(tsDiff.counts.modified, 2);
  assert.equal(tsDiff.counts.removed, 0);
  assert.equal(tsDiff.counts.added, 0);

  // Cross-language 1v1 slots (`python` vs `sql`) around the same heading must NOT pair as `modified`!
  const crossLangLeft = [
    buildCodeBlockHtml(makeBlockID("l", 10), "python", "def compute_checksum(payload: bytes) -> str:\n    return hashlib.sha256(payload).hexdigest()"),
    `<div data-node-id="${makeBlockID("l", 11)}" data-type="NodeHeading" data-subtype="h2"><div contenteditable="true">相同章节标题</div></div>`,
    buildCodeBlockHtml(makeBlockID("l", 12), "python", "for item in pending_tasks:\n    dispatch_worker(item)"),
  ].join("\n");

  const crossLangRight = [
    buildCodeBlockHtml(makeBlockID("r", 10), "sql", "CREATE INDEX idx_orders_created ON orders (created_at DESC);"),
    `<div data-node-id="${makeBlockID("r", 11)}" data-type="NodeHeading" data-subtype="h2"><div contenteditable="true">相同章节标题</div></div>`,
    buildCodeBlockHtml(makeBlockID("r", 12), "sql", "DELETE FROM expired_sessions WHERE expires_at < CURRENT_TIMESTAMP;"),
  ].join("\n");

  const crossL = extractBlockDomUnits(makeBlockID("l", 0), crossLangLeft);
  const crossR = extractBlockDomUnits(makeBlockID("r", 0), crossLangRight);
  const crossDiff = alignUnits(crossL.units, crossR.units);

  assert.equal(crossDiff.matches.length, 1);
  assert.equal(crossDiff.counts.modified, 0, "Unrelated python vs sql blocks must not pair as modified");
  assert.equal(crossDiff.counts.removed, 2);
  assert.equal(crossDiff.counts.added, 2);
});

test("prevents false-positive pairing of unrelated Java CRUD methods and readSerializable vs PUser in multi-block intervals", () => {
  const getUserByIdCode = [
    "public UserProfile findUserById(Long userId) {",
    "    if (userId == null || userId <= 0L) {",
    "        return null;",
    "    }",
    "    return userMapper.selectProfileByPrimaryKey(userId);",
    "}",
  ].join("\n");

  const recordAuditLogCode = [
    "public void appendLoginAudit(String ipAddress, long timestampMs) {",
    "    AuditEntry entry = new AuditEntry(ipAddress, timestampMs);",
    "    auditQueue.offer(entry);",
    "}",
  ].join("\n");

  const deleteOrderByCode = [
    "public void deleteOrderByCode(String orderCode) {",
    "    OrderEntity order = orderRepository.findByUniqueCode(orderCode);",
    "    if (order != null) {",
    "        orderRepository.markRemoved(order.getOrderNumber());",
    "    }",
    "}",
  ].join("\n");

  const calculateTaxCode = [
    "public BigDecimal computeRegionalVat(BigDecimal subtotal, BigDecimal rate) {",
    "    return subtotal.multiply(rate).setScale(2, RoundingMode.HALF_UP);",
    "}",
  ].join("\n");

  const crudLeftHtml =
    buildCodeBlockHtml(makeBlockID("l", 1), "java", getUserByIdCode) +
    buildCodeBlockHtml(makeBlockID("l", 2), "java", recordAuditLogCode);
  const crudRightHtml =
    buildCodeBlockHtml(makeBlockID("r", 1), "java", deleteOrderByCode) +
    buildCodeBlockHtml(makeBlockID("r", 2), "java", calculateTaxCode);

  const crudL = extractBlockDomUnits(makeBlockID("l", 0), crudLeftHtml);
  const crudR = extractBlockDomUnits(makeBlockID("r", 0), crudRightHtml);
  const crudDiff = alignUnits(crudL.units, crudR.units);

  assert.equal(crudDiff.counts.modified, 0, "Unrelated Java CRUD methods in 2v2 interval must not pair as modified");
  assert.equal(crudDiff.counts.removed, 1);
  assert.equal(crudDiff.counts.added, 1);

  // Also verify multi-block `readSerializable` vs `PUser` without matching counterpart stays unpaired
  const readSerCode = [
    "private final Serializable readSerializable(final ClassLoader loader) {",
    "    ObjectInputStream ois = new ObjectInputStream(bais) {",
    "        protected Class<?> resolveClass() {",
    "            return null;",
    "        }",
    "    };",
    "    if (name == null) {",
    "        return null;",
    "    }",
    "}",
  ].join("\n");

  const pUserCode = [
    "public class PUser implements Parcelable {",
    "    public PUser createFromParcel(Parcel in) {",
    "        return new PUser(in);",
    "    }",
    "    public PUser() {",
    "    }",
    "}",
  ].join("\n");

  const serLeft = extractBlockDomUnits(
    makeBlockID("l", 0),
    buildCodeBlockHtml(makeBlockID("l", 20), "java", readSerCode) +
      buildCodeBlockHtml(makeBlockID("l", 21), "java", getUserByIdCode),
  );
  const pUserRight = extractBlockDomUnits(
    makeBlockID("r", 0),
    buildCodeBlockHtml(makeBlockID("r", 20), "java", pUserCode) +
      buildCodeBlockHtml(makeBlockID("r", 21), "java", deleteOrderByCode),
  );
  const serDiff = alignUnits(serLeft.units, pUserRight.units);
  assert.equal(serDiff.counts.modified, 0, "readSerializable vs PUser must never mis-pair as modified");
  assert.equal(serDiff.counts.removed, 1);
  assert.equal(serDiff.counts.added, 1);
});

function assertStrictMonotoneBlockSteps(steps, leftLen, rightLen) {
  let prevLeft = -1;
  let prevRight = -1;
  const pairedLeft = new Set();
  const pairedRight = new Set();
  const seenLeft = [];
  const seenRight = [];

  for (const step of steps) {
    if (step.type === "equal-block" || step.type === "paired-block") {
      assert.ok(step.leftBlock > prevLeft, `Left index not strictly increasing: ${step.leftBlock} <= ${prevLeft}`);
      assert.ok(step.rightBlock > prevRight, `Right index not strictly increasing: ${step.rightBlock} <= ${prevRight}`);
      assert.equal(pairedLeft.has(step.leftBlock), false);
      assert.equal(pairedRight.has(step.rightBlock), false);
      pairedLeft.add(step.leftBlock);
      pairedRight.add(step.rightBlock);
      prevLeft = step.leftBlock;
      prevRight = step.rightBlock;
      seenLeft.push(step.leftBlock);
      seenRight.push(step.rightBlock);
    } else if (step.type === "left-block") {
      seenLeft.push(step.leftBlock);
    } else if (step.type === "right-block") {
      seenRight.push(step.rightBlock);
    }
  }

  assert.equal(seenLeft.length, leftLen);
  assert.equal(seenRight.length, rightLen);
  for (let i = 0; i < leftLen; i++) assert.equal(seenLeft[i], i);
  for (let j = 0; j < rightLen; j++) assert.equal(seenRight[j], j);
}

test("emitDenseBlockDP and emitSparseBlockFenwickDP produce identical strictly monotone pairings across offsets, repeated blocks, and edits", () => {
  const makeParaUnit = (id, text, kind = "NodeParagraph", format = "") => ({
    blockID: id,
    kind,
    context: "",
    text,
    format,
    target: "",
    line: 0,
    reliable: true,
  });

  // Case 1: Contiguous repeated blocks (`A, A, A` vs `A, A`) + local edit + front insertion offset
  const leftUnits1 = [
    makeParaUnit(makeBlockID("l", 1), "重复块内容 Alpha-Beta-Gamma"),
    makeParaUnit(makeBlockID("l", 2), "重复块内容 Alpha-Beta-Gamma"),
    makeParaUnit(makeBlockID("l", 3), "重复块内容 Alpha-Beta-Gamma"),
    makeParaUnit(makeBlockID("l", 4), "第四段：原始配置参数 timeout=30s 与重试策略说明"),
    makeParaUnit(makeBlockID("l", 5), "重复尾块 Omega-Delta"),
    makeParaUnit(makeBlockID("l", 6), "重复尾块 Omega-Delta"),
  ];

  const rightUnits1 = [
    // Large front insertion offset of 12 unrelated paragraphs in the same container
    ...Array.from({ length: 12 }, (_, idx) =>
      makeParaUnit(makeBlockID("r", idx + 1), `新增前置章节背景说明 ${idx}`),
    ),
    makeParaUnit(makeBlockID("r", 20), "重复块内容 Alpha-Beta-Gamma"),
    makeParaUnit(makeBlockID("r", 21), "重复块内容 Alpha-Beta-Gamma"),
    makeParaUnit(makeBlockID("r", 22), "第四段：更新后配置参数 timeout=60s 与重试策略说明"),
    makeParaUnit(makeBlockID("r", 23), "重复尾块 Omega-Delta"),
    makeParaUnit(makeBlockID("r", 24), "重复尾块 Omega-Delta"),
    makeParaUnit(makeBlockID("r", 25), "重复尾块 Omega-Delta"),
  ];

  const blocksL1 = buildBlockGroups(leftUnits1, leftUnits1.map(semanticKey));
  const blocksR1 = buildBlockGroups(rightUnits1, rightUnits1.map(semanticKey));

  const denseSteps1 = [];
  const sparseSteps1 = [];
  assert.equal(
    emitDenseBlockDP(blocksL1, blocksR1, 0, blocksL1.length, 0, blocksR1.length, { remaining: 500_000, maxCells: 500_000 }, denseSteps1),
    true,
  );
  assert.equal(
    emitSparseBlockFenwickDP(blocksL1, blocksR1, 0, blocksL1.length, 0, blocksR1.length, { remaining: 500_000, maxCells: 500_000 }, sparseSteps1),
    true,
  );

  assertStrictMonotoneBlockSteps(denseSteps1, blocksL1.length, blocksR1.length);
  assertStrictMonotoneBlockSteps(sparseSteps1, blocksL1.length, blocksR1.length);
  assert.deepEqual(sparseSteps1, denseSteps1, "Sparse Fenwick DP must match Dense DP step-for-step");

  // Case 2: Larger 45 x 50 stress sample with repeated anchors, deletions, front insertions, and modified paragraphs
  const topics = [
    "鉴权网关负责解析客户端上传的双向证书指纹并验证吊销列表时效",
    "消息路由总线按照租户隔离策略将事件投递至专属分区消费队列",
    "对象存储清理器每日凌晨扫描孤立分片并回收冷数据存储配额",
    "分布式锁协调服务通过租约心跳维护主备实例选主状态转换",
    "全文检索引擎异步增量构建倒排词典快照以降低查询尾延迟",
    "账单聚合任务按自然月归集各区域带宽计费明细并生成对账单",
    "配置中心监听器在检测到版本号递增后热更新本地限流阈值",
    "链路追踪采样器对慢请求自动提升全量跨度采集比例以便排障",
  ];
  const leftUnits2 = [];
  const rightUnits2 = [];
  for (let k = 0; k < 8; k++) {
    rightUnits2.push(makeParaUnit(makeBlockID("r", 100 + k), `SELECT ${k} FROM init_table;`, "NodeCodeBlock", "|sql||"));
  }
  for (let i = 0; i < 45; i++) {
    const isRepeatedSep = i % 9 === 0;
    const text = isRepeatedSep
      ? "公共重复分隔说明段落（用于在文档多处重复出现）"
      : `模块 [${i}] ${topics[i % topics.length]}（流水标识 SN-${i * 137 + 19}）`;
    leftUnits2.push(makeParaUnit(makeBlockID("l", 200 + i), text));
    if (i % 11 === 5) continue; // deleted on right
    const rightText = !isRepeatedSep && i % 4 === 2
      ? `${text} —— 已补充重试退避上限`
      : text;
    rightUnits2.push(makeParaUnit(makeBlockID("r", 200 + i), rightText));
  }

  const blocksL2 = buildBlockGroups(leftUnits2, leftUnits2.map(semanticKey));
  const blocksR2 = buildBlockGroups(rightUnits2, rightUnits2.map(semanticKey));
  const denseSteps2 = [];
  const sparseSteps2 = [];
  assert.equal(
    emitDenseBlockDP(blocksL2, blocksR2, 0, blocksL2.length, 0, blocksR2.length, { remaining: 2_000_000, maxCells: 2_000_000 }, denseSteps2),
    true,
  );
  assert.equal(
    emitSparseBlockFenwickDP(blocksL2, blocksR2, 0, blocksL2.length, 0, blocksR2.length, { remaining: 2_000_000, maxCells: 2_000_000 }, sparseSteps2),
    true,
  );
  assertStrictMonotoneBlockSteps(sparseSteps2, blocksL2.length, blocksR2.length);
  assert.deepEqual(sparseSteps2, denseSteps2);

  // Budget enforcement: tiny budget aborts immediately and returns `false`
  const abortedSteps = [];
  assert.equal(
    emitSparseBlockFenwickDP(blocksL2, blocksR2, 0, blocksL2.length, 0, blocksR2.length, { remaining: 20, maxCells: 20 }, abortedSteps),
    false,
  );
  assert.equal(abortedSteps.length, 0);

  // Unrelated paragraphs (`sim < 0.15`) in multi-block gaps stay `left-only` / `right-only`,
  // whereas an isolated `1 vs 1` rewritten paragraph between two anchors still pairs as `modified`.
  const multiGapRes = alignUnits(
    [
      makeParaUnit(makeBlockID("mg-l", 1), "章节导语锚点：输入参数反序列化安全边界"),
      makeParaUnit(makeBlockID("mg-l", 2), "当 get...Extra() 接收到一个自定义的序列化对象 Serializable 时会抛出异常"),
      makeParaUnit(makeBlockID("mg-l", 3), "章节结语锚点：异常捕获与组件导出限制"),
    ],
    [
      makeParaUnit(makeBlockID("mg-r", 1), "章节导语锚点：输入参数反序列化安全边界"),
      makeParaUnit(makeBlockID("mg-r", 2), "适用范围与成立条件："),
      makeParaUnit(makeBlockID("mg-r", 3), "版本状态表："),
      makeParaUnit(makeBlockID("mg-r", 4), "章节结语锚点：异常捕获与组件导出限制"),
    ],
  );
  assert.deepEqual(
    multiGapRes.hunks.map(h => h.kind),
    ["left-only", "right-only"],
    "Unrelated paragraphs in a 1-vs-2 gap must not falsely pair as modified",
  );

  const oneToOneGapRes = alignUnits(
    [
      makeParaUnit(makeBlockID("oo-l", 1), "章节导语锚点：输入参数反序列化安全边界"),
      makeParaUnit(makeBlockID("oo-l", 2), "旧版简短摘要"),
      makeParaUnit(makeBlockID("oo-l", 3), "章节结语锚点：异常捕获与组件导出限制"),
    ],
    [
      makeParaUnit(makeBlockID("oo-r", 1), "章节导语锚点：输入参数反序列化安全边界"),
      makeParaUnit(makeBlockID("oo-r", 2), "全新重写的风险评级结论"),
      makeParaUnit(makeBlockID("oo-r", 3), "章节结语锚点：异常捕获与组件导出限制"),
    ],
  );
  assert.deepEqual(oneToOneGapRes.hunks.map(h => h.kind), ["modified"]);
});

test("mapBlockAcrossDiff maps exact matches, paired hunks, nearest anchors, and proportional roots without DOM", () => {
  const mk = (id, text) => ({
    blockID: id,
    kind: "NodeParagraph",
    context: "",
    text,
    format: "",
    target: "",
    line: 0,
    reliable: true,
  });
  const leftUnits = [mk("l-1", "锚点一"), mk("l-2", "左侧独有删除段"), mk("l-3", "改写前内容段落"), mk("l-4", "锚点二")];
  const rightUnits = [mk("r-1", "锚点一"), mk("r-3", "改写后内容段落"), mk("r-4", "锚点二")];
  const diff = alignUnits(leftUnits, rightUnits);
  const ctx = {
    diff,
    leftUnits,
    rightUnits,
    leftRootIndexByBlockID: new Map([["l-1", 1], ["l-2", 2], ["l-3", 3], ["l-4", 4]]),
    rightRootIndexByBlockID: new Map([["r-1", 1], ["r-3", 2], ["r-4", 3]]),
    leftRootBlockIDs: ["l-1", "l-2", "l-3", "l-4"],
    rightRootBlockIDs: ["r-1", "r-3", "r-4"],
  };

  assert.deepEqual(mapBlockAcrossDiff(ctx, "left", "l-1"), {
    targetBlockID: "r-1",
    targetRootIndex: 1,
    mappingKind: "exact-match",
  });
  assert.deepEqual(mapBlockAcrossDiff(ctx, "left", "l-3"), {
    targetBlockID: "r-3",
    targetRootIndex: 2,
    mappingKind: "hunk-modified",
  });
  const leftOnlyMapped = mapBlockAcrossDiff(ctx, "left", "l-2");
  assert.equal(leftOnlyMapped?.targetBlockID, "r-1");
  assert.equal(leftOnlyMapped?.mappingKind, "hunk-context-left-only");
});

test("long-document performance gate: 400-block head/tail edit (< 80 ms) and 400x400 all-modified (~280 chars each, < 250 ms)", t => {
  const makeLongParagraph = (idx, variant) => {
    const base =
      `第 ${String(idx).padStart(3, "0")} 节分布式架构规范说明：核心存储引擎节点在接收客户端并发写入事务 #${idx * 31} 时，` +
      `首先通过虚拟槽位一致性哈希环定位主分片副本集合（cluster-shard-${idx % 16}-primary），随后在本地顺序预写日志 WAL 落盘刷写完成后向各从节点广播增量复制确认，` +
      `并在自适应超时窗口 ${120 + (idx % 40)}ms 内汇总多数派仲裁节点响应以推进全局已提交水位线、维护 MVCC 只读快照隔离视图、` +
      `同时上报队列深度、磁盘吞吐、网络往返延迟分位数（P50/P95/P99）以及自动故障转移冷却周期策略监控指标`;
    const suffix = variant === "left"
      ? `，默认启用传输压缩级别 zstd-level-3（摘要校验码 L-${idx * 97}）。`
      : `，默认启用传输压缩级别 lz4-fast-mode（摘要校验码 R-${idx * 97}）。`;
    return base + suffix;
  };

  assert.ok(makeLongParagraph(1, "left").length >= 260);

  // Benchmark 1: 400 paragraphs with only first and last modified (middle 398 identical)
  const units400AnchorL = Array.from({ length: 400 }, (_, i) => ({
    blockID: makeBlockID("a", i + 1),
    kind: "NodeParagraph",
    context: "",
    text: i === 0 || i === 399 ? makeLongParagraph(i, "left") : makeLongParagraph(i, "same"),
    format: "",
    target: "",
    line: 0,
    reliable: true,
  }));
  const units400AnchorR = Array.from({ length: 400 }, (_, i) => ({
    blockID: makeBlockID("b", i + 1),
    kind: "NodeParagraph",
    context: "",
    text: i === 0 || i === 399 ? makeLongParagraph(i, "right") : makeLongParagraph(i, "same"),
    format: "",
    target: "",
    line: 0,
    reliable: true,
  }));

  // Warmup JIT once on tiny input
  alignUnits(units400AnchorL.slice(0, 4), units400AnchorR.slice(0, 4));

  const t0 = performance.now();
  const anchorRes = alignUnits(units400AnchorL, units400AnchorR);
  const anchorElapsedMs = performance.now() - t0;

  assert.equal(anchorRes.unresolved, false);
  assert.equal(anchorRes.matches.length, 398);
  assert.equal(anchorRes.counts.modified, 2);
  assert.ok(
    anchorElapsedMs < 80,
    `Expected 400-block head/tail diff < 80ms, got ${anchorElapsedMs.toFixed(2)}ms`,
  );

  // Benchmark 2: 400 x 400 paragraphs (~280 chars each), EVERY block modified (zero exact anchors)
  const units400AllModL = Array.from({ length: 400 }, (_, i) => ({
    blockID: makeBlockID("c", i + 1),
    kind: "NodeParagraph",
    context: "",
    text: makeLongParagraph(i, "left"),
    format: "",
    target: "",
    line: 0,
    reliable: true,
  }));
  const units400AllModR = Array.from({ length: 400 }, (_, i) => ({
    blockID: makeBlockID("d", i + 1),
    kind: "NodeParagraph",
    context: "",
    text: makeLongParagraph(i, "right"),
    format: "",
    target: "",
    line: 0,
    reliable: true,
  }));

  const t1 = performance.now();
  const allModRes = alignUnits(units400AllModL, units400AllModR);
  const allModElapsedMs = performance.now() - t1;

  assert.equal(allModRes.unresolved, false);
  assert.equal(allModRes.matches.length, 0);
  assert.equal(allModRes.counts.modified, 1);
  assert.equal(allModRes.hunks[0].pairedUnits?.length, 400, "All 400 modified paragraphs pair 1:1");
  assert.ok(
    allModElapsedMs < 250,
    `Expected 400x400 all-modified diff < 250ms, got ${allModElapsedMs.toFixed(2)}ms`,
  );

  t.diagnostic(
    `perf: 400-head-tail=${anchorElapsedMs.toFixed(2)}ms, 400x400-all-modified=${allModElapsedMs.toFixed(2)}ms (avgLen=${units400AllModL[0].text.length})`,
  );
});
