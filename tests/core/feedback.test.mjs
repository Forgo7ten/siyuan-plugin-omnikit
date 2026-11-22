import { test } from "node:test";
import assert from "node:assert/strict";
import { FeatureScope } from "../../src/core/framework/FeatureScope.ts";
import { UiFeedback, isAbortError } from "../../src/core/feedback/UiFeedback.ts";
import { PluginStatusBar } from "../../src/core/feedback/PluginStatusBar.ts";
import { setFrontendResolver } from "../../src/core/host/Platform.ts";

test("UiFeedback prepends [OmniKit] prefix without duplication", () => {
  const notices = [];
  const feedback = new UiFeedback(undefined, msg => notices.push(msg));

  feedback.notify("测试通知");
  assert.equal(notices.length, 1);
  assert.equal(notices[0], "[OmniKit] 测试通知");

  feedback.notify("[OmniKit] 已有前缀");
  assert.equal(notices.length, 2);
  assert.equal(notices[1], "[OmniKit] 已有前缀");
});

test("UiFeedback debounces identical messages within 300ms", async () => {
  const notices = [];
  const feedback = new UiFeedback(undefined, msg => notices.push(msg));

  feedback.notify("高频消息");
  feedback.notify("高频消息");
  feedback.notify("高频消息");
  assert.equal(notices.length, 1);

  // Different messages are not suppressed
  feedback.notify("另一条消息");
  assert.equal(notices.length, 2);

  // After 350ms, same message can be emitted again
  await new Promise(resolve => setTimeout(resolve, 350));
  feedback.notify("高频消息");
  assert.equal(notices.length, 3);
});

test("UiFeedback respects FeatureScope lifecycle and discards notices when inactive", () => {
  const scope = new FeatureScope();
  const notices = [];
  const feedback = new UiFeedback(scope, msg => notices.push(msg));

  feedback.notify("激活时发送");
  assert.equal(notices.length, 1);

  scope.dispose();
  assert.equal(scope.active, false);

  feedback.notify("销毁后发送");
  assert.equal(notices.length, 1);
});

test("UiFeedback silently swallows AbortError and normal cancellation", () => {
  const notices = [];
  const feedback = new UiFeedback(undefined, msg => notices.push(msg));

  const abortErr = new DOMException("Operation aborted", "AbortError");
  assert.equal(isAbortError(abortErr), true);
  feedback.handleError(abortErr, "不应弹出");
  assert.equal(notices.length, 0);

  const regularErr = new Error("网络断开");
  assert.equal(isAbortError(regularErr), false);
  feedback.handleError(regularErr);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /网络断开/);

  // SiYuan Plugin.saveData/removeData rejects with plain { code, msg, data: null }
  feedback.handleError({ code: -1, msg: "保存配置失败", data: null });
  assert.equal(notices.length, 2);
  assert.equal(notices[1], "[OmniKit] 保存配置失败 (code -1)");
  assert.doesNotMatch(notices[1], /\[object Object\]/);
});

test("UiFeedback copyable copies text and emits notice when active", async () => {
  const scope = new FeatureScope();
  let copiedText = "";
  const notices = [];
  const feedback = new UiFeedback(
    scope,
    msg => notices.push(msg),
    async text => { copiedText = text; },
  );

  const ok = await feedback.copyable("assets/test.png", "已复制路径");
  assert.equal(ok, true);
  assert.equal(copiedText, "assets/test.png");
  assert.equal(notices.length, 1);
  assert.equal(notices[0], "[OmniKit] 已复制路径");

  scope.dispose();
  const failed = await feedback.copyable("assets/other.png", "不应复制");
  assert.equal(failed, false);
});

test("UiFeedback copyable returns false and suppresses notice if scope becomes inactive during clipboard await", async () => {
  const scope = new FeatureScope();
  const notices = [];
  const feedback = new UiFeedback(
    scope,
    msg => notices.push(msg),
    async () => {
      scope.dispose();
    },
  );

  const ok = await feedback.copyable("assets/late.png", "不应弹出");
  assert.equal(ok, false);
  assert.equal(notices.length, 0);
});

