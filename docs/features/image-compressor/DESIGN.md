# OmniKit · 图片压缩技术设计文档 (Image Compressor DESIGN)

> **文档性质**：具体技术架构、模块职责、算法模型与存储契约（How）。代码重构或修复 BUG 时直接更新本文件，不影响业务需求 PRD。  
> **对应产品需求**：[PRD.md](PRD.md)  
> **适用平台**：OmniKit 全端通用（`desktop`、`desktop-window`、`browser-desktop`、`mobile`、`browser-mobile`）

---

## 1. 架构总览与模块划分

图片压缩特性（`src/features/image-compressor/`）完全自包含在微内核框架下，分为 **编排控制层**、**动作执行层**、**策略与模型层**、**底层服务层** 及 **相似度算法域**。

```
┌──────────────────────────────────────────────────────────────────┐
│                   ImageCompressorFeature 主入口                   │
└─────────────────────────────────┬────────────────────────────────┘
                                  │ 驱动与调度
┌─────────────────────────────────▼────────────────────────────────┐
│             ImageController (全局业务状态与并发编排)              │
├─────────────────┬────────────────────┬───────────────────────────┤
│ actions/        │ policy/            │ services/                 │
│ ├─ AutoUpload   │ ├─ Classifier      │ ├─ SafeBlockWriter        │
│ ├─ SingleImage  │ ├─ Contracts       │ ├─ references (文档与引用定位)│
│ ├─ DocBatch     │ ├─ Settings        │ ├─ assets / download / desktop│
│ └─ RemoteWatcher│ └─ Allowlist       │ └─ ImageOccurrenceResolver│
├─────────────────┴────────────────────┴───────────────────────────┤
│ similarity/ (智能压缩独立算法域)                                   │
│ ├─ ms-ssim.ts (5 尺度多尺度结构相似度纯算法)                       │
│ ├─ adaptive-quality-search.ts (割线法+二分法区间搜索)              │
│ ├─ SimilarityWorkerSession.ts (两阶段通信会话)                   │
│ └─ similarity.worker.ts (内联 Web Worker 线程脚本)                │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. 块级精确改写与写租约契约 (`services/SafeBlockWriter.ts`)

### 2.1 目标位置契约 (`OccurrenceTarget`) 与资产身份模型 (`AssetAddress`)
1. **资产地址身份模型 (`policy/source.ts`)**：
   严格区分资源在 DOM 原文、内核物理路径、逻辑身份与网络读取中的四重表示，单一事实源解析：
   ```typescript
   export interface AssetAddress {
     readonly raw: string;        // DOM 实际字面文本，写前严格比对使用
     readonly kernelPath: string; // 真实内核路径字面 assets/文件名.ext + 可选 ?box=...
     readonly key: string;        // 大小写敏感物理身份键（内核字面路径 + box 归属）
     readonly fetchURL: string;   // 按路径段独立编码的网络读取 URL，仅供浏览器端读取/预览
     readonly box?: string;       // 可选加密笔记本 ID
   }
   ```
   - **字面优先与编码边界**：`/api/asset/upload` 返回值与 DOM 中的 `assets/...` 按字面路径解析，仅对 URL pathname 执行解码，不无条件对字面路径执行 `decodeURIComponent`（确保 `assets/100%.png` 与 `assets/100%25.png` 互不混淆）；
   - **身份键隔离**：`key` 保持大小写敏感并包含 `box` 笔记本归属，不执行无条件 `NFC.toLowerCase()` 合并；`?width=`、`#fragment` 等装饰参数不参与物理身份判定，写回时按位置规则保留展示后缀且不丢失或错串 `?box=`；
   - **历史记录保守迁移**：`feature-image-compressor-records.json` 在升级 `schemaVersion` 前执行只读 dry-run 核验，仅当字面路径与解码候选经思源 API 验证存在唯一无歧义归属时迁移，双存在、双不可达或身份碰撞时保留原数据并输出只读诊断。
2. **目标位置契约 (`OccurrenceTarget`)**：
   严格基于目标元素在块内的物理序号、节点类型与原文比对，杜绝模糊匹配与范围扩散：
   ```typescript
   export interface OccurrenceTarget {
     readonly rootID: string;
     readonly notebook: string;
     readonly blockID: string;
     readonly kind?: "image" | "link";
     readonly attribute?: "data-src" | "src" | "data-href" | "href";
     /** 该元素在所属块内同类候选中的 0-based 有序序号 */
     readonly imageOrdinal: number;
     readonly oldPath: string;
     readonly baselineBlockDOM: string;
   }
   ```

