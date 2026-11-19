# OmniKit · 图片压缩技术设计文档 (Image Compressor DESIGN)

> **文档性质**：具体技术架构、模块职责、算法模型与存储契约（How）。代码重构或修复 BUG 时直接更新本文件，不影响业务需求 PRD。  
> **对应产品需求**：[PRD.md](PRD.md)  
> **适用平台**：OmniKit 桌面端与移动端

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

### 2.1 目标位置契约 (`OccurrenceTarget`)
严格基于目标元素在块内的物理序号与旧路径比对，杜绝模糊匹配与范围扩散：
```typescript
export interface OccurrenceTarget {
  readonly rootID: string;
  readonly notebook: string;
  readonly blockID: string;
  /** 该图片在所属块内的 0-based 有序序号 */
  readonly imageOrdinal: number;
  readonly oldPath: string;
  readonly baselineBlockDOM: string;
}
```

### 2.2 写前校验与内核确认信任原则
1. **写前身份与 DOM 双重核验 (Read-Before-Write Verification)**：
   - 更新块前，依次调用 `/api/block/getBlockInfo`（校验 `data.rootID === target.rootID && data.box === target.notebook`，防止块跨文档或跨笔记本移动）与 `/api/block/getBlockDOM`（读取目标块当前真实 HTML）；
   - 检查块 DOM 为单块结构且不含嵌套 `[data-node-id]`，并校验第 `imageOrdinal` 个 `<img>` 标签的路径仍精确等于 `oldPath`；
   - 若任一条件不匹配，判定为并发编辑冲突，安全放弃改写；
2. **信任思源内核返回值**：
   - 校验通过后，调用 `/api/block/updateBlock`（`dataType: "dom"`）；
   - 根据思源 Go 内核契约（`kernel/api/block_op.go:644`），返回 `code: 0` 即代表事务已完成落盘并广播了 WebSocket 事务事件，写入层直接信任内核返回值完成确认；
3. **进程内写租约 (Write Lease)**：
   - 通过 `withBlockWriteLease(leaseKey, ...)` 实现单块内改写串行化，避免本地多并发动作导致状态交织；
4. **任务中止与取消契约**：
   - 若在等待租约或执行写入过程中捕获到 `signal.aborted` 或 `AbortError`，显式抛出标准 `AbortError` 或返回专用的取消标识（如 `"aborted"`）；
   - 严禁将中止误报或混淆为内容冲突（`"conflict"`），上层调用者捕获中止后静默退出。

---

## 3. 自动上传、单图动作与外链监听 (`actions/`)

### 3.1 上传前纯同步授权与候选预筛选 (`AutoUploadHandler.ts`)
- 监听 Protyle 编辑器的 `before-upload-assets` 事件；
- **纯同步鉴权谓词**：`shouldCompress: (rootID: string) => boolean` 为纯同步鉴权谓词，仅在内存中读取当前配置、Feature 激活状态与白名单，无异步 I/O 开销；
- **候选类型过滤**：同步核验输入文件扩展名与 MIME 类型，未授权或不含可处理图片格式时直接同步退出，不创建 `MutationObserver` 观察器，不注册回调；
- **监听器异常边界隔离**：`before-upload-assets` 事件监听器整段回调置于 `try/catch` 隔离中，任何前置异常仅清理已挂载的观察器并记录警告后静默返回，绝不向思源原生上传管道抛错。

### 3.2 块落盘等待与直接定位 (`AutoUploadHandler.ts`)
- 授权且包含候选图片时挂载轻量 DOM 观察器并注册 `onComplete` 回调；
- 监听到上传完成事件后，等待思源内核完成块落盘，通过 `ImageOccurrenceResolver` 锁定持久化块中的精确图片位置（`OccurrenceTarget`），并在完成处理后向 `ImageController` 返回结构化纯数据 `AutoUploadNotice`。

### 3.3 单图与外链捕获防重及直连下载 (`SingleImageAction.ts`、`RemoteImageWatcher.ts`、`desktop.ts`)
- **DOM 捕获安全过滤**：`SingleImageAction` 与 `policy/dom.ts` 在 DOM 捕获阶段统一排除 `[data-type="NodeBlockQueryEmbed"]`、`.protyle-wysiwyg__embed`、`pre`、`code`、`script`、`style`、`[data-type="NodeCodeBlock"]`；捕获阶段仅执行 `getBlockDOM` 与 `resolveImageOccurrence`，块身份校验（`getBlockInfo`）由写入端的 `SafeBlockWriter` 统一执行；
- **单向反馈收口**：`SingleImageAction` 不直接调用 `services.ui.notify(...)`，统一返回 `ImageActionOutcome` 交由 `ImageController.present()` 呈现；
- **外链本地化与条件补扫**：`RemoteImageWatcher` 在 `MutationObserver` 中过滤嵌入块与代码块，使用单一定时器在非 `rebasing`、存在图片变更且首轮 `sweep()` 未检出新候选时触发至多一次延迟确认补扫；外链图片上传为本地资源后，直接同步调用 `resolveImageOccurrence(persistedDOM, evidence)` 构造目标，并将经 `inspectImage` 校准文件名后缀与 MIME（对非 PNG/JPEG/WebP 保留原始信息）的内存 `providedFile` 传入 `compressOccurrence`，跳过重复下载；
- **外链读取传输通道**：桌面端（`desktop` / `desktop-window`）通过 `services/desktop.ts` 使用 Node `http` / `https` 模块直连请求（`agent: false`，携带全局 `User-Agent`，最多 3 次重定向，30 秒超时，32 MiB 上限，`decodeURIComponent` 外层做异常处理）；浏览器与移动端通过 `SourceReader` 调用 `fetch`（`credentials: "omit"`、`referrerPolicy: "no-referrer"`、`redirect: "error"`）。