test("PluginStatusBar manages tasks, updates text, and cleans up on dispose", () => {
  setFrontendResolver(() => "desktop");
  const statusBar = new PluginStatusBar();
  let registeredElement = null;
  const mockPlugin = {
    addStatusBar(options) {
      registeredElement = options.element;
      return options.element;
    },
  };

  // Mock global document if running in node test environment
  if (typeof globalThis.document === "undefined") {
    globalThis.document = {
      createElement(tag) {
        const classList = new Set();
        const attrs = new Map();
        return {
          tagName: tag,
          isConnected: true,
          get className() { return [...classList].join(" "); },
          set className(val) {
            classList.clear();
            val.split(/\s+/).filter(Boolean).forEach(c => classList.add(c));
          },
          classList: {
            add(...names) { names.forEach(n => classList.add(n)); },
            remove(...names) { names.forEach(n => classList.delete(n)); },
            contains(name) { return classList.has(name); },
          },
          setAttribute(k, v) { attrs.set(k, v); },
          getAttribute(k) { return attrs.get(k); },
          removeAttribute(k) { attrs.delete(k); },
          textContent: "",
          title: "",
          remove() {},
        };
      },
      body: {
        classList: { contains() { return false; } },
      },
    };
  }

  statusBar.mount(mockPlugin);
  assert.equal(statusBar.isMounted(), true);
  assert.ok(registeredElement);
  assert.ok(registeredElement.classList.contains("omnikit-status-bar"));
  assert.ok(registeredElement.classList.contains("fn__none"));

  // Update task
  statusBar.update("task-1", "图片压缩 1/5");
  assert.equal(registeredElement.textContent, "图片压缩 1/5");
  assert.equal(registeredElement.title, "图片压缩 1/5");
  assert.equal(registeredElement.classList.contains("fn__none"), false);

  // Clear task
  statusBar.clear("task-1");
  assert.equal(registeredElement.textContent, "");
  assert.equal(registeredElement.classList.contains("fn__none"), true);

  // Dispose
  statusBar.dispose();
  assert.equal(statusBar.isMounted(), false);
});

test("PluginStatusBar shows the most recently updated task, not the last inserted", () => {
  setFrontendResolver(() => "desktop");
  const statusBar = new PluginStatusBar();
  let registeredElement = null;
  const mockPlugin = {
    addStatusBar(options) {
      registeredElement = options.element;
      return options.element;
    },
  };

  statusBar.mount(mockPlugin);
  statusBar.update("a", "1");
  statusBar.update("b", "2");
  assert.equal(registeredElement.textContent, "2");

  statusBar.update("a", "3");
  assert.equal(registeredElement.textContent, "3");

  statusBar.clear("a");
  assert.equal(registeredElement.textContent, "2");

  statusBar.dispose();
});

test("PluginStatusBar.mount treats detached element (isConnected === false) as unmounted", () => {
  setFrontendResolver(() => "desktop");
  const origDoc = globalThis.document;
  globalThis.document = {
    createElement(tag) {
      const classList = new Set();
      return {
        tagName: tag,
        isConnected: false,
        get className() { return [...classList].join(" "); },
        set className(val) {
          classList.clear();
          val.split(/\s+/).filter(Boolean).forEach(c => classList.add(c));
        },
        classList: {
          add(...names) { names.forEach(n => classList.add(n)); },
          remove(...names) { names.forEach(n => classList.delete(n)); },
          contains(name) { return classList.has(name); },
        },
        setAttribute() {},
        getAttribute() {},
        removeAttribute() {},
        textContent: "",
        title: "",
        remove() {},
      };
    },
    body: { classList: { contains() { return false; } } },
  };
  try {
    const statusBar = new PluginStatusBar();
    statusBar.mount({ addStatusBar: options => options.element });
    assert.equal(statusBar.isMounted(), false);
    statusBar.update("task-1", "should noop");
    statusBar.clear("task-1");
  } finally {
    globalThis.document = origDoc;
  }
});