### 2.2 四态写回契约、共享块写租约与内核边界
1. **四态写回结果 (`CommitResult`)**：
   ```typescript
   export type CommitResult =
     | { readonly status: "replaced" }
     | { readonly status: "conflict" }
     | { readonly status: "aborted" }  // 确认尚未向内核发出写请求
     | { readonly status: "unknown" }; // 写请求已发出但确认结果缺失（超时/断连/中止）
   ```
2. **Core 共享块写租约 (`BlockWriteLease`)**：
   - `SafeBlockWriter` 统一接入 Core 共享块写租约（以 `notebook/blockID` 为键，与 `titled-link` 等特性共用同一进程内串行排队队列），排队期间感知 `AbortSignal`，进入临界区后再次核验中止状态；
   - 明确宿主边界：思源 `/api/block/updateBlock` 不提供原子 Compare-And-Swap（CAS），`getBlockDOM → updateBlock` 之间仍存在外部并发窗口，共享租约仅串行化 OmniKit 进程内跨特性同块写入。
3. **写前读回核验与异常分类边界**：
   - 获取租约后，依次调用 `/api/block/getBlockInfo`（核验 `data.rootID === target.rootID && data.box === target.notebook`）与 `/api/block/getBlockDOM`（读取目标块实时 HTML）；
   - 读取阶段发生的网络、超时或内核错误直接向上抛出为明确读取失败，严禁外层包装为 `"conflict"`；
   - 核验块 DOM 不含嵌套 `[data-node-id]`、整块快照与 `target.baselineBlockDOM` 一致、且对应序号节点属性仍精确等于 `target.oldPath`；任一真实不匹配返回 `"conflict"`；
   - 在发出 `/api/block/updateBlock` 前检测到 `signal?.aborted` 返回 `"aborted"`；
   - 调用 `/api/block/updateBlock`（`dataType: "dom"`）返回 `code === 0` 即信任内核事务落盘确认并返回 `"replaced"`；若请求已发出后发生超时、网络断开或中止，归类为 `"unknown"`，严禁自动重试，由上层将对应记录状态保持/标为 `"incomplete"`。

---

## 3. 自动上传、单图动作与外链监听 (`actions/`)

### 3.1 上传前纯同步授权与候选预筛选 (`AutoUploadHandler.ts`)
- 监听 Protyle 编辑器的 `before-upload-assets` 事件；
- **纯同步鉴权谓词**：`shouldCompress: (rootID: string) => boolean` 为纯同步鉴权谓词，仅在内存中读取当前配置、Feature 激活状态与白名单，无异步 I/O 开销；
- **候选类型过滤**：同步核验输入文件扩展名与 MIME 类型，未授权或不含可处理图片格式时直接同步退出，不创建 `MutationObserver` 观察器，不注册回调；
- **监听器异常边界隔离**：`before-upload-assets` 事件监听器整段回调置于 `try/catch` 隔离中，任何前置异常仅清理已挂载的观察器并记录警告后静默返回，绝不向思源原生上传管道抛错。

### 3.2 块落盘等待与新增 DOM 证据唯一性定位 (`AutoUploadHandler.ts`)
- 授权且包含候选图片时挂载轻量 DOM 观察器并注册 `onComplete` 回调；
- **仅采纳本次上传的新增 DOM 节点证据**：`onComplete` 仅消费本次 `MutationObserver` 观测到的新插入图片节点（或结合上传前 DOM 快照与内核 `succFiles` 返回路径关联确认的占位节点赋值），不存在全编辑器回退扫描（不遍历编辑器既有存量图片）；
- **既有节点属性变动隔离**：严格区分真正新插入的节点与既有 `<img>` 元素的属性变动，避免复用相同资源哈希或修改既有图片属性时误将存量图片当作新上传目标；当无法确认唯一新增证据时安全跳过（0 次 `updateBlock`）；
- 获取唯一新增证据后等待思源内核块落盘，通过 `ImageOccurrenceResolver` 锁定持久化块中的精确图片位置（`OccurrenceTarget`），并在完成处理后向 `ImageController` 返回结构化纯数据 `AutoUploadNotice`。

