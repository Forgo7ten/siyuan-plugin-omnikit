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

## 2. 大网页保护与双轨网络模型 (`services/dual-track-fetcher.ts` & `stream-parser.ts`)

为了防范恶意或超大网页（动辄数兆甚至数十兆）导致主线程内存暴涨与流量浪费，系统完整保留高效的**流式截断与 64KB 前置截取机制**：

### 2.1 双轨分流网络
1. **桌面端直连流式截断 (`desktop`)**：
   - 直接使用 `window.fetch` 发起流式网络请求；
   - 前置以流式（Chunk Stream）方式只读前置 **32KB ~ 64KB** 二进制流；
   - 在 Chunk 接收与解码过程中，正则检测到 `</head>` 或 `</title>` 闭合标签时，立即调用 `ReadableStreamDefaultReader.cancel()` 主动掐断底层 TCP 连接，停止接收后续网络流，实现底层物理节流；
2. **移动端内核代理 (`mobile` / `browser-mobile`)**：
   - 统一通过思源内核 `/api/network/forwardProxy`（携带 `"responseEncoding": "base64"`）代理转发，彻底规避浏览器跨域限制；
   - 前端接收到 Base64 数据后，**严格仅截取前 64KB 字节二进制流**送入嗅探器与解析引擎，丢弃后续正文数据，规避不必要的全量文本解码与内存开销；
3. **Core 平台 User-Agent 统一复用**：
   - 读取 Core 平台配置中的 `general.userAgent`；留空时默认使用现代 Chrome 浏览器 User-Agent 进行请求头伪装。

### 2.2 万国码嗅探与实体还原
1. 优先探测 HTTP 响应头 `Content-Type: charset=...`；未声明时在前置 Chunk 中嗅探 `<meta charset="...">`；
2. 获取编码标识（GBK、Big5、Shift-JIS、UTF-8 等）后，调用浏览器原生 `TextDecoder(encoding)` 规范化转码；
3. 统一调用思源官方内置的 `window.Lute.UnEscapeHTMLStr` 接口，完整还原标准实体与 Unicode 实体。

---

## 3. 原生内存受控事务写回 (`services/safe-writer.ts`)

### 3.1 消除磁盘异步重读冲突（Live State 优先原则）
在当前处于用户打开并编辑的 Protyle 编辑器中，**内存 DOM 是唯一的实时真理（Live State）**：
- 严禁向后端磁盘 API 发起读回比对（避免用户正在打字时因磁盘滞后毫秒级而被误判为“冲突”拒改）；
- 写前核验目标 `linkElement` 是否依然在当前 DOM 树中，且其内部文本是否未被修改；
- 核验通过后，直接在内存 DOM 中更新 `linkElement.textContent`；
- 调用思源官方事务 API：
  ```typescript
  protyle.updateTransactionElement(target.blockElement, oldBlockOuterHTML);
  ```
- **架构收益**：
  - 零多余 HTTP 往返；
  - 100% 原生支持思源编辑器的 `Ctrl+Z`（撤销）与 `Ctrl+Y`（重做）；
  - 彻底杜绝打字期间被自身防御机制锁死的假性冲突问题。

### 3.2 块级批量同块聚合写回
在块级批量提取模式下，若同一块内包含多个提取完成的链接，系统进行**按块收口**：
- 在该块所属链接全部拉取完毕后，在一次 `updateTransactionElement` 事务中将该块内所有已完成的链接一并提交；
- 消除同块多次提交引发的历史版本碎片，使用户仅需按一次 `Ctrl+Z` 即可一次性撤销当前块的所有标题替换。

---

## 4. 短期内存 LRU 缓存与任务代际保护 (`services/title-cache.ts`)

1. **短期内存 LRU 结构**：
   - 内存驻留，最大容量 100 条，TTL 有效期 5 分钟；
   - 自动模式优先查询内存缓存；若命中直接复用，避免同一文档重复粘贴相同链接时消耗带宽；
   - 手动模式强制绕过缓存，发起真实联网更新；
2. **任务代际保护 (Generation Ticket)**：
   - 每个缓存条目附加自增代际版本号；手动提取更新后代际增加，阻止先前迟到的自动请求覆盖最新结果；
3. **零磁盘持久化**：
   - 缓存仅存在于内存，功能停用或重载时随作用域立即销毁，不向磁盘写入任何文件。
