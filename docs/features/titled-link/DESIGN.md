# OmniKit · 自动标题链接技术设计文档 (Titled Link DESIGN)

> **文档性质**：具体技术架构、模块职责、网络模型与事务写回规范（How）。代码重构或修复 BUG 时直接更新本文件，不影响业务需求 PRD。  
> **对应产品需求**：[PRD.md](PRD.md)  
> **适用平台**：OmniKit 全端通用（`desktop`、`desktop-window`、`browser-desktop`、`mobile`、`browser-mobile`）

---

## 1. 架构总览与模块划分

自动标题链接功能（`src/features/titled-link/`）由事件入口、任务控制器、网络读取与解析服务、编辑器事务写回服务和短期内存缓存组成。

```
┌────────────────────────────────────────────────────────┐
│                   TitledLinkFeature                    │
│      (监听菜单、粘贴和编辑器关闭事件，由 FeatureScope 管理)      │
└───────────────────────────┬────────────────────────────┘
                            │ 调用
┌───────────────────────────▼────────────────────────────┐
│                  TitledLinkController                  │
│    (重复触发检查 / 请求版本检查 / 并发池 / 统一显示提示)    │
├─────────────────┬──────────────────┬───────────────────┤
│ services/       │ services/        │ services/         │
│ dual-track      │ stream-parser    │ safe-writer       │
│ (桌面/移动网络) │ (最多读取64KB)   │ (编辑器事务写回)  │
├─────────────────┴──────────────────┴───────────────────┤
│ services/title-cache (5分钟/100条短期内存LRU缓存)        │
└────────────────────────────────────────────────────────┘
```

---

## 2. 大网页保护与双轨网络模型 (`services/dual-track-fetcher.ts` & `stream-parser.ts` & `static-file.ts`)

为限制超大网页的内存与网络消耗并正确解析多语言字符集，系统实施流式截断、64KB 字节上限截取与字符集识别解码机制：

### 2.1 桌面端和浏览器端的网络请求与失败分类
1. **桌面客户端直连流式截断 (`desktop` / `desktop-window`)**：
   - 直接使用 `window.fetch` 发起流式网络请求，默认超时 8 秒；
   - `stream-parser.ts` 使用 `LATIN1_DECODER`，每次只解码新收到的数据块，并保留末尾 **64 个字符**，以识别分块边界上的 `</head>`。遇到 `</title>` 时继续读取，以便获取 `<title>` 之后的 `og:title` 或 `twitter:title`。全部数据读取完成后合并一次；
   - 读到 `</head>` 或达到 **64KB (`DEFAULT_MAX_BYTES`)** 上限时，调用 `ReadableStreamDefaultReader.cancel()` 停止读取；
2. **浏览器和移动端使用思源内核转发 (`mobile` / `browser-desktop` / `browser-mobile`)**：
   - 统一通过思源内核 `/api/network/forwardProxy`（携带 `"responseEncoding": "base64"`、`Range: bytes=0-65535` 与 `Accept-Encoding: identity`）代理转发；收到 `416` 时移除 `Range` 重试一次，若目标服务器忽略 `Range` 返回全量内容则仍由本地截取解码上限；
   - `decodeBase64` 根据 `maxBytes` 限制待解码字符数（默认 65,536 字节对应 87,384 个字符，以保留 `truncated: true` 检测所需的一个额外字节）。扫描一次内容，跳过 ASCII 空格，检查 `[A-Za-z0-9+/=]` 字符和末尾 `=` 后，再调用 `globalThis.atob(cleaned)` 解码并交给后续解析；
3. **不请求非网页文件 (`static-file.ts`)**：
   - 识别常见非网页扩展名后，提取 URL 路径最后一段并尝试用 `decodeURIComponent` 解码；若解码抛出异常，回退使用原始未解码的 `encodedName` 字符串，不返回 `null` 也不发起网页请求；
4. **使用 Core 的 User-Agent 设置**：
   - 读取 Core 平台配置中的 `general.userAgent`；留空时默认使用现代 Chrome 浏览器 User-Agent（不设 Feature 独立 UA 字段）。
5. **失败原因 (`TitleFetchFailureReason`)**：
   - HTTP 非 2xx 响应记录为 `"http"` 并保留状态码；请求超时记录为 `"timeout"`；DNS 或网络错误记录为 `"network"`；主动中止记录为 `"aborted"`；挑战页记录为 `"challenge"`；没有可用标题记录为 `"missing-title"`。是否使用网站域名作为标题由 `fallbackToHostname` 设置决定。