### 3.3 单图、远程本地化与原生兼容网络通道 (`SingleImageAction.ts`、`RemoteImageWatcher.ts`、`desktop.ts`、`download.ts`)
- **DOM 捕获安全过滤与统一准入**：`SingleImageAction` 与 `policy/dom.ts` 引用 Core 导出的受保护容器选择器常量（排除 `[data-type="NodeBlockQueryEmbed"]`、`.protyle-wysiwyg__embed`、`pre`、`code`、`script`、`style`、`[data-type="NodeCodeBlock"]`）；`ImageCandidateClassifier`、`BicEncoder` 与 `AdaptiveImageCompressor` 三处统一在 `manual-dialog` 与 `manual-quick` 模式下放行静态 WebP，在 `auto` 与 `document` 下跳过静态 WebP，并统一使用 `/(?:^|[\\/])drawings?[\\/]/i` 保护专有绘图目录（不误伤 `drawings_v2.png` 等普通文件名），且全模式统一保留动图检测（APNG / 多帧动画 WebP）；
- **单向反馈收口**：`SingleImageAction` 不直接调用 `services.ui.notify(...)`，统一返回 `ImageActionOutcome` 交由 `ImageController.present()` 呈现；
- **手动远程“仅保存”与先本地化再替换的两阶段快照时序**：
  - 预览阶段保持只读；用户确认保存时，若目标为远程 URL，`localizeRemoteOccurrence` 始终以本地原图替换 `true` 先执行单处本地化（下载 -> `/api/asset/upload` 上传原图 -> 经 `SafeBlockWriter` 更新该单处块引用，**严禁调用文档级 `/api/format/netImg2LocalAssets`**）；
  - 仅当本地化写入返回 `"replaced"` 后，必须通过思源块读取 API 重读已持久化块（不依赖当前活动编辑器实例）重新构造包含 `baselineBlockDOM` 与 `oldPath = localOriginal` 的新 `OccurrenceTarget` 快照；若本地化返回 `"unknown"` 或失败，中止后续步骤；
  - 随后上传预览 WebP 并经持久化前置闸门写入 Dock 配对记录；当 `replaceWebp === false` 时仅保留本地原图引用结束；当 `replaceWebp === true` 时基于新快照再次通过 `SafeBlockWriter` 精确改写该处引用为 WebP；
- **外链监听条件补扫**：`RemoteImageWatcher` 在 `MutationObserver` 中过滤嵌入块与代码块，使用单一定时器在非 `rebasing`、存在图片变更且首轮 `sweep()` 未检出新候选时触发至多一次延迟确认补扫；上传本地化后调用 `resolveImageOccurrence(persistedDOM, evidence)` 构造目标并传入经 `inspectImage` 校准信息的 `providedFile`；
- **参照宿主原生的外链读取传输通道**：桌面端（`desktop` / `desktop-window`）通过 `services/desktop.ts` 使用 Node `http` / `https` 模块直连请求（`agent: false`，携带 Core 统一 `general.userAgent`），实现与平台一致的合法 HTTP 重定向跟随；浏览器与移动端通过 `services/download.ts` 调用 `fetch`（`credentials: "omit"`、`referrerPolicy: "no-referrer"`，跟随浏览器允许的默认重定向）；两端均不设固定 3 跳拦截及私网 IP/DNS 拦截，统一执行 `http(s)` 协议限制、30 秒总超时、32 MiB 流式读取上限及图片格式/XSS 校验（并记录对应 SSRF 访问风险边界）。

### 3.4 EXIF 保留字段与质量模式分发 (`ImageSettingsPanel.svelte`、`ImageCompressionDialog.svelte`、`AdaptiveImageCompressor.ts`)
- **EXIF 控件与保留字段**：`ImageSettingsPanel.svelte` 与 `ImageCompressionDialog.svelte` 不渲染可见的 EXIF 选项控件；`parseImageConfig.ts` 与 `BicEncoder` 保留 `metadata.preserveExif: false` 模式校验与不支持显式拒绝边界（遇到非 `false` 配置明确报不支持而不静默丢弃数据）；
- **质量模式分发**：`AdaptiveImageCompressor` 根据 `smartEnabled` 开关分发：`false` 时直接委托 `BicEncoder` 使用 `initialQuality` 固定质量编码，`true` 时执行 MS-SSIM 搜索（`initialQuality` 仅作为搜索起点）；`manual-dialog` 允许低阈值或小图预览保存，产物大于原图时需用户二次确认。

---

## 4. 文档单次 DOM 扫描与批量定位 (`DocumentBatchAction.ts` & `services/references.ts`)