---

## 4. 文档单次 DOM 扫描与批量定位 (`DocumentBatchAction.ts` & `services/references.ts`)

### 4.1 单次 `getBlockDOM(rootID)` 与内存切片
为避免大文档批量处理时逐块请求及 SQLite 异步索引延迟导致的漏图与往返开销，文档扫描采用实时 `.sy` 树单次读取与内存切片方案：
1. **文档身份与根目录 DOM 获取**：`DocumentBatchAction` 先通过 `/api/block/getBlockInfo` 校验 `rootID` 身份与所属笔记本（透传编辑器 `notebookId` 以兼容加密或未入库文档），随后调用 **1 次 `/api/block/getBlockDOM({ id: rootID, notebook })`**（严格校验 `response.data?.id === rootID` 且 `dom` 非空后才置 `scanComplete = true`）；
2. **内存切片与嵌套容器保护**：通过 `scanDocumentImages`（排除 `.protyle-wysiwyg__embed`）扫描文档图片后，利用 `image.closest("[data-node-id]")` 定位每张图片所属的最内层块节点并按 `blockEl.outerHTML` 切片存入 `blockDOMs`；若最内层 `[data-node-id]` 块内部仍包含嵌套 `[data-node-id]` 容器节点，则安全跳过该位置而不计入失败；
3. **统一写前核验与引用写回**：单图、文档批处理、自动上传与远端监听的引用写回均通过 `SafeBlockWriter.commitOneImage`（或 `ReferenceService.commitOccurrence` 透传）完成写前块身份与 DOM 比对后写入；
4. **文档树菜单与空结果处理**：`menuContributions.ts` 在单选 `doc-tree` 菜单项提供 `compress-document`；`ImageController.compressDocument` 在 `result.cancelled` 时静默关闭面板，在 `result.total === 0 && result.scanComplete` 时关闭面板并提示 `image.batch.noImages`，在 `!result.scanComplete` 时提示 `image.batch.scanFailed`。

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
- **前置动图检测与信息透传**：`AdaptiveImageCompressor` 在创建 `SimilarityWorkerSession` 前前置调用 `inspectImage` 检测动图（APNG 或多帧动画 WebP 直接返回 `{ kind: "skipped", reason: "animation-protected" }`），并将预解析的 `originalInfo` 透传给 `BicEncoder.encode`，避免每轮搜索重复解析原图字节，同时每轮仍完整执行输出 WebP 的 `inspectImage(output)` 与 `verifyBitmap` 校验；在 `adaptiveQualitySearch` 中对所有 `skipped` 编码结果安全返回跳过结构而不抛为未知异常；
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

### 6.2 持久化前置闸门与零自动淘汰 (`ImageCompressionRecordStore.ts` & `ImageProcessingServices.ts`)
- **持久化前置闸门**：自动引用替换前，必须先通过 `resolveSource` 归一化 `originalPath` 并成功写入 `feature-image-compressor-records.json`，确认落盘后才允许执行引用写回；若写入发生磁盘、网络或序列化持久化失败，`persistEncodedImage` 抛出 `RecordPersistenceError`，持久化前置闸门立即阻断后续自动引用替换，保留已上传资源并向用户暴露可复制的新资源路径；
- **零自动淘汰与轻量条数容错**：记录库在 `upsert` 新增条目时设轻量容错上限（`MAX_RECORDS = 10_000`），且严禁任何自动删除或截断既有记录的行为，仅由用户在 Dock 中手动移除；已有文件读取与已存在 `originalPath` 的原地覆盖更新不受该条数拦截，达到上限时完整保留既有全部记录并直接抛出常规错误，由持久化前置闸门（`persistEncodedImage`）统一处理阻断引用替换与暴露可复制路径（不设独立容量错误类型或跨模块熔断状态机）。

### 6.3 Dock 状态核验与白名单解析 (`ImageRecordsDock.svelte` & `ImageSettingsPanel.svelte`)
- **资产状态映射**：`checkAsset` 保留 `?box=` 参数调用 `/api/asset/statAsset`，正常返回 `code === 0` 映射为 `"present"`，内核返回 `KernelRequestError` 且 `code === 1` 映射为 `"missing"`，其余异常映射为 `"unknown"`；严禁在任何状态下自动调用 `removeRecord`；
- **引用反查与降级容错**：`locateOccurrences` 遇到 `?box=` 加密资产路径时跳过 `findAssetReferences` 并展示不支持提示；普通路径按笔记本分批（每批 50）调用 `/api/block/getBlockDOMs`，若整批因已关闭笔记本或缺失块（`code: -1`）失败则降级为逐块 `/api/block/getBlockDOM` 容错跳过，同时按 `rootID` 去重解析文档标题（`getFullHPathByID` 回退 `getHPathByID`）并接入 `dockAbort.signal`；替换/恢复完成后依据剩余引用数更新 `store.markOperation`（`"replaced"` / `"saved-only"` / `"incomplete"`）；
- **白名单文档校验与路径去重**：`ImageCompressorFeature` 的 `resolveDocument` 与 `validateDocument` 使用 `/api/block/getBlockInfo` + `isDocumentRootIdentity` 即时校验文档身份（不受 SQL 异步索引延迟影响），并在取消白名单时跳过无用的标题查询；`ImageSettingsPanel.svelte` 维护非响应式 `pathLookupsStarted: Set<string>`、卸载 `AbortController` 与有限并发分批解析白名单路径。
