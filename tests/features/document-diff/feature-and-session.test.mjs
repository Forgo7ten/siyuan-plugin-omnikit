import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { MenuRegistry } from "../../../src/core/feedback/MenuRegistry.ts";
import { extractDocTreeDocumentIDs } from "../../../src/core/feedback/MenuRouter.ts";
import { UiFeedback } from "../../../src/core/feedback/UiFeedback.ts";
import { SettingsManager } from "../../../src/core/store/SettingsManager.ts";
import { setFrontendResolver } from "../../../src/core/host/Platform.ts";
import { DocumentDiffFeature } from "../../../src/features/document-diff/DocumentDiffFeature.ts";
import { documentDiffSettingsCodec } from "../../../src/features/document-diff/model/settings.ts";

class MockDomNode {
  constructor(tagName = "DIV", attrs = {}) {
    this.nodeType = 1;
    this.tagName = tagName.toUpperCase();
    this.attrs = new Map(Object.entries(attrs));
    this.childrenList = [];
    this.parentElement = null;
    this.isConnected = true;
    this.style = { setProperty(k, v) { this[k] = v; } };
    this.listeners = new Map();
    this.scrollTop = 0;
    this.scrollHeight = 1200;
    this.clientHeight = 500;
    this._rect = { left: 0, top: 0, right: 400, bottom: 500, width: 400, height: 500 };
    this._text = "";
  }
  get className() { return this.attrs.get("class") ?? ""; }
  set className(v) { this.attrs.set("class", String(v)); }
  get classList() {
    const self = this;
    return {
      contains(cls) {
        return (self.attrs.get("class") ?? "").split(/\s+/).includes(cls);
      },
      add(...classes) {
        const set = new Set((self.attrs.get("class") ?? "").split(/\s+/).filter(Boolean));
        classes.forEach(c => set.add(c));
        self.attrs.set("class", [...set].join(" "));
      },
      remove(...classes) {
        const set = new Set((self.attrs.get("class") ?? "").split(/\s+/).filter(Boolean));
        classes.forEach(c => set.delete(c));
        self.attrs.set("class", [...set].join(" "));
      },
    };
  }
  get childNodes() { return this.childrenList; }
  get children() { return this.childrenList.filter(c => c.nodeType === 1); }
  get textContent() {
    if (this.childrenList.length === 0) return this._text;
    return this.childrenList.map(c => c.textContent ?? "").join("");
  }
  set textContent(v) {
    const str = String(v);
    this._text = str;
    this.childrenList = str
      ? [{ nodeType: 3, textContent: str, childNodes: [], parentElement: this }]
      : [];
  }
  hasAttribute(name) { return this.attrs.has(name.toLowerCase()); }
  matches(selector) { return matchesSimpleSelector(this, selector); }
  getAttribute(name) { return this.attrs.get(name.toLowerCase()) ?? null; }
  setAttribute(name, val) { this.attrs.set(name.toLowerCase(), String(val)); }
  getAttributeNames() { return [...this.attrs.keys()]; }
  append(...nodes) {
    for (const n of nodes) {
      if (n.parentElement) n.remove();
      n.parentElement = this;
      n.isConnected = this.isConnected;
      this.childrenList.push(n);
    }
  }
  replaceChildren(...nodes) {
    this.childrenList = [];
    this.append(...nodes);
  }
  remove() {
    if (this.parentElement) {
      const idx = this.parentElement.childrenList.indexOf(this);
      if (idx >= 0) this.parentElement.childrenList.splice(idx, 1);
      this.parentElement = null;
    }
    this.isConnected = false;
  }
  contains(target) {
    let cur = target;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentElement;
    }
    return false;
  }
  closest(selector) {
    let cur = this;
    while (cur) {
      if (matchesSimpleSelector(cur, selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = el => {
      for (const child of el.children) {
        if (matchesSimpleSelector(child, selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  getClientRects() { return this.isConnected ? [this._rect] : []; }
  getBoundingClientRect() { return this._rect; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }
  emit(type, detail = {}) {
    for (const fn of this.listeners.get(type) ?? []) {
      fn({ type, target: this, ...detail });
    }
  }
}

function matchesSimpleSelector(el, selector) {
  for (const rawPart of selector.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;
    if (part.startsWith(".") && el.classList.contains(part.slice(1))) return true;
    const attrExact = /^\[([a-zA-Z0-9_-]+)="([^"]+)"\]$/.exec(part);
    if (attrExact && el.getAttribute(attrExact[1]) === attrExact[2]) return true;
    const attrWord = /^\[([a-zA-Z0-9_-]+)~="([^"]+)"\]$/.exec(part);
    if (attrWord && (el.getAttribute(attrWord[1]) ?? "").split(/\s+/).includes(attrWord[2])) return true;
    const tagNotAttr = /^([a-zA-Z0-9_-]+):not\(\[([a-zA-Z0-9_-]+)\]\)$/.exec(part);
    if (tagNotAttr && el.tagName === tagNotAttr[1].toUpperCase() && el.getAttribute(tagNotAttr[2]) === null) return true;
    const attrHas = /^\[([a-zA-Z0-9_-]+)\]$/.exec(part);
    if (attrHas && el.getAttribute(attrHas[1]) !== null) return true;
    if (el.tagName === part.toUpperCase()) return true;
  }
  return false;
}

function createEditorModel({ id, notebook, title, blockID, text, rectLeft, wnd, layoutParent }) {
  const wndEl = wnd.element;
  wndEl._rect = { left: rectLeft, top: 0, right: rectLeft + 400, bottom: 600, width: 400, height: 600 };

  const panel = new MockDomNode("DIV", { class: "fn__flex-1" });
  panel._rect = wndEl._rect;
  wndEl.append(panel);

  const head = new MockDomNode("LI", { class: "item item--focus" });
  const protyleEl = new MockDomNode("DIV", { class: "protyle" });
  protyleEl._rect = wndEl._rect;
  panel.append(protyleEl);

  const contentEl = new MockDomNode("DIV", { class: "protyle-content" });
  contentEl._rect = wndEl._rect;
  const titleWrap = new MockDomNode("DIV", { class: "protyle-title" });
  const titleEdit = new MockDomNode("DIV", { class: "protyle-title__input" });
  titleEdit.textContent = title;
  titleWrap.append(titleEdit);

  const wysiwygEl = new MockDomNode("DIV", { class: "protyle-wysiwyg" });
  const para = new MockDomNode("DIV", { "data-node-id": blockID, "data-type": "NodeParagraph" });
  para._rect = { left: rectLeft + 16, top: 80, right: rectLeft + 360, bottom: 110, width: 344, height: 30 };
  const editDiv = new MockDomNode("DIV", { contenteditable: "true" });
  editDiv.textContent = text;
  para.append(editDiv);
  wysiwygEl.append(para);

  contentEl.append(titleWrap, wysiwygEl);
  protyleEl.append(contentEl);

  const protyle = {
    notebookId: notebook,
    block: { rootID: id },
    element: protyleEl,
    contentElement: contentEl,
    wysiwyg: { element: wysiwygEl },
    title: { element: titleWrap, editElement: titleEdit, getText: () => titleEdit.textContent },
    options: {},
  };

  const tab = {
    id: `tab-${id}`,
    headElement: head,
    panelElement: panel,
    parent: wnd,
    model: null,
  };
  const model = {
    element: panel,
    headElement: head,
    parent: tab,
    editor: { protyle },
  };
  tab.model = model;
  wnd.parent = layoutParent;
  wnd.headersElement.append(head);
  wnd.headersElement.parentElement.classList.remove("fn__none");
  wnd.children.push(tab);
  return { model, tab, protyle, para };
}

function createWnd(rectLeft, layoutParent, onSwitchProtyle) {
  const el = new MockDomNode("DIV", { "data-type": "wnd" });
  el._rect = { left: rectLeft, top: 0, right: rectLeft + 400, bottom: 600, width: 400, height: 600 };
  const headersWrap = new MockDomNode("DIV", { class: "fn__flex fn__none" });
  const headersElement = new MockDomNode("UL", { class: "fn__flex layout-tab-bar" });
  headersWrap.append(headersElement);
  el.append(headersWrap);

  const wnd = {
    element: el,
    headersElement,
    parent: layoutParent,
    children: [],
    switchTab(head) {
      for (const child of this.children) {
        if (child.headElement === head) child.headElement.classList.add("item--focus");
        else child.headElement?.classList.remove("item--focus");
      }
      // Real SiYuan `Wnd.switchTab` synchronously dispatches `"switch-protyle"` before returning!
      onSwitchProtyle?.();
    },
    moveTab(tab) {
      const oldWnd = tab.parent;
      const idx = oldWnd.children.indexOf(tab);
      if (idx >= 0) oldWnd.children.splice(idx, 1);
      if (oldWnd.children.length === 0) {
        const pIdx = layoutParent.children.indexOf(oldWnd);
        if (pIdx >= 0) layoutParent.children.splice(pIdx, 1);
      }
      // Like real SiYuan `Wnd.moveTab`, only `panelElement` is moved here (`headElement` requires caller transfer).
      tab.panelElement.remove();
      this.element.append(tab.panelElement);
      tab.panelElement._rect = this.element._rect;
      tab.model.editor.protyle.element._rect = this.element._rect;
      this.children.push(tab);
      tab.parent = this;
      this.switchTab(tab.headElement);
    },
    split(dir) {
      const next = createWnd(420, layoutParent, onSwitchProtyle);
      layoutParent.direction = dir;
      // Update left wnd rect to 0..400 and right wnd rect to 420..820
      this.element._rect = { left: 0, top: 0, right: 400, bottom: 600, width: 400, height: 600 };
      for (const t of this.children) {
        t.panelElement._rect = this.element._rect;
        t.model.editor.protyle.element._rect = this.element._rect;
      }
      return next;
    },
  };
  layoutParent.children.push(wnd);
  return wnd;
}

test("DocumentDiffFeature gates all 3 menus accurately, compares without mutating editor DOM, swaps panes, and disposes cleanly", async () => {
  setFrontendResolver(() => "desktop");
  const prevDoc = globalThis.document;
  const prevStyle = globalThis.getComputedStyle;
  globalThis.document = {
    createElement: tag => new MockDomNode(tag),
    body: new MockDomNode("BODY"),
  };
  globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible" });

  try {
    const zh = JSON.parse(await readFile(new URL("../../../src/i18n/zh-CN.json", import.meta.url), "utf8"));
    const bus = new Map();
    const plugin = {
      name: "siyuan-plugin-omnikit",
      app: {},
      i18n: zh,
      saveData: async () => {},
      eventBus: {
        on(name, fn) {
          if (!bus.has(name)) bus.set(name, new Set());
          bus.get(name).add(fn);
        },
        off(name, fn) {
          bus.get(name)?.delete(fn);
        },
        emit(name, detail) {
          for (const fn of bus.get(name) ?? []) fn({ detail });
        },
      },
    };

    const fakeRegistration = {
      id: "document-diff",
      titleKey: "feature.documentDiff.title",
      descriptionKey: "feature.documentDiff.description",
      defaultEnabled: true,
      file: "feature-document-diff-settings.json",
      codec: documentDiffSettingsCodec,
      create: () => { throw new Error("unused"); },
      settingsView: () => null,
    };

    const settings = new SettingsManager(plugin, [fakeRegistration], async () =>
      new Response(JSON.stringify({ code: 404 }), { status: 202 }),
    );
    await settings.load();

    const layoutParent = { direction: "lr", children: [] };
    const emitSyncSwitch = () => plugin.eventBus.emit("switch-protyle", {});
    const leftWnd = createWnd(0, layoutParent, emitSyncSwitch);
    const rightWnd = createWnd(420, layoutParent, emitSyncSwitch);

    const origID = "20261110090000-orig001";
    const confID = "20261115102030-conf001";
    const leftEntry = createEditorModel({
      id: origID,
      notebook: "box1",
      title: "方案",
      blockID: "20261110090001-blklft1",
      text: "第一行旧文本",
      rectLeft: 0,
      wnd: leftWnd,
      layoutParent,
    });
    const rightEntry = createEditorModel({
      id: confID,
      notebook: "box1",
      title: "方案 (Conflicted 2026-11-15 10:20:30)",
      blockID: "20261115102031-blkrgt1",
      text: "第一行新文本",
      rectLeft: 420,
      wnd: rightWnd,
      layoutParent,
    });

    const docsDB = {
      [origID]: {
        title: "方案",
        path: "/20261110090000-orig001.sy",
        dom: `<div data-node-id="20261110090001-blklft1" data-type="NodeParagraph"><div contenteditable="true">第一行旧文本</div></div><div data-node-id="20261110090002-imglft2" data-type="NodeParagraph"><div contenteditable="true"><span contenteditable="false" data-type="img" class="img"><img data-src="assets/pic-old.png" /></span></div></div><div data-node-id="20261110090003-offlft3" data-type="NodeParagraph"><div contenteditable="true">虚拟滚动未加载块A</div></div>`,
      },
      [confID]: {
        title: "方案 (Conflicted 2026-11-15 10:20:30)",
        path: "/20261115102030-conf001.sy",
        dom: `<div data-node-id="20261115102031-blkrgt1" data-type="NodeParagraph"><div contenteditable="true">第一行新文本</div></div><div data-node-id="20261115102032-imgrgt2" data-type="NodeParagraph"><div contenteditable="true"><span contenteditable="false" data-type="img" class="img"><img data-src="assets/pic-new.png" /></span></div></div><div data-node-id="20261115102033-offrgt3" data-type="NodeParagraph"><div contenteditable="true">虚拟滚动未加载块B</div></div>`,
      },
    };

    // Mount image blocks in live Protyle DOM so image overlay painting is also verified!
    const appendLiveImageBlock = (entry, blockID, src, rectLeft) => {
      const imgPara = new MockDomNode("DIV", { "data-node-id": blockID, "data-type": "NodeParagraph" });
      imgPara._rect = { left: rectLeft + 16, top: 120, right: rectLeft + 360, bottom: 240, width: 344, height: 120 };
      const edit = new MockDomNode("DIV", { contenteditable: "true" });
      const imgWrap = new MockDomNode("SPAN", { contenteditable: "false", "data-type": "img", class: "img" });
      imgWrap._rect = { left: rectLeft + 20, top: 124, right: rectLeft + 220, bottom: 236, width: 200, height: 112 };
      const imgEl = new MockDomNode("IMG", { "data-src": src, src });
      imgWrap.append(imgEl);
      edit.append(imgWrap);
      imgPara.append(edit);
      entry.protyle.wysiwyg.element.append(imgPara);
    };
    appendLiveImageBlock(leftEntry, "20261110090002-imglft2", "assets/pic-old.png", 0);
    appendLiveImageBlock(rightEntry, "20261115102032-imgrgt2", "assets/pic-new.png", 420);

    const mockKernel = {
      async post(url, body) {
        if (url === "/api/filetree/getPathByID") {
          return { code: 0, data: { notebook: "box1", path: docsDB[body.id].path } };
        }
        if (url === "/api/block/getDocInfo") {
          return { code: 0, data: { id: body.id, name: docsDB[body.id].title } };
        }
        if (url === "/api/filetree/getHPathByID") {
          return { code: 0, data: `/${docsDB[body.id].title}` };
        }
        if (url === "/api/filetree/listDocsByPath") {
          return {
            code: 0,
            data: {
              files: [
                { id: origID, path: docsDB[origID].path, name: "方案.sy" },
                { id: confID, path: docsDB[confID].path, name: `${docsDB[confID].title}.sy` },
              ],
            },
          };
        }
        if (url === "/api/block/getBlockDOM") {
          return { code: 0, data: { id: body.id, dom: docsDB[body.id].dom } };
        }
        throw new Error(`Unexpected endpoint: ${url}`);
      },
    };

    const openedTabCalls = [];
    const bridge = {
      getEditorModels: () =>
        layoutParent.children.flatMap(w => w.children.map(t => t.model)),
      openDocTab: async opts => {
        openedTabCalls.push(opts);
        return undefined;
      },
      createDialog: () => ({ element: new MockDomNode("DIV"), destroy() {} }),
      getNotebookName: () => "工作笔记",
    };

    const toolbarStates = [];
    let toolbarActions = null;
    let toolbarDisposed = false;
    const mountToolbar = (initial, actions) => {
      toolbarStates.push(initial);
      toolbarActions = actions;
      return {
        update(next) { toolbarStates.push(next); },
        dispose() { toolbarDisposed = true; },
      };
    };

    const feature = new DocumentDiffFeature(plugin, settings, {
      bridge,
      mountToolbar,
      kernel: mockKernel,
    });

    let running = true;
    const menus = new MenuRegistry(() => running, err => { throw err; });
    const notices = [];
    const feedback = new UiFeedback(undefined, (msg, _t, type) => notices.push({ msg, type }));
    await feature.activate({ plugin, settings, menus, logger: { info() {}, warn() {}, error() {}, debug() {} }, feedback });

    // 1. Check Entry A menu gating: non-conflict doc renders 0 items; conflict doc renders 2 items
    const renderedTitleNonConflict = [];
    menus.render("doc-title", { addItem: i => renderedTitleNonConflict.push(i) }, {
      location: "doc-title",
      rootID: origID,
      detail: { data: { name: "方案" } },
    });
    assert.equal(renderedTitleNonConflict.length, 0);

    const renderedTitleConflict = [];
    menus.render("doc-title", { addItem: i => renderedTitleConflict.push(i) }, {
      location: "doc-title",
      rootID: confID,
      detail: { data: { name: "方案 (Conflicted 2026-11-15 10:20:30)" } },
    });
    assert.equal(renderedTitleConflict.length, 2);

    // 2. Check Entry C menu gating: mixed selection (1 notebook + 2 docs => type="items") must render 0 items!
    const mixedDetail = {
      type: "items",
      items: [
        { id: "box1", path: "/", type: "notebook" },
        { id: origID, path: "/a.sy" },
        { id: confID, path: "/b.sy" },
      ],
    };
    const mixedIDs = extractDocTreeDocumentIDs(mixedDetail);
    assert.equal(mixedIDs.length, 2); // MenuRouter extracts 2 doc IDs, but DocumentDiffFeature rejects mixed `type: "items"`!
    const renderedMixed = [];
    menus.render("doc-tree", { addItem: i => renderedMixed.push(i) }, {
      location: "doc-tree",
      selectedDocumentIDs: mixedIDs,
      selectedDocumentCount: 2,
      detail: mixedDetail,
    });
    assert.equal(renderedMixed.length, 0);

    // Exact 2-document selection (`type: "docs"`) renders 1 item
    const exactTwoDetail = {
      type: "docs",
      items: [
        { id: origID, path: "/a.sy" },
        { id: confID, path: "/b.sy" },
      ],
    };
    const renderedExactTwo = [];
    menus.render("doc-tree", { addItem: i => renderedExactTwo.push(i) }, {
      location: "doc-tree",
      selectedDocumentIDs: [origID, confID],
      selectedDocumentCount: 2,
      detail: exactTwoDetail,
    });
    assert.equal(renderedExactTwo.length, 1);

    // 3. Launch conflict comparison -> verifies 1 modified body hunk and 0 title diff (conflict suffix exempted!)
    renderedTitleConflict[0].click();
    await new Promise(r => setTimeout(r, 30));

    const latest = toolbarStates.at(-1);
    assert.equal(latest.statusKind, "diff");
    assert.equal(latest.counts.modified, 1);
    assert.equal(latest.counts.all, 1);
    assert.equal(latest.leftDoc.id, origID);
    assert.equal(latest.rightDoc.id, confID);

    // Verify ZERO attribute/child pollution inside `[data-node-id]` editable blocks!
    assert.deepEqual(leftEntry.para.getAttributeNames().sort(), ["data-node-id", "data-type"]);
    assert.deepEqual(rightEntry.para.getAttributeNames().sort(), ["data-node-id", "data-type"]);

    // Verify changed image block painted both block overlay AND `image-diff` border box!
    const leftOverlay = leftEntry.protyle.element.querySelector(".omnikit-document-diff-overlay");
    assert.ok(leftOverlay.children.length >= 3, "Overlay renders boxes for modified text block, image block, and inner .img");

    // 4. Test in-place `swapLeftRight`: even though `Wnd.switchTab` synchronously emits `"switch-protyle"`,
    // session MUST NOT exit, `headElement` MUST be transferred to the new pane's `headersElement`, and suffix stays exempted!
    toolbarActions.onSwap();
    await new Promise(r => setTimeout(r, 30));
    assert.equal(toolbarDisposed, false, "Swapping panes must NOT dispose the active diff session");
    const afterSwap = toolbarStates.at(-1);
    assert.equal(afterSwap.leftDoc.id, confID);
    assert.equal(afterSwap.rightDoc.id, origID);
    assert.equal(afterSwap.counts.all, 1);
    const [newLeftWnd, newRightWnd] = layoutParent.children;
    assert.equal(rightEntry.tab.headElement.parentElement, newLeftWnd.headersElement);
    assert.equal(leftEntry.tab.headElement.parentElement, newRightWnd.headersElement);
    assert.equal(newRightWnd.headersElement.parentElement.classList.contains("fn__none"), false);

    // 5. Test cross-viewport navigation on unmounted block uses `["cb-get-hl", "cb-get-context"]`
    // Make the first hunk target an unmounted block by removing mounted blocks temporarily
    leftEntry.protyle.wysiwyg.element.replaceChildren();
    rightEntry.protyle.wysiwyg.element.replaceChildren();
    openedTabCalls.length = 0;
    toolbarActions.onNext();
    assert.equal(openedTabCalls.length, 2);
    assert.deepEqual(openedTabCalls[0].action, ["cb-get-hl", "cb-get-context"]);
    assert.deepEqual(openedTabCalls[1].action, ["cb-get-hl", "cb-get-context"]);

    // 5. Close comparison -> cleans up overlays, styles, listeners, and toolbar while keeping tabs open
    toolbarActions.onClose();
    assert.equal(toolbarDisposed, true);
    assert.equal(leftEntry.protyle.element.querySelectorAll(".omnikit-document-diff-overlay").length, 0);
    assert.equal(rightEntry.protyle.element.querySelectorAll(".omnikit-document-diff-overlay").length, 0);

    running = false;
    await feature.deactivate();
    assert.equal(bus.get("ws-main")?.size ?? 0, 0);
  } finally {
    globalThis.document = prevDoc;
    globalThis.getComputedStyle = prevStyle;
  }
});

test("Svelte UI components for document-diff use SiYuan theme variables without hardcoded hex or rgba colors", async () => {
  const toolbarSvelte = await readFile(
    new URL("../../../src/features/document-diff/ui/DiffToolbar.svelte", import.meta.url),
    "utf8",
  );
  const settingsSvelte = await readFile(
    new URL("../../../src/features/document-diff/ui/DocumentDiffSettingsPanel.svelte", import.meta.url),
    "utf8",
  );
  for (const [name, content] of [["DiffToolbar.svelte", toolbarSvelte], ["DocumentDiffSettingsPanel.svelte", settingsSvelte]]) {
    const styleBlock = content.slice(content.indexOf("<style"));
    assert.doesNotMatch(styleBlock, /#[0-9a-fA-F]{3,8}\b/, `${name} must not hardcode hex colors`);
    assert.doesNotMatch(styleBlock, /rgba?\(/, `${name} must not hardcode rgb/rgba colors`);
  }
});

test("long-document disjoint virtualized block windows synchronize via protyle.scroll slice loading without redundant getBlockDOM refetches", async () => {
  const prevDoc = globalThis.document;
  const prevStyle = globalThis.getComputedStyle;
  globalThis.document = {
    createElement: tag => new MockDomNode(tag),
  };
  globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible" });

  try {
    const leftDocID = "20260501000000-longlft";
    const rightDocID = "20260502000000-longrgt";
    const totalBlocks = 40;
    const makeBlockID = (prefix, idx) =>
      `202605010000${String(idx).padStart(2, "0")}-${prefix}000${String(idx).padStart(3, "0")}`;

    const fullLeftHtml = Array.from({ length: totalBlocks }, (_, i) => {
      const idx = i + 1;
      return `<div data-node-id="${makeBlockID("l", idx)}" data-type="NodeParagraph"><div contenteditable="true">第 ${idx} 段公共内容</div></div>`;
    }).join("");
    const fullRightHtml = Array.from({ length: totalBlocks }, (_, i) => {
      const idx = i + 1;
      const text = idx === 20 ? "第 20 段公共内容（右侧新增词）" : `第 ${idx} 段公共内容`;
      return `<div data-node-id="${makeBlockID("r", idx)}" data-type="NodeParagraph"><div contenteditable="true">${text}</div></div>`;
    }).join("");

    const bus = new Map();
    const layoutParent = { direction: "lr", children: [] };
    const emitSwitchProtyle = () => {
      for (const fn of bus.get("switch-protyle") ?? []) fn({ detail: {} });
    };
    const leftWnd = createWnd(0, layoutParent, emitSwitchProtyle);
    const rightWnd = createWnd(400, layoutParent, emitSwitchProtyle);
    layoutParent.children.push(leftWnd, rightWnd);

    const leftEntry = createEditorModel({
      id: leftDocID,
      notebook: "box1",
      title: "长文档",
      blockID: makeBlockID("l", 31),
      text: "第 31 段公共内容",
      rectLeft: 0,
      wnd: leftWnd,
      layoutParent,
    });
    const rightEntry = createEditorModel({
      id: rightDocID,
      notebook: "box1",
      title: "长文档",
      blockID: makeBlockID("r", 1),
      text: "第 1 段公共内容",
      rectLeft: 400,
      wnd: rightWnd,
      layoutParent,
    });

    const mountSlice = (protyle, prefix, startIdx, endIdx, rectLeft) => {
      const blocks = [];
      for (let idx = startIdx; idx <= endIdx; idx++) {
        const blk = new MockDomNode("DIV", {
          "data-node-id": makeBlockID(prefix, idx),
          "data-type": "NodeParagraph",
        });
        const offsetIdx = idx - startIdx;
        blk._rect = {
          left: rectLeft + 16,
          top: 40 + offsetIdx * 60,
          right: rectLeft + 360,
          bottom: 90 + offsetIdx * 60,
          width: 344,
          height: 50,
        };
        const edit = new MockDomNode("DIV", { contenteditable: "true" });
        edit.textContent = prefix === "r" && idx === 20 ? "第 20 段公共内容（右侧新增词）" : `第 ${idx} 段公共内容`;
        blk.append(edit);
        blocks.push(blk);
      }
      protyle.wysiwyg.element.replaceChildren(...blocks);
    };

    // Left starts mounted at blocks 31..36, while Right starts mounted at disjoint blocks 1..6!
    mountSlice(leftEntry.protyle, "l", 31, 36, 0);
    mountSlice(rightEntry.protyle, "r", 1, 6, 400);
    leftEntry.protyle.block.scroll = true;
    leftEntry.protyle.block.blockCount = totalBlocks;
    rightEntry.protyle.block.scroll = true;
    rightEntry.protyle.block.blockCount = totalBlocks;

    let rightSliderIndex = 1;
    const rightSetIndexCalls = [];
    rightEntry.protyle.scroll = {
      lastScrollTop: 0,
      inputElement: { value: "1" },
      setCurrentIndex(_protyle, index) {
        rightSliderIndex = index;
        this.inputElement.value = String(index);
      },
      setIndex(protyle) {
        const requestedIdx = Number.parseInt(this.inputElement.value, 10) || rightSliderIndex;
        rightSetIndexCalls.push(requestedIdx);
        // Simulate SiYuan's `/api/filetree/getDoc` + `onGet` loading 8 blocks starting at `requestedIdx`
        const endIdx = Math.min(totalBlocks, requestedIdx + 7);
        mountSlice(protyle, "r", requestedIdx, endIdx, 400);
        for (const fn of bus.get("loaded-protyle-static") ?? []) {
          fn({ detail: { protyle } });
        }
      },
    };

    let getBlockDomCalls = 0;
    const mockKernel = {
      async post(endpoint, payload) {
        if (endpoint === "/api/block/getDocInfo") {
          return { data: { id: payload.id, rootID: payload.id, name: "长文档" } };
        }
        if (endpoint === "/api/filetree/getHPathByID") {
          return { data: "/长文档" };
        }
        if (endpoint === "/api/block/getBlockDOM") {
          getBlockDomCalls++;
          return { data: { id: payload.id, dom: payload.id === leftDocID ? fullLeftHtml : fullRightHtml } };
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
      },
    };

    const bridge = {
      getEditorModels: () => [leftEntry.model, rightEntry.model],
      openDocTab: async () => leftEntry.tab,
      createDialog: () => ({ element: new MockDomNode("DIV"), destroy() {} }),
      getNotebookName: () => "笔记本",
    };

    const plugin = {
      app: {},
      i18n: { diff: { status: { comparing: "比较中", diff: "差异 ${current}/${total}", equal: "无差异" } } },
      loadData: async () => null,
      saveData: async () => {},
      eventBus: {
        on(type, fn) {
          if (!bus.has(type)) bus.set(type, new Set());
          bus.get(type).add(fn);
        },
        off(type, fn) {
          bus.get(type)?.delete(fn);
        },
      },
    };

    setFrontendResolver(() => "desktop");
    const settings = new SettingsManager(
      plugin,
      [
        {
          id: "document-diff",
          titleKey: "t",
          descriptionKey: "d",
          defaultEnabled: true,
          file: "feature-document-diff-settings.json",
          codec: documentDiffSettingsCodec,
          create: () => ({}),
          settingsView: () => null,
        },
      ],
      async () => new Response(JSON.stringify({ code: 404 }), { status: 202 }),
    );
    await settings.load();

    const debugLogs = [];
    const logger = {
      isDebugEnabled: true,
      debug(msg, data) { debugLogs.push({ msg, data }); },
      info() {},
      warn() {},
      error() {},
    };

    let toolbarActions;
    const feature = new DocumentDiffFeature(plugin, settings, {
      bridge,
      mountToolbar: (_init, actions) => {
        toolbarActions = actions;
        return { update() {}, dispose() {} };
      },
      kernel: mockKernel,
    });

    const menus = new MenuRegistry(() => true, err => { throw err; });
    const feedback = new UiFeedback(undefined, () => {});
    await feature.activate({ plugin, settings, menus, logger, feedback });

    // Launch via Entry B (visible split panes)
    const topbarItems = [];
    menus.render("topbar", { addItem: i => topbarItems.push(i) }, { location: "topbar" });
    topbarItems[0].click();
    await new Promise(r => setTimeout(r, 40));

    assert.equal(getBlockDomCalls, 2, "Initial comparison fetches left and right BlockDOM once each");

    // Scroll Left while Left is at blocks 31..36 and Right is at disjoint blocks 1..6:
    leftEntry.protyle.contentElement.scrollTop = 120;
    leftEntry.protyle.contentElement.emit("scroll");

    // Wait for 90ms slice-jump debounce
    await new Promise(r => setTimeout(r, 140));

    assert.equal(rightSetIndexCalls.length, 1, "Disjoint scroll triggers protyle.scroll.setIndex on the opposite pane");
    assert.ok(rightSetIndexCalls[0] >= 18 && rightSetIndexCalls[0] <= 32, `Expected slider start index near 32, got ${rightSetIndexCalls[0]}`);
    assert.equal(
      getBlockDomCalls,
      2,
      "loaded-protyle-static from virtualized slice jump must NOT re-fetch /api/block/getBlockDOM",
    );
    assert.ok(
      rightEntry.protyle.contentElement.scrollTop > 0,
      "Opposite pane scrollTop aligns to the target block after loading the disjoint slice",
    );
    assert.ok(
      debugLogs.some(entry => entry.msg.includes("scroll-disjoint-slice-jump")),
      "Debug logger records scroll-disjoint-slice-jump diagnostics",
    );
    assert.ok(
      debugLogs.some(entry => entry.msg.includes("scroll-slice-aligned")),
      "Debug logger records scroll-slice-aligned diagnostics",
    );

    // Non-scroll keydown (e.g. pressing Control/c) on right pane must NOT cancel pending slice sync or flip static driver
    rightEntry.protyle.element.emit("keydown", { key: "Control" });

    // Adjacent boundary dynamic load: when `data-top` is already set by frame 1 `loadDynamic`,
    // frame 2 wheel scroll must NOT fall through to `setIndex`!
    mountSlice(leftEntry.protyle, "l", 1, 16, 0);
    mountSlice(rightEntry.protyle, "r", 1, 6, 400);
    // Shift left blocks' viewport rects for `scrollTop = 860` so block 15 (`targetRootIndex = 15`,
    // `distance = 15 - 6 = 9 <= adjacentThreshold`, `readingContentY = 908 > 340 + 500`) is at reading line!
    leftEntry.protyle.contentElement.scrollTop = 860;
    for (const child of leftEntry.protyle.wysiwyg.element.children) {
      child._rect = { ...child._rect, top: child._rect.top - 860, bottom: child._rect.bottom - 860 };
    }
    let loadDynamicCalls = 0;
    rightEntry.protyle.scroll.loadDynamic = protyle => {
      if (protyle.wysiwyg.element.hasAttribute("data-top")) return false;
      loadDynamicCalls++;
      protyle.wysiwyg.element.setAttribute("data-top", "0");
      return true;
    };
    const prevSetIndexCount = rightSetIndexCalls.length;
    leftEntry.protyle.contentElement.emit("wheel");
    leftEntry.protyle.contentElement.emit("scroll"); // Frame 1 -> starts loadDynamic & sets data-top
    leftEntry.protyle.contentElement.scrollTop = 870;
    leftEntry.protyle.contentElement.emit("scroll"); // Frame 2 (16ms later while data-top is active) -> must NOT schedule setIndex!
    await new Promise(r => setTimeout(r, 130));
    assert.equal(loadDynamicCalls, 1);
    assert.equal(rightSetIndexCalls.length, prevSetIndexCount, "In-flight loadDynamic must not fall through to setIndex");

    toolbarActions.onClose();
    await feature.deactivate();
  } finally {
    globalThis.document = prevDoc;
    globalThis.getComputedStyle = prevStyle;
  }
});