### 4.1 单次 `getBlockDOM(rootID)` 与内存切片
为避免大文档批量处理时逐块请求及 SQLite 异步索引延迟导致的漏图与往返开销，文档扫描采用实时 `.sy` 树单次读取与内存切片方案：
1. **文档身份与根目录 DOM 获取**：`DocumentBatchAction` 先通过 `/api/block/getBlockInfo` 校验 `rootID` 身份与所属笔记本（透传编辑器 `notebookId` 以兼容加密或未入库文档），随后调用 **1 次 `/api/block/getBlockDOM({ id: rootID, notebook })`**（严格校验 `response.data?.id === rootID` 且 `dom` 非空后才置 `scanComplete = true`）；
2. **内存切片与嵌套容器保护**：通过 `scanDocumentImages`（排除受保护容器选择器）扫描文档图片后，利用 `image.closest("[data-node-id]")` 定位每张图片所属的最内层块节点并按 `blockEl.outerHTML` 切片存入 `blockDOMs`；若最内层 `[data-node-id]` 块内部仍包含嵌套 `[data-node-id]` 容器节点，则安全跳过该位置而不计入失败；
3. **统一写前核验与引用写回**：单图、文档批处理、自动上传与远端监听的引用写回均通过 `SafeBlockWriter`（或 `ReferenceService` 透传）在 Core 共享块写租约保护下完成写前块身份与 DOM 比对后写入；

### 4.2 批处理生命周期、进度 Dialog 与统计边界 (`ImageController.ts`、`DocumentBatchAction.ts`、`ImageTaskUI.ts`、`CompressionResult.ts`)
1. **编辑器切换与关闭不断任务**：批处理控制器不监听 `switch-protyle` 或 `destroy-protyle` 触发中止；任务全程持有启动时捕获的 `rootID` 与 `notebook`，不依赖活动编辑器实例，写前通过内核 API 核验块实时状态；
2. **`activeDocuments` 异常安全释放**：`DocumentBatchAction` 将 `activeDocuments.add(rootID)` 之后的任务构造、进度 UI 装配及控制器注册全部纳入 `try/finally` 守卫，确保任意初始化异常均能释放文档互斥锁；
3. **进度 Dialog 用户关闭与程序关闭隔离**：`ImageTaskUI` 面板不提供独立“取消”按钮；内部维护 `closingByController` 标记区分两种关闭来源：
   - 用户主动关闭进度弹窗（含点击关闭或按 Esc，即 `!closingByController`）：触发 `onClose()` 通知批处理中止尚未开始的后续步骤；
   - 控制器在扫描失败、零图片或任务结束时调用 `view.close()`（置 `closingByController = true`）：仅完成 Svelte 卸载与 DOM 释放，不触发 `onClose()` 取消回调，防止将完成或扫描失败态误报为 `cancelled`；
4. **两阶段发布与独立 `unknown` 统计**：`DocumentBatchAction` 在完成资源准备进入块写回阶段时显式回调 `onPhase("applying")` 同步刷新面板阶段；统计模型（`CompressionProgress` / `CompressionBatchSummary`）独立维护 `succeeded`、`skipped`、`failed`、`conflicts`、`unknown` 与 `cancelled` 标志（不含无产出的死契约分支），不将 `aborted` 或 `unknown` 归类为 `failed`，单个批次仅在结束时发出一次汇总通知；`unknown` 写回状态在 Dock 记录中保持或标记为 `"incomplete"`。

---

## 5. 智能压缩 MS-SSIM 算法域架构 (`similarity/`)

### 5.1 工程价值与画质保证
在长周期的个人知识库与笔记资产管理中，图片资产占用了绝大部分磁盘与云端同步空间：
- **画质无损与空间节约的平衡**：固定低质量压缩会导致图表细线截断、文字边缘毛刺与噪点，而固定超高质量（如 0.95~1.00）则会导致文件体积虚高 3~5 倍；
- **客观视觉感知评价**：多尺度结构相似度（MS-SSIM）是契合人类视觉系统（HVS）的图像质量评价算法，在亮度和色度空间分离结构、对比度与亮度变化。系统以 MS-SSIM $\ge 0.99$ 作为默认视觉无损阈值，在满足目标相似度的前提下为不同特征图片自适应探索最小体积编码点，平衡画质保真与存储占用。