### 2.2 多字符集识别与实体还原 (`stream-parser.ts` & `title-normalizer.ts`)
1. 先读取 HTTP 响应头中的 `Content-Type: charset=...`；如果没有声明，则在前 8KB 内容中查找 `<meta charset="...">` 或 `<meta http-equiv="Content-Type" content="...; charset=...">`；
2. 获取编码标识（GBK、GB2312、Big5、Shift-JIS、EUC-JP、UTF-8 等，其中 `gb2312` 归一化为 `gbk`）后，调用浏览器原生 `TextDecoder(encoding)` 规范化转码；
3. 统一调用思源官方内置 `window.Lute.UnEscapeHTMLStr`（缺省时回退基础 HTML 实体表）还原标准实体与 Unicode 实体；`sanitizeWhitespaceAndControls` 先将所有连续 Unicode 空白字符（`\s+/gu`，含换行、制表符、全角空格、不间断空格等）压缩为单个半角空格并 `trim()`，再移除 C0/C1 控制字符、双向控制字符及零宽空格 `\u200B`（保留 `\u200C`、`\u200D`）并再次压缩空白，最后按字素数截断至代码中固定的默认常量 `80`（仅通过修改代码调整，不提供 `maxTitleLength` 用户设置项或配置字段）；文本长度不超过上限时不截断，超过上限时截断（上限不超过 3 时直接截取对应长度且不追加 `...`，上限超过 3 时保留 `上限 - 3` 个字素并追加 `...`）。

---

## 3. 原生内存受控事务写回与事件入口 (`services/safe-writer.ts` & `TitledLinkFeature.ts`)

### 3.1 检查编辑器和目标链接 (`isActiveEditor`、`isLiveOccurrenceValid`)
- **`isActiveEditor(target)`**：兼容真实 `Protyle` 包装层级（`const host = (protyle as any).protyle ?? protyle`）与单测 Mock，校验 `updateTransactionElement` 方法存在、`destroyed !== true`、若存在 `host.element` 则其处于在树连接状态且包含 `.protyle` 类、若存在 `host.wysiwyg?.element` 则处于在树连接状态，且 `host.block?.rootID === target.rootID`（可读时）；
- **`isLiveOccurrenceValid(target)`**：核验 `blockElement.isConnected !== false`、`linkElement.isConnected !== false`、`linkElement.closest("[data-node-id]") === blockElement`、`blockElement.getAttribute("data-node-id") === target.blockID`，以及 `data-href`、`textContent`、`data-title` 未被外部编辑篡改；
- **活动编辑器中的冲突与防后台覆盖**：如果 `isActiveEditor(target)` 为真，但链接已被用户删除或修改（`!isLiveOccurrenceValid(target)`），返回 `"conflict"`，不调用 `/api/block/updateBlock`。只要当前文档仍有未销毁的活动编辑器，就走受控事务路径或返回状态，避免误走后台路径覆盖活动编辑状态；只有确认没有可用的目标活动编辑器时，才使用后台写入路径。

### 3.2 更新链接文字和恢复光标 (`applyLinkTitle`)
- `applyLinkTitle(link, title, replaceTitle)` 修改 `link.textContent` 前，检查折叠光标是否位于该链接中（`range.collapsed && link.contains(range.startContainer) && link.contains(range.endContainer)`）。如果是，更新后将光标放在新文字末尾；否则不移动光标。若 `updateTransactionElement` 失败并恢复原文字，则按原来的光标位置重建选区；
- 调用 `protyle.updateTransactionElement(target.blockElement, oldBlockOuterHTML)` 通过思源编辑器事务提交修改，使用户可以使用 `Ctrl+Z` / `Ctrl+Y` 撤销和重做，并记录在文档历史中。

