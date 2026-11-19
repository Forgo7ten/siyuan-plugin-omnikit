# OmniKit · 自动标题链接技术设计文档 (Titled Link DESIGN)

> **文档性质**：具体技术架构、模块职责、网络模型与事务写回契约（How）。代码重构或修复 BUG 时直接更新本文件，不影响业务需求 PRD。  
> **对应产品需求**：[PRD.md](PRD.md)  
> **适用平台**：OmniKit 桌面端与移动端

---

## 1. 架构总览与模块划分

自动标题链接特性（`src/features/titled-link/`）包含 **事件门面层**、**业务调度门面**、**双轨网络与流式解析服务**、**原生事务写回服务** 及 **短期内存缓存**。

```
┌────────────────────────────────────────────────────────┐
│                   TitledLinkFeature                    │
│      (事件监听: 菜单/粘贴/Protyle销毁/FeatureScope集中托管)      │
└───────────────────────────┬────────────────────────────┘
                            │ 调度委托
┌───────────────────────────▼────────────────────────────┐
│                  TitledLinkController                  │
│    (准入防抖 / 任务Token仲裁 / 并发池 / 用户提示收口)    │
├─────────────────┬──────────────────┬───────────────────┤
│ services/       │ services/        │ services/         │
│ dual-track      │ stream-parser    │ safe-writer       │
│ (桌面/移动网络) │ (64KB大网页保护) │ (原生内存受控事务)│
├─────────────────┴──────────────────┴───────────────────┤
│ services/title-cache (5分钟/100条短期内存LRU缓存)        │
└────────────────────────────────────────────────────────┘
```

---

## 2. 大网页保护与双轨网络模型 (`services/dual-track-fetcher.ts` & `stream-parser.ts` & `static-file.ts`)

为限制超大网页的内存与网络消耗并正确解析多语言字符集，系统实施流式截断、64KB 字节上限截取与字符集嗅探解码机制：

### 2.1 双轨分流网络与流量熔断
1. **桌面客户端直连流式截断 (`desktop` / `desktop-window`)**：
   - 直接使用 `window.fetch` 发起流式网络请求，默认超时 8 秒；
   - `stream-parser.ts` 使用单实例 `LATIN1_DECODER`，在流式分块循环中仅对新增 `chunk` 增量解码，并结合尾部 **64 字符重叠窗口**检测 `</head>` 或 `</title>` 闭合标签（兼容标签内含空白且跨分片的场景），在全部数据读取完成后仅执行 1 次 `concatenate` 合并；
   - 匹配闭合标签或到达 **64KB (`DEFAULT_MAX_BYTES`)** 上限时，立即调用 `ReadableStreamDefaultReader.cancel()` 主动取消底层网络流，控制主线程内存占用；
2. **浏览器与移动端内核代理 (`mobile` / `browser-desktop` / `browser-mobile`)**：
   - 统一通过思源内核 `/api/network/forwardProxy`（携带 `"responseEncoding": "base64"`）代理转发；
   - `decodeBase64` 将字符解码上限绑定至目标 `maxBytes`（`maxChars = Math.ceil((maxBytes + 1) / 3) * 4`，默认 `65_536` 字节对应 `87_384` 字符以维持 `truncated: true` 检测），通过单遍 $O(\text{maxChars})$ 扫描跳过 ASCII 空白字符、校验 `[A-Za-z0-9+/=]` 字符集与尾部 `=` 填充状态，确认有效后交由 `globalThis.atob(cleaned)` 解码，再送入嗅探器与解析引擎；
3. **非网页静态文件免抓取 (`static-file.ts`)**：
   - 识别常见非网页扩展名后提取 Pathname 末尾段并执行 `decodeURIComponent`（包裹 `try/catch` 防异常），直接返回解码后文件名而不发起网络请求；
4. **Core 平台 User-Agent 统一复用**：
   - 读取 Core 平台配置中的 `general.userAgent`；留空时默认使用现代 Chrome 浏览器 User-Agent。

### 2.2 多字符集嗅探与实体还原 (`stream-parser.ts` & `title-normalizer.ts`)
1. 优先探测 HTTP 响应头 `Content-Type: charset=...`；未声明时在前置 8KB 字节中嗅探 `<meta charset="...">` 或 `<meta http-equiv="Content-Type" content="...; charset=...">`；
2. 获取编码标识（GBK、GB2312、Big5、Shift-JIS、EUC-JP、UTF-8 等，其中 `gb2312` 归一化为 `gbk`）后，调用浏览器原生 `TextDecoder(encoding)` 规范化转码；
3. 统一调用思源官方内置 `window.Lute.UnEscapeHTMLStr`（缺省时回退基础 HTML 实体表）还原标准实体与 Unicode 实体，随后压缩空白并按字素数截断至 `maxTitleLength`。

---

## 3. 原生内存受控事务写回与事件门面 (`services/safe-writer.ts` & `TitledLinkFeature.ts`)