### 5.2 全平台标准 5 尺度 MS-SSIM 评估体系 & 动图预检
- **标准权重**：`[0.0448, 0.2856, 0.3001, 0.2363, 0.1333]`；
- **局部平滑窗口**：$11 \times 11$ 高斯平滑核，标准差 $\sigma = 1.5$；
- **Alpha 预乘优化**：对含透明通道图片执行 Alpha 预乘，全透明像素 RGB 归零，半透明像素正确预乘并加权合并，消除透明边缘杂色干扰；
- **基准分辨率归一化**：原图与候选图基准比对长边等比缩放至不超过 512px，平衡计算精度与耗时；
- **模式分发、静态 WebP 准入与前置动图检测**：`AdaptiveImageCompressor` 在 `smartEnabled === false` 时直接委托 `BicEncoder` 执行固定质量编码，仅在 `smartEnabled === true` 时运行 MS-SSIM 搜索（`initialQuality` 作为搜索起点）；与 `ImageCandidateClassifier`、`BicEncoder` 一致，在 `manual-dialog` 与 `manual-quick` 模式下放行静态 WebP、在 `auto` 与 `document` 下跳过静态 WebP；在创建 `SimilarityWorkerSession` 前前置调用 `inspectImage` 检测动图（APNG 或多帧动画 WebP 直接返回 `{ kind: "skipped", reason: "animation-protected" }`），并将预解析的 `originalInfo` 透传给 `BicEncoder.encode`，避免每轮搜索重复解析原图字节，同时每轮仍完整执行输出 WebP 的 `inspectImage(output)` 与 `verifyBitmap` 校验；在 `adaptiveQualitySearch` 中对所有 `skipped` 编码结果安全返回跳过结构而不抛为未知异常；
- **尺寸控制与资源释放**：`BicEncoder` 在 `auto` 与 `document` 模式下设置 `alwaysKeepResolution: true`；`ImageCompressionDialog.svelte` 维护 `destroyed` 状态标志防止卸载后在途预览生成未释放的 `ObjectURL`。

### 5.3 两阶段通信协议 (Two-Phase Worker Protocol)
- **阶段一：原图预计算 (`initOriginal`)**：主线程传递原图 Blob，Worker 仅执行一次解码、Alpha 预乘与 5 尺度降采样金字塔构建，常驻缓存各层均值与方差；
- **阶段二：候选图轻量评估 (`evaluate`)**：后续质量探索轮次中，Worker 仅对候选图进行单向解码，直接与缓存的原图统计量计算 MS-SSIM 卷积，避免重复构建原图金字塔；
- **内联 Worker 机制**：通过 Vite `?worker&inline` 编译为内联 Blob Worker，跨端运行无路径解析故障。

### 5.4 割线法 + 二分法混合区间搜索
- 初始质量点探测（默认 0.80）；
- 预测点在安全边界内采用割线法加速收敛，越界、斜率分母过小或命中缓存区间停滞保护时安全回退二分法；
- 最大轮次预算：桌面端 7 轮，移动端 5 轮；搜索质量严格位于 $[0.10, 1.00]$，容差为 0.01。

---

## 6. 数据存储与 Dock 状态契约

### 6.1 数据模型 (`feature-image-compressor-records.json`)
```typescript
export interface CompressionRecord {
  readonly originalPath: string;
  readonly compressedPath: string;
  readonly updatedAt: number;
  readonly lastOperation: "saved-only" | "replaced" | "incomplete";
}
```

### 6.2 持久化前置闸门、排序与失效配对条件清理 (`ImageCompressionRecordStore.ts` & `ImageProcessingServices.ts`)
- **持久化前置闸门**：自动引用替换前，必须先通过 `resolveSource` 提取规范化 `AssetAddress` 并以内核返回路径成功写入 `feature-image-compressor-records.json`，确认落盘后才允许执行引用写回；若写入发生磁盘、网络或序列化持久化失败，`persistEncodedImage` 抛出 `RecordPersistenceError`，持久化前置闸门立即阻断后续自动引用替换，保留已上传资源并向用户暴露可复制的新资源路径；
- **置顶排序与容量容错上限**：`upsert` 与 `markOperation` 更新既有条目或写入新条目后，按最新 `updatedAt` 将该记录置顶（数组首位），不引入独立持久化排序缓存；记录库在 `upsert` 新增条目时设轻量容错上限（`MAX_RECORDS = 10_000`），已有文件读取与已存在 `originalPath` 的原地覆盖更新不受拦截，达到上限时完整保留既有全部记录并抛出常规错误由持久化前置闸门统一兜底；
- **失效配对条件清理 (`compareAndRemove`)**：
  - 在 Dock 打开/激活、用户手动刷新以及压缩写入记录时机执行 `reconcilePair`，独立核查单条记录的原图与最新压缩图可用性（不设全局定时轮询或跨会话持久化缓存；Dock 会话内 `statusCache` 对自动切 tab 复用 10 分钟 TTL 缓存并显式排除 `"unknown"`，手动点击刷新强制穿透重查）；
  - 当且仅当原图或最新压缩图返回 `"missing-confirmed"` 时，调用 `store.compareAndRemove(originalPath, compressedPath)`；该方法在 `JsonStore.update` 串行队列内二次比对当前条目是否仍匹配待清理的 `originalPath` 与 `compressedPath`（防止异步核查期间 `A→B` 已被更新为 `A→C` 后被误删），随后仅移除该单条 JSON 业务记录；
  - 严禁调用任何物理文件删除 API，严禁依据链条关联执行级联清理。

