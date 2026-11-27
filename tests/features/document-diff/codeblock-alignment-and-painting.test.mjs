import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBlockDomUnits } from "../../../src/features/document-diff/model/BlockDomExtractor.ts";
import { alignUnits } from "../../../src/features/document-diff/model/DiffEngine.ts";
import { DiffPainter } from "../../../src/features/document-diff/runtime/DiffPainter.ts";

class DomTextNode {
  constructor(data) {
    this.nodeType = 3;
    this.data = String(data);
    this.parentElement = null;
  }
  get textContent() {
    return this.data;
  }
}

class DomElemNode {
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
    this.childNodes = val ? [new DomTextNode(String(val))] : [];
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
  // Collect all text nodes under common root in order
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
    createElement: tag => new DomElemNode(tag),
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

function buildLiveCodeBlock(id, lang, codeWithLiveTrailingNewline, top = 20, height = 160) {
  const block = new DomElemNode("DIV", { "data-node-id": id, "data-type": "NodeCodeBlock", class: "code-block" });
  block._rect = { left: 16, top, right: 480, bottom: top + height, width: 464, height };
  const action = new DomElemNode("DIV", { class: "protyle-action" });
  const langSpan = new DomElemNode("SPAN", { class: "protyle-action__language", contenteditable: "false" });
  langSpan.textContent = lang;
  action.append(langSpan);

  const hljs = new DomElemNode("DIV", { class: "hljs" });
  const lineNums = new DomElemNode("DIV", { class: "protyle-linenumber__rows", contenteditable: "false" });
  lineNums.append(new DomElemNode("SPAN"), new DomElemNode("SPAN"));
  const editable = new DomElemNode("DIV", { contenteditable: "true" });
  // Split across multiple syntax-highlight `<span>` elements like SiYuan `highlightRender.ts`
  const mid = Math.floor(codeWithLiveTrailingNewline.length / 2);
  const s1 = new DomElemNode("SPAN", { class: "hljs-keyword" });
  s1.textContent = codeWithLiveTrailingNewline.slice(0, mid);
  const s2 = new DomElemNode("SPAN", { class: "hljs-title" });
  s2.textContent = codeWithLiveTrailingNewline.slice(mid);
  editable.append(s1, s2);
  hljs.append(lineNums, editable);
  block.append(action, hljs);
  return block;
}

function buildLiveParagraph(id, plainText, top = 200, height = 36) {
  const block = new DomElemNode("DIV", { "data-node-id": id, "data-type": "NodeParagraph", class: "p" });
  block._rect = { left: 16, top, right: 480, bottom: top + height, width: 464, height };
  const editable = new DomElemNode("DIV", { contenteditable: "true" });
  editable.textContent = plainText;
  block.append(editable);
  return block;
}

function buildPaintableProtyle(blocks) {
  const root = new DomElemNode("DIV", { class: "protyle" });
  root._rect = { left: 0, top: 0, right: 500, bottom: 1000, width: 500, height: 1000 };
  const content = new DomElemNode("DIV", { class: "protyle-content" });
  content._rect = root._rect;
  const wysiwyg = new DomElemNode("DIV", { class: "protyle-wysiwyg" });
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

test("trailing blank line in code block next to modified paragraph does NOT whole-block fill and preserves paragraph inline diff", () => {
  const leftRoot = "20251012192403-rootlft";
  const rightRoot = "20261127002236-rootrgt";
  const leftCodeID = "20251012192403-a5quwfs";
  const leftParaID = "20251012192403-parleft";
  const rightCodeID = "20261127003412-8twcq3n";
  const rightParaID = "20261127003412-parrght";

  const codeBody = [
    "private Bundle mExtras;",
    "public @Nullable String getStringExtra(String name) {",
    "    return mExtras == null ? null : mExtras.getString(name);",
    "}",
  ].join("\n");

  // Left has an extra trailing blank line (`\n\n` in BlockDOM `.hljs`), Right has single `\n`
  const leftHtml = `
    <div data-node-id="${leftCodeID}" data-type="NodeCodeBlock"><div class="protyle-action"><span class="protyle-action__language">java</span></div><div class="hljs"><div contenteditable="true">${codeBody}\n\n</div></div></div>
    <div data-node-id="${leftParaID}" data-type="NodeParagraph"><div contenteditable="true">BaseBundle.getString：首先调用unparcel()，之后通过成员变量mMap中取出结果</div></div>
  `;
  const rightHtml = `
    <div data-node-id="${rightCodeID}" data-type="NodeCodeBlock"><div class="protyle-action"><span class="protyle-action__language">java</span></div><div class="hljs"><div contenteditable="true">${codeBody}\n</div></div></div>
    <div data-node-id="${rightParaID}" data-type="NodeParagraph"><div contenteditable="true">② BaseBundle.getString：首先调用 <code>unparcel()</code>，之后通过成员变量 <code>mMap</code> 中取出结果。</div></div>
  `;

  const leftExt = extractBlockDomUnits(leftRoot, leftHtml);
  const rightExt = extractBlockDomUnits(rightRoot, rightHtml);
  const diff = alignUnits(leftExt.units, rightExt.units);

  // All 4 code lines match strictly
  assert.equal(diff.matches.length, 4);

  withHighlightDomEnv(registry => {
    const leftProtyle = buildPaintableProtyle([
      buildLiveCodeBlock(leftCodeID, "java", `${codeBody}\n\n`, 20, 120),
      buildLiveParagraph(leftParaID, "BaseBundle.getString：首先调用unparcel()，之后通过成员变量mMap中取出结果", 160, 36),
    ]);
    const leftPainter = new DiffPainter(leftProtyle, "left");
    leftPainter.paint(diff, leftExt.units);
    const leftVisual = inspectPaintedSide(leftProtyle, registry);

    // Left code block (`top: 20px`) must ONLY have a 3px bar (`backgroundColor === ""`), NEVER whole-block `modified-fill`!
    const leftCodeBox = leftVisual.boxes.find(b => b.top === "20px");
    assert.ok(leftCodeBox, "Left code block shows 3px bar for trailing blank line difference");
    assert.equal(leftCodeBox.backgroundColor, "", "Left code block must NOT have whole-block red background fill");
    assert.equal(leftVisual.ranges.length, 0, "Left has only deletions of zero chars relative to right paragraph insertions");
    leftPainter.dispose();

    const rightProtyle = buildPaintableProtyle([
      buildLiveCodeBlock(rightCodeID, "java", `${codeBody}\n`, 20, 120),
      buildLiveParagraph(rightParaID, "② BaseBundle.getString：首先调用 unparcel()，之后通过成员变量 mMap 中取出结果。", 160, 36),
    ]);
    const rightPainter = new DiffPainter(rightProtyle, "right");
    rightPainter.paint(diff, rightExt.units);
    const rightVisual = inspectPaintedSide(rightProtyle, registry);

    // Right code block has 0 changes -> 0 overlay boxes!
    assert.equal(rightVisual.boxes.find(b => b.top === "20px"), undefined);
    // Right paragraph highlights ONLY the inserted fragments (`"② "`, spaces, `"。"`), NOT the entire paragraph!
    assert.deepEqual(rightVisual.ranges, ["② ", " ", " ", " ", "。"]);
    rightPainter.dispose();
  });
});

test("indentation shift inside paired code block aligns closing braces accurately without whole-line smear on default branch", () => {
  const leftCodeID = "20251012192403-52yt8ra";
  const rightCodeID = "20261127003412-ar3jp67";

  const leftCode = [
    "@Nullable",
    "    public final Object readValue(ClassLoader loader) {",
    "        switch (type) {",
    "        case VAL_NULL:",
    "            return null;",
    "\t\t// ...省略部分类型",
    "        default:",
    "            int off = dataPosition() - 4;",
    "            throw new RuntimeException(\"bad \" + off);",
    "        }",
    "    }",
    "",
  ].join("\n");

  const rightCode = [
    "@Nullable",
    "public final Object readValue(ClassLoader loader) {",
    "    switch (type) {",
    "    case VAL_NULL:",
    "        return null;",
    "        // ...省略部分类型",
    "    default:",
    "        int off = dataPosition() - 4;",
    "        throw new RuntimeException(\"bad \" + off);",
    "    }",
    "}",
  ].join("\n");

  const leftHtml = `<div data-node-id="${leftCodeID}" data-type="NodeCodeBlock"><div class="protyle-action"><span class="protyle-action__language">java</span></div><div class="hljs"><div contenteditable="true">${leftCode}\n</div></div></div>`;
  const rightHtml = `<div data-node-id="${rightCodeID}" data-type="NodeCodeBlock"><div class="protyle-action"><span class="protyle-action__language">java</span></div><div class="hljs"><div contenteditable="true">${rightCode}\n</div></div></div>`;

  const leftExt = extractBlockDomUnits("20251012192403-rootlft", leftHtml);
  const rightExt = extractBlockDomUnits("20261127002236-rootrgt", rightHtml);
  const diff = alignUnits(leftExt.units, rightExt.units);

  // Only line 0 (`@Nullable`) is strictly identical; left's outer `"    }"` (line 10) must NOT match right's inner `"    }"` (line 9)!
  assert.deepEqual(
    diff.matches.map(m => [m.leftIndex, m.rightIndex]),
    [[0, 0]],
  );

  withHighlightDomEnv(registry => {
    const leftProtyle = buildPaintableProtyle([
      buildLiveCodeBlock(leftCodeID, "java", `${leftCode}\n`, 20, 260),
    ]);
    const leftPainter = new DiffPainter(leftProtyle, "left");
    leftPainter.paint(diff, leftExt.units);
    const leftVisual = inspectPaintedSide(leftProtyle, registry);

    assert.equal(leftVisual.boxes.length, 1);
    assert.equal(leftVisual.boxes[0].backgroundColor, "", "No whole-block fill on readValue");
    // Every single highlighted range on Left must be pure whitespace (`"    "` or `"\t\t"`), never code tokens!
    assert.ok(leftVisual.ranges.length >= 9);
    for (const r of leftVisual.ranges) {
      assert.match(r, /^[ \t]+$/, `Expected whitespace-only inline diff on left, got ${JSON.stringify(r)}`);
    }
    leftPainter.dispose();

    const rightProtyle = buildPaintableProtyle([
      buildLiveCodeBlock(rightCodeID, "java", `${rightCode}\n`, 20, 260),
    ]);
    const rightPainter = new DiffPainter(rightProtyle, "right");
    rightPainter.paint(diff, rightExt.units);
    const rightVisual = inspectPaintedSide(rightProtyle, registry);

    assert.equal(rightVisual.boxes.length, 1);
    assert.equal(rightVisual.boxes[0].backgroundColor, "");
    // Right only had whitespace removed (except the tab->8 spaces comment line where spaces were inserted)
    for (const r of rightVisual.ranges) {
      assert.match(r, /^[ \t]+$/, `Expected only indentation spaces on right, got ${JSON.stringify(r)}`);
    }
    rightPainter.dispose();
  });
});

test("prevents cross-block brace matching from readSerializable into PUser and classifies moved chapters as left-only / right-only", () => {
  const leftSUserID = "20251012192403-vbmk2uk";
  const leftAnchorID = "20251012192403-anc0001";
  const leftReadSerID = "20251012192403-9mab82d";

  const rightAnchorID = "20261127003412-anc0002";
  const rightReadSerID = "20261127003412-wa85qdk";
  const rightSUserID = "20261127003412-lid29mb";
  const rightPUserID = "20261127003412-ljulvyw";

  const sUserCode = [
    "public class SUser implements Serializable {",
    "    public SUser() {",
    "",
    "    }",
    "}",
  ].join("\n");

  const pUserCode = [
    "public class PUser implements Parcelable {",
    "    public PUser createFromParcel(Parcel in) {",
    "        return new PUser(in);",
    "    }",
    "",
    "    public PUser() {",
    "    }",
    "",
  ].join("\n");

  const leftReadSer = [
    "private final Serializable readSerializable(final ClassLoader loader) {",
    "        ObjectInputStream ois = new ObjectInputStream(bais) {",
    "            protected Class<?> resolveClass() {",
    "                return null;",
    "            }",
    "        };",
    "        if (name == null) {",
    "            return null;",
    "        }",
    "    }",
    "",
  ].join("\n");

  const rightReadSer = [
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

  // Left: list-nested SUser BEFORE matched anchor, then readSerializable at end.
  const leftHtml = `
    <div data-node-id="20251012192403-list001" data-type="NodeList" data-subtype="u">
      <div data-node-id="20251012192403-item001" data-type="NodeListItem" data-subtype="u" data-marker="*">
        <div data-node-id="${leftSUserID}" data-type="NodeCodeBlock"><div class="protyle-action"><span class="protyle-action__language">java</span></div><div class="hljs"><div contenteditable="true">${sUserCode}\n</div></div></div>
      </div>
    </div>
    <div data-node-id="${leftAnchorID}" data-type="NodeHeading" data-subtype="h2"><div contenteditable="true">漏洞原理</div></div>
    <div data-node-id="${leftReadSerID}" data-type="NodeCodeBlock"><div class="protyle-action"><span class="protyle-action__language">java</span></div><div class="hljs"><div contenteditable="true">${leftReadSer}\n</div></div></div>
  `;

  // Right: matched anchor, then readSerializable, then moved top-level SUser and PUser at end.
  const rightHtml = `
    <div data-node-id="${rightAnchorID}" data-type="NodeHeading" data-subtype="h2"><div contenteditable="true">漏洞原理</div></div>
    <div data-node-id="${rightReadSerID}" data-type="NodeCodeBlock"><div class="protyle-action"><span class="protyle-action__language">java</span></div><div class="hljs"><div contenteditable="true">${rightReadSer}\n</div></div></div>
    <div data-node-id="${rightSUserID}" data-type="NodeCodeBlock"><div class="protyle-action"><span class="protyle-action__language">java</span></div><div class="hljs"><div contenteditable="true">${sUserCode}\n</div></div></div>
    <div data-node-id="${rightPUserID}" data-type="NodeCodeBlock"><div class="protyle-action"><span class="protyle-action__language">java</span></div><div class="hljs"><div contenteditable="true">${pUserCode}\n</div></div></div>
  `;

  const leftExt = extractBlockDomUnits("20251012192403-rootlft", leftHtml);
  const rightExt = extractBlockDomUnits("20261127002236-rootrgt", rightHtml);
  const diff = alignUnits(leftExt.units, rightExt.units);

  // 1. `readSerializable` on Left must NEVER match any line in `PUser` or `SUser` on Right!
  const rightTargetsForReadSer = new Set(
    diff.matches.filter(m => m.leftBlockID === leftReadSerID).map(m => m.rightBlockID),
  );
  assert.deepEqual([...rightTargetsForReadSer], [rightReadSerID]);

  // 2. Early SUser on Left is `left-only` ("删除"); ReadSerializable is `modified`; trailing SUser+PUser on Right is `right-only` ("新增")!
  assert.equal(diff.counts.removed, 1);
  assert.equal(diff.counts.modified, 1);
  assert.equal(diff.counts.added, 1);
  assert.equal(diff.hunks[0].kind, "left-only");
  assert.equal(diff.hunks[1].kind, "modified");
  assert.equal(diff.hunks[1].pairedUnits?.length, 9, "All 9 indented lines including `}` before `};` pair 1:1");
  assert.equal(diff.hunks[2].kind, "right-only");

  // 3. Verify `DiffPainter` paints trailing `SUser` and `PUser` cleanly as `only` (no missing brace lines, no double-tinting)
  withHighlightDomEnv(registry => {
    const rightProtyle = buildPaintableProtyle([
      buildLiveCodeBlock(rightReadSerID, "java", `${rightReadSer}\n`, 20, 140),
      buildLiveCodeBlock(rightSUserID, "java", `${sUserCode}\n`, 180, 120),
      buildLiveCodeBlock(rightPUserID, "java", `${pUserCode}\n`, 320, 180),
    ]);
    const rightPainter = new DiffPainter(rightProtyle, "right");
    rightPainter.paint(diff, rightExt.units);
    const rightVisual = inspectPaintedSide(rightProtyle, registry);

    const sUserBox = rightVisual.boxes.find(b => b.top === "180px");
    const pUserBox = rightVisual.boxes.find(b => b.top === "320px");
    assert.ok(sUserBox?.borderInlineStart.includes("var(--b3-theme-success)"));
    assert.ok(pUserBox?.borderInlineStart.includes("var(--b3-theme-success)"));
    assert.equal(rightVisual.ranges.length, 0, "No duplicate CSS.highlights ranges on whole-block right-only code blocks");
    rightPainter.dispose();
  });
});

test("retains whole-block weak fill for pure code-language or heading-level format changes when text is identical", () => {
  const leftID = "20260601000001-codefmt";
  const rightID = "20260602000001-codefmt";
  const leftHtml = `<div data-node-id="${leftID}" data-type="NodeCodeBlock"><div class="protyle-action"><span class="protyle-action__language">ts</span></div><div class="hljs"><div contenteditable="true">const x = 1;\n</div></div></div>`;
  const rightHtml = `<div data-node-id="${rightID}" data-type="NodeCodeBlock"><div class="protyle-action"><span class="protyle-action__language">js</span></div><div class="hljs"><div contenteditable="true">const x = 1;\n</div></div></div>`;

  const leftExt = extractBlockDomUnits("20260601000000-rootlft", leftHtml);
  const rightExt = extractBlockDomUnits("20260602000000-rootrgt", rightHtml);
  const diff = alignUnits(leftExt.units, rightExt.units);

  assert.equal(diff.counts.modified, 1);

  withHighlightDomEnv(registry => {
    const leftProtyle = buildPaintableProtyle([
      buildLiveCodeBlock(leftID, "ts", "const x = 1;\n", 20, 60),
    ]);
    const leftPainter = new DiffPainter(leftProtyle, "left");
    leftPainter.paint(diff, leftExt.units);
    const leftVisual = inspectPaintedSide(leftProtyle, registry);

    assert.equal(leftVisual.boxes.length, 1);
    assert.ok(
      leftVisual.boxes[0].backgroundColor.includes("12%"),
      "Pure code language change without text diff retains 12% weak fill so format diff remains visible",
    );
    assert.equal(leftVisual.ranges.length, 0);
    leftPainter.dispose();
  });
});