### 3.1 活动编辑器判定与实时 DOM 核验 (`isActiveEditor` vs `isLiveOccurrenceValid`)
系统将“编辑器活性判定”与“目标节点完整性校验”严格分离：
- **`isActiveEditor(target)`**：兼容真实 `Protyle` 包装层级（`const host = (protyle as any).protyle ?? protyle`）与单测 Mock，校验 `updateTransactionElement` 方法存在、`destroyed !== true`、若存在 `host.element` 则其处于在树连接状态且包含 `.protyle` 类、若存在 `host.wysiwyg?.element` 则处于在树连接状态，且 `host.block?.rootID === target.rootID`（可读时）；
- **`isLiveOccurrenceValid(target)`**：核验 `blockElement.isConnected !== false`、`linkElement.isConnected !== false`、`linkElement.closest("[data-node-id]") === blockElement`、`blockElement.getAttribute("data-node-id") === target.blockID`，以及 `data-href`、`textContent`、`data-title` 未被外部编辑篡改；
- **禁止活动编辑器回退 `updateBlock`**：当 `isActiveEditor(target)` 为真但节点已被用户删除或修改（`!isLiveOccurrenceValid(target)`）时，严禁回退调用 `/api/block/updateBlock`，直接返回 `"conflict"`；仅当 `!isActiveEditor(target)`（真正无编辑器、已销毁或已切换文档）时才进入非活动后台写回路径。

### 3.2 局部修改、光标恢复与受控事务提交 (`applyLinkTitle`)
- **精准光标保护**：封装 `applyLinkTitle(link, title, replaceTitle)` 在修改 `link.textContent` 前检查 `Selection` 是否为折叠光标且严格位于 `link` 内部（`range.collapsed && link.contains(range.startContainer) && link.contains(range.endContainer)`）；仅在成立时，于更新 `textContent` 后、`updateTransactionElement` 前将折叠选区恢复至 `link.firstChild` 文本节点末尾（或 `(link, link.childNodes.length)` 回退），避免破坏用户在其他段落的焦点并在非 DOM 测试环境安全跳过；若 `updateTransactionElement` 失败回滚 `textContent` 后，基于还原的新文本节点按原折叠偏移重建选区；
- **提交受控事务**：调用 `protyle.updateTransactionElement(target.blockElement, oldBlockOuterHTML)` 纳入思源原生 `Ctrl+Z` / `Ctrl+Y` 撤销栈与文档历史版本，并避免用户连续输入期间因磁盘异步落盘延迟导致的假性冲突。

### 3.3 非活动编辑器后台更新：文档身份核验与严格 `ordinal` 匹配
当 `!isActiveEditor(target)` 时（例如用户已关闭页签或切换文档）：
- 在块写租约内先调用 `/api/block/getBlockInfo` 核验实时 `rootID` 与 `box` 是否仍与捕获目标一致（防止块跨文档移动后误写）；
- 再调用 `/api/block/getBlockDOM` 获取块最新 DOM，严格按 `links[target.ordinal]` 精确校验目标节点（不执行模糊 `links.find` 回退），单条与批量写回统一委托至 `commitLinkTitles` 共用逻辑；
- 校验通过后调用思源内核 `/api/block/updateBlock`（`dataType: "dom", lockType: true`），阻止后台写入意外改变块主类型；保留 `LinkWriterKernel` 宽接口及 `updateRes.code` 检查，以内核返回 `code === 0` 作为落盘确认依据（注：因思源 `/api/block/updateBlock` 不提供原子 CAS，写前身份/DOM 校验与写入之间仍存在极窄外部并发窗口，属于已知宿主 API 边界）。

### 3.4 批量快照同步占位、写租约内代际复核与菜单监听
- **批量并发前置快照与租约内 Token 复核**：`TitledLinkController.runBatch` 在启动并发池（上限 `3`）之前，同步一次性完成全部目标链接的 `captureLinkTarget` 快照捕获与 `tokens.set(link, token)` 代际占位；`runLink` 与 `runBatch` 同时向 `commitLinkTitles` 传入 `isCurrent` 代际校验回调，在进入 `withLinkBlockLease`、`awaitCompositionEnd` 及核验网络读取返回后、真正改写 DOM 或调用 `updateBlock` 前逐项复核，过时项返回 `"superseded"` 并跳过写入，防止排队等待期间被新手动请求取代后误写旧标题；
- **块级聚合写回**：同块内所有链接拉取完毕后，在单次 `updateTransactionElement`（或单次 `updateBlock`）中一并提交；
- **菜单过滤与输入法追踪生命周期**：`TitledLinkFeature` 监听 `open-menu-link`（仅放行 `isHttpUrl(href ?? "")`）、`click-blockicon`、`paste` 与 `destroy-protyle`；`attachCompositionTracking` 在 `destroy-protyle` 与 `onDisable` 统一注销事件并移除映射。

---

## 4. 短期内存 LRU 缓存与任务代际保护 (`services/title-cache.ts`)

1. **短期内存 LRU 结构**：
   - 内存驻留，最大容量 100 条，TTL 有效期 5 分钟；
   - 自动模式优先查询内存缓存，命中时直接复用；手动模式强制绕过缓存读取，发起真实联网更新；批量模式不读取也不写入 `TitleCache`（仅通过 `pending` Map 共享并发在途请求去重）；
   - **降级域名不入缓存**：当拉取失败并降级为网站域名（`fallback: true`）时，自动与手动模式均不写入 `TitleCache`，保障后续触发仍可重新获取真实网页标题；
2. **任务代际保护 (Generation Ticket)**：
   - 每个缓存条目附加自增代际版本号；手动提取更新后代际增加，阻止先前迟到的自动请求覆盖最新结果；
3. **零磁盘持久化**：
   - 缓存仅存在于内存，功能停用或重载时随作用域立即销毁，不向磁盘写入任何文件。