### 6.3 Dock 状态核验、引用查找、单处改写与 `?box=` 范围查询 (`ImageRecordsDock.svelte` & `services/references.ts` & `ImageSettingsPanel.svelte`)
- **三态资产可用性模型 (`AssetAvailability`)**：
  ```typescript
  export type AssetAvailability = "present" | "missing-confirmed" | "unknown";
  ```
  - `"present"`：`/api/asset/statAsset`（保留 `?box=` 参数）返回 `code === 0`（包括内核登记但尚未下载的按需同步文件 `downloaded === false`）；
  - `"missing-confirmed"`：仅来自可明确证明物理文件不存在的权威内核契约；
  - `"unknown"`：网络错误、超时、权限拒绝、加密笔记本未解锁，以及当前思源内核 `/api/asset/statAsset` 返回含混错误码 `code === 1`（因 `kernel/api/asset.go:27-77` 将路径解析失败、`os.Stat` 错误、`times.Stat` 错误与文件缺失统一返回 `code === 1`，单凭 `code === 1` 无法证明物理缺失，且不以重试次数或“未查到引用”替代缺失证明）；仅 `"missing-confirmed"` 可触发 `compareAndRemove`，`"unknown"` 完整保留记录；
- **普通资源链接与分组精确改写**：
  - 引用定位结果按 `image`、`resource-link`、`unsupported` 三类分组展示；除 `img[data-src|src]` 外，同时定位同一受保护容器过滤规则下的普通资源链接（`span[data-type~=a][data-href]` 与 `a[href]`）；
  - 将候选 `blockID` 经 `/api/block/getBlockDOMs`（按笔记本分批每批 50，整批失败时降级逐块 `/api/block/getBlockDOM`）重取实时块 DOM，按 `(notebook, rootID, blockID, kind, ordinal, attribute, raw, baselineBlockDOM)` 唯一定位；
  - 用户选中单处或批量操作时，通过共享 `SafeBlockWriter` 配对图片与资源链接两种窄 patch 函数精确改写目标属性（严禁调用全局 `/api/asset/relinkAsset`）；对属性视图/数据库等无法映射为单块可编辑节点的引用仅作只读展示；
- **`?box=` 加密笔记本范围查找与静默刷新隔离**：
  - 因思源 `/api/asset/findAssetReferences`（`kernel/model/asset_relink.go`）显式拒绝带 query/hash 的路径并跳过加密笔记本，系统严禁剥离 `?box=` 调用全局查找；
  - 针对 `?box=<notebookID>` 资产，在对应加密笔记本已解锁且获授权的范围内通过思源文档与块读取 API 遍历可访问文档并扫描匹配图片与资源链接（只读 SQL 仅可作为可见已索引普通文档的可选候选预筛选，不假定加密笔记本存在 SQL 索引，所有写入前均经实时块读取 API 核验）；笔记本未解锁或无权限时返回 `unavailable`/`unknown`；
  - 替换/恢复完成后按剩余引用数与扫描完整性更新 `store.markOperation`（`"replaced"` / `"saved-only"` / `"incomplete"`）；后续 `post_action` 静默重查异常仅记日志，仅当 `source === "user_click"` 时展示查找失败提示，绝不覆盖用户刚看到的成功统计文案；
- **白名单文档校验与路径去重**：`ImageCompressorFeature` 的 `resolveDocument` 与 `validateDocument` 使用 `/api/block/getBlockInfo` + `isDocumentRootIdentity` 区分无效 ID、API 读取失败与合法文档（不将 API 错误误判为“不是文档”），并在所有标题查询失败时回退使用 `rootID` 作为显示标题；`ImageSettingsPanel.svelte` 维护非响应式 `pathLookupsStarted: Set<string>`、卸载 `AbortController` 与有限并发分批解析白名单路径。