### 3.3 编辑器不可用时的后台写入：整块基线校验、`code: 0` 信任与 `unknown` 重读核实
当 `!isActiveEditor(target)` 且当前文档无未销毁的活动编辑器时（例如用户已关闭页签或切换文档）：
- 在 Core 的同块写入队列中（以 `notebook/blockID` 为键，与 `imageCompressor` 共用），先调用 `/api/block/getBlockInfo` 检查当前 `rootID` 和 `box` 是否仍与目标一致，避免块移动到其他文档后误写；
- 再调用 `/api/block/getBlockDOM` 读取最新内容，剔除 `parent-heading` 等只读渲染属性后与任务开始时捕获的整块 DOM 基线（`originalBlockHTML` 剔除只读渲染属性后）比对，不一致即判定 `"conflict"` 跳过；同时检查 `links[target.ordinal]` 是否仍是目标链接，不搜索其他链接替代。单条和批量更新共用 `commitLinkTitles`；
- 检查通过后调用 `/api/block/updateBlock`（`dataType: "dom", lockType: true`），避免意外改变块类型。收到 `code === 0` 即视为内核已保存，不额外重读；思源接口不支持原子 CAS，因此读取和写入之间仍可能有其他程序修改内容，Core 队列只保证本插件内对同一块的写入依次进行；
- 仅当 `/api/block/updateBlock` 写请求已发出但因超时、断连或等待响应阶段被中止而结果未知时，归类为 `"unknown"`（禁止直接重发写请求），随后重新读取 `/api/block/getBlockDOM` 核实结果：确认目标标题已更新按 `"updated"` 处理，确认内容被改动归 `"conflict"`，确定失败归 `"failed"`，仍无法确认保留 `"unknown"`。块级批量汇总分别统计成功、`conflict`、`failed` 与 `unknown`，单链结果未知时给出对应反馈。

### 3.4 自动粘贴延迟、重复批量请求、旧请求检查和输入法状态
- **自动粘贴固定延迟 `200ms`**：思源 `paste` 事件在将链接转换并插入编辑器前触发，且宿主不提供粘贴完成后的回调事件；因此 `TitledLinkController.scheduleAutoPaste` 在 `paste` 后固定延迟 `200ms`（由控制器顶部常量定义），等待思源原生粘贴完成链接节点插入与初始状态稳定后再检查生成结果；
- `TitledLinkController.runBatch` 不并行启动同一块的重复批量任务；任务启动并发池（最多 3 个链接）前，先为所有目标链接调用 `captureLinkTarget` 保存内容快照，并通过 `tokens.set(link, token)` 记录请求版本；
- `runLink` 和 `runBatch` 将 `isCurrent` 检查传给 `commitLinkTitles`。进入 Core 写入队列、等待输入法结束和网络读取完成后，在修改 DOM 或调用 `updateBlock` 前再次检查请求版本。若已有更新的手动请求，返回 `"superseded"` 并跳过旧请求；
- 同一块中的链接全部读取完后，通过一次 `updateTransactionElement` 或 `updateBlock` 一并提交；
- `TitledLinkFeature` 监听 `open-menu-link`（仅接受 `isHttpUrl(href ?? "")`）、`click-blockicon`、`paste` 和 `destroy-protyle`。`attachCompositionTracking` 在目标编辑器上监听 `compositionstart` / `compositionend`，记录该编辑器是否正在使用输入法。监听使用捕获阶段（`{ capture: true }`），避免被编辑器正文的 `stopPropagation` 阻止。若 10 秒内未收到配对事件，则清除输入状态；分屏时只等待目标链接所在的编辑器。`awaitCompositionEnd` 轮询等待输入法结束的超时时间为 **5 秒**（`imeTimeoutMs = 5_000`）、轮询间隔为 **500ms**（`imePollMs = 500`，避免过短轮询占用 CPU）；超时后返回独立结果状态（如 `"ime-timeout"`，不归类为 `"conflict"`），由控制器反馈提示“用户正在输入，等待超时，已取消更新链接标题”。`destroy-protyle` 和 `onDisable` 时移除监听及状态记录。

---

## 4. 内存缓存和请求版本检查 (`services/title-cache.ts`)

1. **短期内存 LRU 结构**：
   - 内存驻留，最大容量 100 条，TTL 有效期 5 分钟；
   - 自动模式优先查询内存缓存，命中时直接复用；手动模式强制绕过缓存读取，发起真实联网更新；批量模式不读取也不写入 `TitleCache`（仅通过 `pending` Map 共享进行中的并发请求去重）；
   - 仅网页抓取结果写入 `TitleCache`；静态文件本地解析（含手动提取静态文件链接）不写入也不刷新 `TitleCache`；
   - 请求失败并改用网站域名作为标题时（`fallback: true`），自动和手动模式都不写入 `TitleCache`，确保之后仍会重新读取网页；
2. **防止旧请求覆盖新结果**：
   - 使用全局清除版本 `epoch` 和每个 URL 独立的刷新计数（编码为 `epoch * EPOCH_SHIFT + urlGeneration`）。手动刷新某 URL 时只增加该 URL 的计数；`clear()` 增加 `epoch`，使此前开始的请求失效；
3. **缓存只保存在内存中**：
   - 功能停用或重载时清除缓存，不写入文件。
