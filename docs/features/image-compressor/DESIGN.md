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
│ ├─ SingleImage  │ ├─ Contracts       │ ├─ references (SQL 查询)   │
│ ├─ DocBatch     │ ├─ Settings        │ ├─ assets / download      │
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
}
```

### 2.2 写前校验与内核确认信任原则
1. **写前读回核验 (Read-Before-Write Verification)**：
   - 更新块前，调用 `/api/block/getBlockDOM` 读取目标块当前真实 HTML；
   - 检查块内第 `imageOrdinal` 个 `<img>` 标签的路径是否仍然等于 `oldPath`；
   - 若不匹配，判定为并发编辑冲突，安全放弃改写；
2. **信任思源内核返回值**：
   - 校验通过后，调用 `/api/block/updateBlock`（`dataType: "dom"`）；
   - 根据思源 Go 内核契约（`kernel/api/block_op.go:644`），返回 `code: 0` 即代表事务已完成落盘并广播了 WebSocket 事务事件；
   - 写入成功直接信任内核返回值，杜绝冗余的后置二次网络读回比对，大幅降低网络往返延迟；
3. **进程内写租约 (Write Lease)**：
   - 通过 `withBlockWriteLease(leaseKey, ...)` 实现单块内改写串行化，避免本地多并发动作导致状态交织；
4. **任务中止与取消契约**：
   - 若在等待租约或执行写入过程中捕获到 `signal.aborted` 或 `AbortError`，显式抛出标准 `AbortError` 或返回专用的取消标识（如 `"aborted"`）；
   - 严禁将中止误报或混淆为内容冲突（`"conflict"`），上层调用者捕获中止后静默退出。

---

## 3. 自动上传处理时序与准入设防 (`actions/AutoUploadHandler.ts`)

### 3.1 上传前纯同步授权与候选预筛选
- 监听 Protyle 编辑器的 `before-upload-assets` 事件；
- **纯同步判断**：仅在内存中读取当前配置、Feature 激活状态与白名单，无任何异步 I/O 开销；
- **候选类型过滤**：同步核验输入文件扩展名与 MIME 类型，未授权或不含可处理图片格式时直接同步退出，不创建 `MutationObserver` 观察器，不注册多余回调，实现零额外开销。

### 3.2 块落盘等待与直接定位
- 授权且包含候选图片时挂载轻量 DOM 观察器并注册 `onComplete` 回调；
- 监听到上传完成事件后，等待思源内核完成块落盘（单次 DOM 渲染就绪），直接通过 `ImageOccurrenceResolver` 锁定持久化块中的精确图片位置（`OccurrenceTarget`）；
- 流程确定性收敛，无退避轮询与死锁状态，执行完成后立即向 Controller 返回结构化纯数据结果。

---

## 4. SQL 批量定位与批量优化 (`services/references.ts`)

为了杜绝大文档批量处理时逐块发起 `getBlockDOM` 造成的上百次 HTTP API 往返，系统采用只读 SQL 优化：

### 4.1 SQL 只读快速定位
通过思源只读 SQL 接口 `/api/query/sql`，一条语句高效捞出当前文档中包含图片的所有块：
```sql
SELECT id, markdown FROM blocks 
WHERE root_id = '目标rootID' AND markdown LIKE '%assets/%'
```
- 直接在内存中完成图片块初筛与定位，将原本需要数十上百次的 HTTP 往返骤降为 1 次 SQL 查询；
- **修改安全原则**：SQL 仅用于只读检索定位，**改写时严禁执行任何 SQL UPDATE/INSERT 语句**，一律走受控的 `/api/block/updateBlock`，确保思源文档历史版本与事务链完整。

---

## 5. 智能压缩 MS-SSIM 算法域架构 (`similarity/`)

### 5.1 工程价值与画质保证
在长周期的个人知识库与笔记资产管理中，图片资产占用了绝大部分磁盘与云端同步空间：
- **画质无损与空间节约的平衡**：固定低质量压缩会导致图表细线截断、文字边缘毛刺与噪点，而固定超高质量（如 0.95~1.00）则会导致文件体积虚高 3~5 倍；
- **客观视觉感知评价**：多尺度结构相似度（MS-SSIM）是契合人类视觉系统（HVS）的图像质量评价算法，在亮度和色度空间分离结构、对比度与亮度变化。系统以 MS-SSIM $\ge 0.99$ 作为肉眼无损的刚性底线，为插画、截屏、摄影照片等不同特征的图片自适应探索最小体积编码点，平均可节省 40%~70% 的存储空间，大幅减轻笔记同步压力。

### 5.2 全平台标准 5 尺度 MS-SSIM 评估体系
- **标准权重**：`[0.0448, 0.2856, 0.3001, 0.2363, 0.1333]`；
- **局部平滑窗口**：$11 \times 11$ 高斯平滑核，标准差 $\sigma = 1.5$；
- **Alpha 预乘优化**：对含透明通道图片执行 Alpha 预乘，全透明像素 RGB 归零，半透明像素正确预乘并加权合并，消除透明边缘杂色干扰；
- **基准分辨率归一化**：原图与候选图基准比对长边等比缩放至不超过 512px，平衡计算精度与耗时。

### 5.3 两阶段通信协议 (Two-Phase Worker Protocol)
- **阶段一：原图预计算 (`initOriginal`)**：主线程传递原图 Blob，Worker 仅执行一次解码、Alpha 预乘与 5 尺度降采样金字塔构建，常驻缓存各层均值与方差；
- **阶段二：候选图轻量评估 (`evaluate`)**：后续质量探索轮次中，Worker 仅对候选图进行单向解码，直接与缓存的原图统计量计算 MS-SSIM 卷积，计算量节省 50% 以上；
- **内联 Worker 机制**：通过 Vite `?worker&inline` 编译为内联 Blob Worker，跨端运行零路径解析故障。

### 5.4 割线法 + 二分法混合区间搜索
- 初始质量点探测（默认 0.80）；
- 预测点在安全边界内采用割线法加速收敛，越界或斜率分母过小时安全回退二分法；
- 最大轮次预算：桌面端 7 轮，移动端 5 轮；搜索质量严格位于 $[0.10, 1.00]$，容差为 0.01。

---

## 6. 数据存储与持久化契约

### 6.1 数据模型 (`feature-image-compressor-records.json`)
```typescript
export interface CompressionRecord {
  readonly originalPath: string;
  readonly compressedPath: string;
  readonly updatedAt: number;
  readonly lastOperation: "saved-only" | "replaced" | "incomplete";
}
```

### 6.2 持久化前置闸门 (Persistence-First Gate)
- 自动引用替换前，必须先将映射记录成功写入 `feature-image-compressor-records.json` 并收到落盘确认；
- 若写入失败或超时，自动替换流程终止，保留已上传资源并向用户提示复制路径，严禁产生游离未登记的图片引用。
