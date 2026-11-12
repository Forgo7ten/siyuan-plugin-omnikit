# OmniKit 图片压缩 V2：实施规格、架构改进与完整参考代码

> **面向对象**：接手实现的 Coding Agent 与代码审查者。  
> **基线提交**：`f178de06b9233e1e2968b8f18bd224d4d5939266`，仓库 `Forgo7ten/siyuan-plugin-omnikit`，分支 `feat-image-compressor`。  
> **日期**：2026-11-12。  
> **承接材料**：上一版 `OmniKit-f178de06-review-plan.md`；更早的 `cf3257b0…` 审查只用于追溯需求，不能把旧缺陷直接算到当前提交。  
> **交付性质**：增量改造规格 + 独立可检查的核心实现 + 目标项目接线代码 + 回归测试。**不是已经修改远程仓库的提交，也不是可安装的插件发行包。**  
> **本轮明确变化**：补充旧宿主 SQL 路径；图片配置仅支持 `schemaVersion: 2`，不兼容/迁移图片 schemaVersion 1；明确默认压缩引擎；修复本地路径与外链来源通路。

## 导航

1. 执行决策与本轮纠正
2. 分节优化清单与优先级
3. 压缩库比较及最终选型
4. 宿主版本、能力探测与 SQL 降级
5. Core / Feature / UI / 配置架构
6. 本地路径、上传文件、URL 来源统一
7. 图片处理、命名、原图保留与清理
8. 引用重写、并发、恢复和任务状态
9. 设置页、任务窗口与交互设计
10. 交给 Agent 的具体接线步骤
11. 扩展优化与不应过度设计的部分
12. 多轮复核记录、验收与验证边界
13. 完整代码
14. 固定版本证据索引

---

# 1. 执行决策与本轮纠正

## 1.1 最终决策

| 议题 | 采用方案 | 不采用的方案 |
|---|---|---|
| 默认压缩库 | **保留 `browser-image-compression@2.0.2`，包在独立 Encoder 内** | 仅因为 Star 更多就改用 Compressor.js；同时默认维护两个 Canvas 引擎 |
| 是否有损 | 当前 JPEG/PNG → WebP 流程**按有损转换设计**，质量值是编码参数 | `quality=1` 等于无损、等于相似度 100%；PNG 后缀必然说明整个处理过程无损 |
| 新宿主引用更新 | 能力探测成功后使用原生查引用、dry-run、重链接 | 仅按版本号直接认定所有接口、返回字段、权限都可用 |
| 旧宿主引用更新 | **SQL 分页枚举文档 → 内核完整 DOM → 精确块引用重写 → 校验** | 无接口就完全不压缩；SQL `UPDATE blocks`；全局字符串替换 |
| SQL 旧版清理 | 可以更新共享块引用，**默认不自动删除原资源** | 把 SQL 零结果等同于工作区无引用并直接删除 |
| 原图删除开关 | 单文件上传和手动单图才可能生效；单图仍需安全校验 | 复用一个 `deleteOriginal` 布尔参数传入所有任务 |
| 文档批量 | **无条件保留原图；批量只有一张也不例外** | 用图片数量推断任务是不是“单图” |
| 本地文件 | 受控桌面只读 FS；浏览器/移动端用户明确选择 File | `fetch("C:\\...")`；把客户端路径传给服务端任意文件读取 API |
| 外链 | 手动授权来源；自动需要文档策略和精确 HTTPS origin 白名单 | 默认扫描打开的全部笔记并请求任意外站；携带 Cookie；悄悄转发到代理 |
| 图片配置 | **仅 v2，旧文件只读并明确提示备份重置** | 字段映射、兼容 v1、自动填补旧配置并静默覆盖 |
| 架构 | 保留现有 Manager/Scope/注册表，收紧能力边界 | 重写成微内核、依赖注入框架、动态加载不受控脚本 |
| UI | Core 宿主容器 + Feature 的 Svelte 内容 | Core 写图片业务表单；每个 Feature 自建顶栏、Dock |

**重要取舍**：接受“旧版本继续可用”，不等于接受“旧版本拥有与新内核完全相同的删除安全保证”。SQL 回退真正执行共享块引用更新，但对属性视图、模板、其他插件私有数据、关闭/加密笔记本等覆盖边界必须明确显示。不能为了兑现复选框而冒险删图。

## 1.2 对上一版的纠正

**版本边界需更精确。** 本轮直接读取相邻发布标签：v3.8.3 的资源路由没有 `findAssetReferences` / `relinkAsset`；v3.8.4 的实现已经接受 `paths` / `mappings`、`dryRun`，并保留失败时的部分结果。此前“v3.8.9 已提供”不能被理解成“v3.8.9 才引入”。以本次核实的相邻版本为准，设计参考边界是 **3.8.3 → 3.8.4**。[H01][H02]

**原生引用 API 的引入，与清理语义的成熟，是两件事。** 本轮只把已核对的 v3.8.9 清理契约放入示例白名单；较新或其他版本须核查后扩展，不凭 `>=3.8.4` 就允许删除。这个白名单是审计策略，不是宣称其他版本必定有缺陷。[H05][H06]

**保留原图不能只解释成“没调用删除”。** 上传前替换 File 时，原图可能从未进入工作区。默认保留模式需要先归档原 File，明确确认归档成功，再把压缩 File 交还宿主。归档不可以增加宿主上传批次中的条目，否则破坏一一对应关系。[H07]

**本地路径不支持不是压缩库本身的问题。** 当前代码在 `local-files` 分支直接返回；单图路径解析器又只接纳规范的 `assets/` 形式，来源读取层缺失才是主要原因。[O01][O02]

## 1.3 阅读代码前须知

以下模块放在一个目录，使用 `.js` 导入路径，让 TypeScript 能直接输出可运行 ESM，Vite 也可解析对应 `.ts`。首次接入可放到：

```text
src/features/image-compressor/v2/
```

**不要把参考包的 `package.json` / `tsconfig.json` 覆盖到插件根目录。** 它们仅用于独立测试。`.integration.ts` 与三个 `.svelte` 文件需要目标工程的真实 SiYuan/Svelte 依赖检查。

文中 `[Oxx]` 为固定 OmniKit 源码事实，`[Hxx]` 为宿主/SDK 事实，`[Lxx]` 为库源码或文档事实；未标记的“应当/建议/本方案”是设计决策，不是当前仓库已经实现的行为。

---

# 2. 分节优化清单与优先级

## 2.1 正确性与安全性：先做

| ID | 优先级 | 优化内容 | 本文实现 |
|---|---|---|---|
| V01 | P0 | 原生 API 缺失时执行 SQL 路径；权限/超时不能误降级 | `kernel.ts`、`references.ts` |
| V02 | P0 | 原生写入已经发出后禁止 SQL 重试 | `ReferenceService.commit()` |
| V03 | P0 | 文档批量不能取得删除能力，运行时再次防误调用 | `jobs.ts`、`SingleOriginalFinalizer` |
| V04 | P0 | 同名 `assets/` 不能自动等同于同一个物理文件 | `asset-identity.ts` |
| V05 | P0 | SQL 只读查询、完整分页、按最内层所属块聚合 | `scanIndexedDocuments()`、`dom.ts` |
| V06 | P0 | 所有新资源先准备和校验，再改引用；未知写入不重发 | `AssetStore`、`ImageJobRunner` |
| V07 | P0 | APNG、动画 WebP、CMYK/MPO 等特殊输入保护 | `inspectImage()` |
| V08 | P0 | 旧配置不迁移，不因为 parse 失败而覆盖原文件 | v2 codec + 现有 JsonStore 备份重置 |
| V09 | P1 | 删除前重新查引用、校验原字节、使用内核未引用清理 | `SingleOriginalFinalizer.finish()` |
| V10 | P1 | 断网、取消、失败、未知、部分成功分别显示 | `JobState`、`ImageTaskPanel.svelte` |

## 2.2 功能提升

| ID | 优先级 | 内容 | 行为边界 |
|---|---|---|---|
| F01 | P1 | `assets/`、`./assets/`、`/assets/`、同源绝对地址统一 | 仅允许明确支持的 `box` 参数；其他图片变换查询参数不猜测 |
| F02 | P1 | Windows 盘符路径和 `file://` 单图读取 | 桌面授权后只读；网络共享默认不读 |
| F03 | P1 | `local-files` 上传预压缩 | 整批转换成功才替换；数量和顺序不变 |
| F04 | P1 | 手动外链下载、压缩、转为 assets | 不携带认证；请求失败保留旧链接 |
| F05 | P1 | 自动外链输入处理 | 完整持久化基线 + 观察图片变更；不是打开文档就批量本地化 |
| F06 | P1 | 手动与文档批量同步共享引用 | 本地资产优先原生；外链/文件引用走支持范围内的块扫描 |
| F07 | P1 | 用户选择原文件作为显式兜底 | 可解决浏览器本地路径和外链 CORS；不能按文件名自动猜文件 |
| F08 | P1 | 原始可读名称保留 | 允许内核替换资源 ID；不覆写源资源 |
| F09 | P2 | 短期任务记录及条件恢复 | 不自动续写；只回滚仍与本次 after 快照完全一致的块 |

## 2.3 架构与体验提升

Core 继续持有 Feature 总开关、生命周期、配置存储机制、菜单路由、宿主 Dialog/Dock。Feature 持有图片配置 schema、编码器、来源读取、引用策略和 Svelte 内容。设置页在 Feature 停用时仍可编辑配置；持久化 enabled 与实际 runtime phase 分开显示。

本轮新增的是少数具体服务，不是抽象层堆叠：`SourceReader`、`BicEncoder`、`ReferenceService`、`ImageJobRunner`、`ImageController`。图片数据不进入 Core；Core 不导入图片格式判断、图片路径正则、白名单增删逻辑。

---

# 3. browser-image-compression 与 Compressor.js：最终选型

## 3.1 BIC 是有损压缩吗？

**针对 OmniKit 目前的输出 WebP 路径，是按有损压缩/转换使用的。** 但更准确地说，BIC 是流程封装，不是一个独立、固定的有损编码算法；是否损失像素、尺寸、元数据，要看输出格式、Canvas 重采样、颜色处理和编码参数。

本轮读取 `browser-image-compression@2.0.2` 源码，确认：

1. WebP 路径调用浏览器的 `OffscreenCanvas.convertToBlob()` 或 Canvas 导出能力。
2. `initialQuality` 是初始质量。输出过大时，后续循环可能进一步降低质量；它不是最终最低质量，更不是视觉相似度。
3. `alwaysKeepResolution: true` 只约束迭代压缩时的继续缩小，不取消明确配置的 `maxWidthOrHeight`。
4. **PNG 路径使用 `UPNG.encode(..., 4096 * quality)`，存在调色板量化**。所以“输出 PNG”也不能推出整个处理过程无损。
5. `quality=1` 没有提供 WebP 的显式无损模式；尺寸不变也不等于无损。
6. Canvas 转换和 `preserveExif: false` 会改变/丢弃部分源信息。WebP 输出不应承诺保留 JPEG 原始 EXIF、ICC/HDR、多帧或其他专属语义。[L01][L02]

设置页应写：**“起始编码质量 80%；不是相似度，也不是最低质量保证”**。避免写“画质保留 80%”“几乎无损”“PNG 无损压缩”这样的承诺。

## 3.2 多维比较

| 维度 | BIC 2.0.2 | Compressor.js 1.4.0 | 对 OmniKit 的影响 |
|---|---|---|---|
| 基本技术 | Canvas/OffscreenCanvas；PNG 有额外 UPNG 路径 | 浏览器 Image、FileReader、Canvas/toBlob 路径 | 两者都不是万能格式解码器 |
| WebP 编码 | 主要由浏览器编码器提供 | 主要由浏览器编码器提供 | 同参数不保证同输出；需同浏览器实测 |
| Worker | 内建使用 Worker 的通路及回退 | 标准实现创建 `new Image()`，不是可直接放进 Worker 的替代品 | BIC 更贴合现有离线 Worker 集成 |
| 取消 | 接受 AbortSignal | 提供实例 abort，需要桥接 | 二者都不应承诺同步编解码一定可即时硬中断 |
| 进度 | 有 onProgress | 无等价的标准编码进度协议 | BIC 更适合任务 UI |
| 目标体积 | 有 maxSizeMB、迭代尝试 | 主要是质量/尺寸/格式参数 | 当前无需追求特定 MB，使用收益阈值即可 |
| 质量参数 | initialQuality，可能继续降低 | quality，主要控制该次 Canvas 导出 | “质量值”语义不能混为一谈 |
| 重采样 | 最大边限制及迭代策略 | maxWidth/maxHeight、宽高等选项 | 两者都要防意外放大和超大位图 |
| EXIF | 有相关处理，但应按输入输出路径审查 | JPEG 方向校正和 EXIF 相关选项 | WebP 转换不承诺完整源元数据保真 |
| 图片变大保护 | 库中已有判断，插件仍需阈值校验 | strict 默认保护有例外，格式/尺寸改变等会影响 | **不能只信库默认值** |
| GIF/APNG/动画 WebP | 不能因可解码就默认为可安全转换 | 同样不能承诺保留全部帧 | 插件前置检查，动画强制跳过 |
| HEIC/AVIF/TIFF 等输入 | 取决于浏览器解码与额外 codec | 同样依赖环境 | 更换这两个库不能直接解决更多格式 |
| 透明通道 | 需以实际输出验证 | 需以实际输出验证 | 禁止为减小体积悄悄填白背景 |
| 运行平台 | 浏览器能力驱动；Worker 需 CSP/路径实测 | DOM 能力驱动，主线程负担需实测 | 移动端长任务更看重运行模型 |
| 维护现状 | 上一版快照最近 push 为 2024-03-08；需承担维护债务 | 已核对 v1.4.0，2026-10-01 发布；维护信号更积极 | Compressor.js 在维护方面有优势 |
| 迁移成本 | 已经在本仓库集成 | 要重做进度、取消、线程策略和回归 | 目前切换收益不抵主要风险 |
| 体积/速度/画质 | **本轮没有同机对比测量** | **本轮没有同机对比测量** | 不编造“快几倍”“小百分之多少” |

依据：[L01]–[L05]。Star 数是受欢迎程度的快照，不是编码质量、数据安全或移动端性能指标。上一版记录的 BIC 约 1.7k、Compressor.js 约 5.8k，只作历史选型背景，不作为永久指标或决定性依据。

## 3.3 本轮具体参数

```ts
{
  fileType: "image/webp",
  initialQuality: 0.8,
  maxWidthOrHeight: 4096,
  maxSizeMB: Infinity,
  maxIteration: 3,
  alwaysKeepResolution: true,
  useWebWorker: true,
  libURL: "<插件安装包中的本地库 URL>",
  preserveExif: false,
  signal
}
```

压缩后再检查 MIME、真实 WebP 容器、可解码性、尺寸和收益。默认绝对收益至少 4 KiB、相对收益至少 5%。输出更大就保留原图，不能为了“完成转换”而强制替换。

这些参数**不承诺最终质量恰好 0.8**。需要严格固定质量或真正 WebP lossless 时，应另立编码模式，不把现有 `initialQuality` 换个标签就冒充。

## 3.4 是否换库：明确答案

**这轮不换。默认 BIC，优先修复来源、引用、保留策略、线程资源和反馈。**

Compressor.js 值得作为维护较活跃的对照实现，但它没有解决本地文件权限、URL CORS、共享引用、旧宿主接口、动画保真、原图安全删除这些主要问题。把它替换进来会增加迁移工作，而不是让这些问题自然消失。

后续真正值得评估的是一个单独的 **Worker + WebAssembly codec** 路线，例如 jSquash/libwebp；它与当前 Canvas 封装的差异更实质。是否支持 lossless、更多解码格式、ICC/方向、多帧以及移动端峰值内存，必须另做可重复测量。sharp 可用于离线基准/桌面专用工具，不作为浏览器和移动端通用依赖。[L06][L07]

### 基准验收建议

选择摄影 JPEG、文字截图 PNG、透明图、长截图、带方向 JPEG、APNG、动画 WebP、异常/截断文件。对同一浏览器内核、尺寸上限与明确输出参数记录输出字节、时延分位数、主线程长任务、峰值内存近似值、方向/透明/文字可读性。SSIM 等数值仅作辅助，不能用某个相似度百分比覆盖颜色与动画语义差异。**本报告没有把这份待做基准写成已经得到的实验结论。**

---

# 4. 宿主版本与 SQL 降级：完整设计

## 4.1 兼容矩阵

| 宿主 | 引用更新 | 自动上传 | 自动清理 |
|---|---|---|---|
| 已核对 v3.8.0–v3.8.3 边界内旧接口环境 | SQL + getBlockDOM + updateBlock | 无已确认的上传前协议则不接管；手动压缩可用 | 保留原图 |
| 已核对 v3.8.4 | 原生数组查引用/重链接优先，运行时校验 | 按真实事件契约判断，不只看版本字符串 | 不因“原生重链接存在”自动开放删除 |
| 已核对 v3.8.9 | 原生优先，缺失且明确无副作用时 SQL | 正式上传决策、完成回调 | 满足单图全部条件时尝试宿主安全清理 |
| 未知版本、定制构建、权限受限 | 只读预检；明确 404/405 可 SQL；其他失败停止并说明 | 真实事件形状校验 | 未审计 profile 默认保留 |

v3.8.4 已有数组形式，不需要为了这一正式标签人为构造“只能逐个 native 调用”的分支。本实现不兼容未知的标量-only 私有协议；能力/响应不符合时显式诊断，用户可以在新任务中选择 SQL，而不是写入中途悄悄切换。[H01][H02][H07]

## 4.2 为什么不能 `catch { return sqlFallback(); }`

原生接口报错可能意味着：没有权限、工作区正在变动、引用中有不支持的数据、读超时、返回结构不一致，或者**写已经执行了一部分**。这些都不是“API 不存在”。

本实现只允许：

```text
查引用 / dry-run 阶段，HTTP 404 或 405，且没有发出修改引用的请求
    → SQL 计划

403 / 401 / 网络超时 / 业务 code!=0 / 不可处理引用 / 响应格式错误
    → 停止，说明原因

正式 relinkAsset 已发出后，无论 404、超时、连接断开、结构异常
    → unknown 或 partial；不重发，不再启动 SQL
```

native 响应中的 `updated` 是宿主修改记录量，不能直接显示成图片数；`code=0` 也不能代替逐项 `items[].ok`、不可重链接引用、跳过笔记本和缺失数据库定义检查。[H03][H04]

## 4.3 SQL 具体策略

不直接改 SQLite，不以 `markdown LIKE '%xxx%'` 为最终事实。

本文选择一个较慢但可解释的基线：**只读 SQL 分页枚举所有已索引普通文档根块，再读取完整文档 DOM 做语义筛选**。这样无需把路径的 URL 编码、HTML 实体、Markdown 转义完全塞进 SQL。找到所属块后再读取该块，生成一次聚合 patch。

关键查询：

```sql
SELECT id, root_id, box
FROM blocks
WHERE type = 'd' AND id > '<上次实际返回的最后一个 ID>'
ORDER BY id ASC
LIMIT 64;
```

**不能用“返回少于 64 行”认定扫描结束。** 旧宿主 SQL 入口受搜索限制影响；继续用最后一个实际 ID 翻页，直到返回空数组。检测重复/倒序游标和总量上限；中途失败就不开始引用修改。[H08]

完整流程：

```text
确认普通笔记本范围
→ 本地资源物理位置消歧
→ SQL 根块 keyset 分页
→ getBlockDOM(root)
→ 图片/普通链接语义匹配
→ 最内层 blockID 归属
→ getBlockDOM(owner block)
→ 同块全部映射合并
→ 用户确认跨文档影响
→ 持久化 before/after 计划
→ 插件内共享写锁
→ 重读块、写前再次比对
→ updateBlock(dataType=dom)
→ 读取实际结果验证
→ 最后再扫描旧链接与文档清单
```

原生和 SQL 都通过一个 Feature 级 ReferenceService 实例；单图、文档批量、自动外链、条件恢复不能各建一把互不相干的写锁。

## 4.4 物理资源消歧不能省略

`assets/a.png` 可能在全局资源目录和某个普通笔记本/文档资源目录同时出现。**相同 URL 字符串、相同文件名，甚至相同内容 Hash，都不能直接等同于同一资源实体。**

`asset-identity.ts` 用受控的 `/api/file/readDir` 只读扫描全局和普通笔记本的资源根目录，确认每一个旧/新 assets 路径只对应一个文件位置。遇到多个位置、符号链接、大小写歧义、未知条目形状、扫描上限，停止 SQL 任务；不通过“取第一个”修复。该 API 在核对的 v3.8.0 返回 `name/isDir/isSymlink/updated`。[H09]

这是兼容路径的代价。可在下一阶段缓存单任务目录列表，但不能把长期缓存当成永久实体证明。预览后、提交前重新校验位置。它仍不是宿主提供的原子资源锁；发生文件系统级并发移动时，插件不能承诺不存在竞态。

## 4.5 覆盖边界必须显示

SQL 路径覆盖：已索引、可读取的普通文档中，支持解析的图片和普通资源链接。其 “verified” 表示**这个覆盖范围内**的后验校验通过。

没有宣称覆盖：加密笔记本、关闭笔记本、属性视图内部资源值、模板、HTML 块特殊序列化字段、所有自定义属性、其他插件私有数据、历史版本或外部系统。当前实现发现关闭/加密笔记本会停止全局 SQL 任务，要求用户调整范围；不是把它们默默排除后报告“全局完成”。

后续要扩大覆盖，应增加专用 AST/AV adapter 与测试，不能给 SQL 结果设置一个 `complete=true` 就结束。**无完整删除证明时继续保留原图，普通共享块引用仍可完成替换。**

---

# 5. 架构、生命周期和配置

## 5.1 保留现有架构，新增具体职责

```text
OmniKitPlugin
  ├─ FeatureManager / FeatureScope
  ├─ SettingsManager / JsonStore
  ├─ MenuRouter / MenuRegistry
  └─ Settings / Dialog / Dock 宿主容器
        └─ ImageCompressorFeature
             ├─ ImageController：菜单和明确用户操作
             ├─ AutoUpload：官方上传事件适配
             ├─ RemoteWatcher：已保存的新图片 URL 检测
             ├─ SourceReader：asset / remote / file
             ├─ BicEncoder：格式保护、编码、输出校验
             ├─ ImageJobRunner：任务编排，无删除能力
             ├─ ReferenceService：native / SQL
             ├─ SingleOriginalFinalizer：仅手动单图后置清理
             └─ Feature 自己的 Svelte 设置/任务内容
```

不要在主 Plugin 中添加 `compressAllImages()`、`deleteImageOriginal()`、`downloadImageUrl()`。不要让 Svelte 表单自己请求内核写块。不要让压缩器自行上传、删除或查询引用。

## 5.2 FeatureKit 和 Scope

`core.ts` 给出了一个小型类型化 Kit：自己的配置、作用域绑定事件、配置订阅。真实项目应复用现有 FeatureScope 的接口；示例 Scope 是独立测试的最小等价实现，**不是要求部署两套互相竞争的 FeatureManager**。

生命周期不变量：

- 关闭/卸载先同步 abort 和使旧回调失效，再等待异步清理。
- 迟到的 `own()` 立即清理；旧菜单不能启动新任务。
- 成功或失败都释放位图、Blob URL、监听器、计时器、文件句柄和 Worker 所有权。
- 每次激活创建新的运行时对象；设置组件不依赖已关闭的运行时。
- 一个 Feature 的清理失败不能阻止其他 Feature。
- 初始化过程使用当前 Scope；异步完成后再次确认仍 active。
- 与现有 BaseFeature 的 generation/activation/shutdown 机制合并，不重写另一套状态机。

## 5.3 仅图片 schemaVersion 2

新字段按职责分组：`auto / compression / sources / retention / references`。核心 enabled 不进入图片配置。

`parseConfig()`：
- 只接受 `schemaVersion === 2`；
- 不读取 `skipWebP` 等 v1 字段；
- 不对缺失 v2 字段偷偷填入默认值；
- 不在解析时写文件；
- v1/未知/损坏配置进入明确只读状态；
- 用户选择“备份并使用新版默认值”后，复用现有 JsonStore 的串行备份与确认写入流程。

这**不是 v1 兼容**，而是保护不被静默覆盖的旧文件。Core 自己的配置版本独立管理，不应因为图片配置改为 v2，就强制把所有 Feature 和 Core 都改成同一个 schemaVersion。

## 5.4 文件命名与类型边界

保留 feature ID `imageCompressor`，由 Core 命名函数生成 `feature-image-compressor.json`，并检测不同 ID 规范化后的文件名冲突。注册项与创建实例的 ID 必须一致。

Feature 可以自由定义自己的配置结构，但只能通过自己的 store 写入；不开放任意 `saveData(path, arbitraryData)` 到业务组件。任务日志是另一种明确授权的 Feature 私有存储，不混入用户配置，不让每个进度数字都改设置文件。

## 5.5 设置 view 的通用接线改动

现有 SettingsRoot 不应继续用“Feature 未启用”来禁用整张表单。只读、保存中、schema 错误才是禁止写配置的原因。

把设置组件的公共 Props 调整为：

```ts
type FeatureSettingsProps<T> = {
  store: JsonStore<T>;
  runtimePhase: FeaturePhase;
  t: (key: string) => string;
};
```

注册图片 `settingsView: ImageSettingsBridge`，由 Bridge 创建图片自己的设置 presenter/验证函数。Core 只传通用的 phase 和 store，不认识 `maxPixels`、`deleteSingleOriginal` 或图片白名单。

SettingsRoot 的核心替换片段：

```svelte
{@const View = entry.settingsView}
<View
  store={settings.store(entry.id)}
  runtimePhase={runtime?.status ?? "disabled"}
  {t}
/>
```

Core 总开关仍在 SettingsRoot 的 Feature header，只有 FeatureManager 操作它。图片表单内部不复制另一份 enabled。

---

# 6. 本地路径和 URL：统一来源层

## 6.1 先区分三种“本地”

| 输入 | 真正含义 | 正确读取 |
|---|---|---|
| `assets/a.png` | 内核工作区资源 URL | 同源 `/assets/a.png` |
| `C:\images\a.png` / `file:///…` | 前端设备的文件路径 | 桌面能力检测 + 用户授权 + 只读 FS |
| `input.kind === "local-files"` | 官方上传事件里的本地文件条目 | 逐项受控读取为 File，保持输入条目对应关系 |

不能把三者都 `fetch(raw)`。尤其 HTTP 页面无法通过普通 fetch 读取盘符路径；连接远程内核时，服务端文件系统也不等于用户电脑。

当前分支直接跳过 `local-files`，因此这个问题先修读取通道，而不是先换编码库。[O01]

## 6.2 桌面读取实现

`desktop.ts` 只在受支持桌面前端并且存在 Node require 时加载 Node 内建模块；移动/Web 包不静态导入 fs。使用 `fileURLToPath`、`realpath`、只读 `open("r")`、读取前后 stat 验证、分块读取、字节上限、最终 close。

文件路径来自笔记内容并不自动代表授权。示例逐文件确认；实际产品可追加“本次会话授权目录”的细化能力，但必须 realpath 后做目录边界比较，不是简单字符串 startsWith。任何自动删除都不涉及电脑文件。

默认不读 UNC、网络共享、特殊文件。请求取消对 OS I/O/解码通常是协作式的，不能承诺一个不可取消的系统调用必在任意毫秒上限内结束。

## 6.3 浏览器/移动端和 CORS 兜底

提供实际的 `singleFromFile()`：用户明确选择该链接对应的原图 File，再完成压缩和引用更新。选择的 File 只保存在本次任务 Map 中，不保存为跨任务授权，也不因为文件名相同自动替换其他图片字节。此路径**不删除既有工作区源资产**，避免选错 File 后错误清理。

URL 下载：
- 桌面：授权后使用内置只读 HTTP(S) 传输，进行 DNS/IP、重定向、长度和超时限制，不传 Cookie。
- 浏览器/移动：直接 fetch，`credentials: omit`、`referrerPolicy: no-referrer`、`redirect: error`。CORS 不允许时明确失败，原引用不变。
- 不默认调用任意内核代理规避 CORS，不假装浏览器具备 Node 能力。
- 用户可以改用“从文件导入并压缩此图片”。这个入口也是网络离线或鉴权图床的明确兜底。

## 6.4 URL 下载安全与功能边界

自动下载名单为**精确 HTTPS origin**，例如 `https://images.example.org`，不是 `*.example.org`，不是任意前缀字符串。手动授权仅影响本次任务，不扩大自动授权。

下载器提供：总字节上限、流式截断、有限重定向、每跳来源验证、禁止 HTTPS 降级、取消信号、无认证转发、MIME/签名复核。桌面示例限制 IPv4 并屏蔽常见私网/保留范围，DNS 结果校验后固定实际连接地址；IPv6 应由完整审计的地址分类器扩展，而非随手增加一条正则。

**不要声称直接浏览器 fetch 可以证明 DNS 目标永远不是私网。** 浏览器通道依赖用户精确授权与浏览器安全边界；需要更强网络边界时，应选择经审计的宿主下载适配器，而非把现有前端检查称作完备 SSRF 防护。

## 6.5 自动 URL 的实现方式

没有假设存在一个覆盖所有图片 URL 输入的官方专用事件。

`watchRemoteImages()`：
1. 读取完整、已持久化的当前文档 DOM 建立基线。
2. 只观察该编辑器的图片相关 DOM 变化；延迟后向内核重读。
3. 只有持久化图片出现新增且自动策略/来源名单允许，才启动任务。
4. 文档打开、折叠展开、虚拟化加载不能因为图片第一次进入屏幕而被当成新增。
5. 自动任务只改目标块中的该 URL 图片引用，不进行跨文档后台大改；手动单图/文档任务才进行共享引用更新。
6. 同一块里同 URL 多次出现时统一替换该块的图片引用，**不假设新图片一定在最后一个序号**。
7. undo/redo 时重建基线；同步开始停观察，同步结束/失败后重建；编辑器销毁、切文档、Feature 关闭全部清理。

这是一条**保守的自动补充通路**，不是所有插件、导入、CLI、MCP、后台内核修改的完整事件日志。持久化延迟超过两次观察窗口可能延后处理；目标工程验收时可增加有界重读退避，不能无限轮询全工作区。普通文本 URL 不自动当成图片下载。

---

# 7. 图片压缩、命名、原图保留与清理

## 7.1 唯一任务意图

```ts
type Intent =
  | { kind: "document"; rootID: string }
  | { kind: "manual-single"; rootID: string }
  | { kind: "upload"; rootID: string; originalInputCount: number }
  | { kind: "remote-auto"; rootID: string; blockID: string };
```

任务启动时冻结 intent 和配置快照。用户在处理中打开删除开关，不会把已经创建的批量任务升级成可删除任务。

## 7.2 保留矩阵

| 操作 | 删除选项关闭 | 删除选项开启 |
|---|---|---|
| 上传总批次只有 1 个文件 | 原 File 归档并确认后返回 WebP | 可以只上传 WebP；没有“先创建原资源再删除”的必要 |
| 上传多个文件，即使其中只有 1 张图片 | 归档被替换的原 File | **仍归档**，不能用图片数量代替原始文件总数 |
| 手动单张工作区图片 | 保留源资产 | 完整验证且清理契约受审计后，才尝试安全清理 |
| 当前文档批量 | **保留** | **保留；永不调用清理入口** |
| 自动外链 | 下载字节归档，远端文件不动 | 同左 |
| 手动外链/电脑文件 | 可归档下载字节，外部文件不动 | 不强制归档，但外部原文件永不删除 |
| 用户手选 File 作为原图兜底 | 不删除既有原资源 | 同左，不能把选中 File 当成源资产身份证明 |

“文档批量保留”保证本次流程不删除源资源；不等于能够禁止用户以后使用思源自身清理功能。需要长期保管时可以增加单独的归档/保留管理，而不能把资源永久保留和当前操作不删图混为一谈。

## 7.3 上传归档为什么需要真实引用

仅把原资源路径写进插件 JSON，不一定算宿主认可的资源引用。示例归档后设置独立的 `custom-data-assets-omnikit-*` 根块属性并读取验证；该前缀对应宿主已有的资产保留语义。不同任务使用独立属性，避免并发读改写同一数组。[H10]

注意：
- 归档是额外写入，单独于宿主上传批次；不把原图插入 host 的 files 数组。
- 归档失败则该 File 回退原始文件，不假装已保留。
- 上传完成回调不表示父级正文保存完成；提示必须区分。[H13]
- 归档会增加空间占用，应提供说明和后续显式管理；不要默认循环清理这些归档。
- 原生全局重链接可能更新自定义资产引用，因此“归档原图不可变保护”若未来要求更强，必须专门定义保留引用排除策略；当前实现不承诺可对抗用户后续主动重链接。

## 7.4 命名

编码器将 `图表-原资源ID.png` 的可读部分变成 WebP 名称；最终路径以 `/api/asset/upload` 返回为准。

宿主新资源上传主动生成资源 ID，可能清洗名称或复用已有内容，不能承诺整个磁盘文件名只改后缀。**不使用 rename/putFile 覆盖原资产来强行保持完整文件名**。[H11]

业务文件名与资源实体 ID 分离：可读名称保持，内核 ID 接受重新分配。同内容不同名称不应为了内容去重就全变成第一张图的名字。

## 7.5 格式保护

硬性保护：GIF、SVG、APNG、动画 WebP、Excalidraw/绘图资产、MPO 类多图片 JPEG、当前不支持的 CMYK/异常 JPEG。移除“扩展名排除”里的 GIF/SVG 不会绕过硬保护；设置页需明确。

签名检查不是完整图像解码器，也不是安全沙箱。输出必须再次解码。输入超过字节/像素/估算内存预算时跳过/失败，不先解码成超大位图再检查。

当前实现允许头部确认的 JPEG/PNG/静态 WebP，空或通用 MIME 不直接否定真实图片；宣称的 image MIME 与签名冲突则拒绝。是否进一步允许已知错误的 HTTP MIME，应另立明确策略，不能默认容错所有内容。

## 7.6 单图安全清理流程

```text
必须 manual-single
→ 用户允许
→ 源为普通工作区 asset，不是 file/URL/加密资产
→ 新旧路径不同
→ native 引用更新明确验证成功
→ 宿主版本位于已审计 cleanup profile
→ 原文件字节仍与压缩读取时一致
→ 再次查询引用，不存在剩余/不可处理引用
→ 取得内核未引用资源列表，唯一映射到数据相对路径
→ removeUnusedAsset（而非 removeFile）
→ 结果明确或标记 unknown；不自动重发
```

内核清理包含历史备份，所以“移出活动资源目录”**不等于实际磁盘立即回收相同字节**。结果不应显示虚假的磁盘收益。[H05][H06]

SQL 路径可以替换共享图片块，但没有宿主全引用/并发清理证明，**该路径自动清理保持禁用**。这是明确的安全降级，不是没有实现 SQL 功能。

---

# 8. 引用写入、并发、恢复和任务状态

## 8.1 按资源准备，按块提交

下载、Hash、编码、上传和回读验证采用有界管线，而不是先把全篇所有 Blob 留在内存中。每个任务按 source key 去重，压缩成功后再创建引用映射。

同一块里有多张待更新图片时，生成一个 patch、提交一次。父块包含子块时不能整体提交父快照，否则可能覆盖无关子块。代码只提交图片所属的最内层块，遇到不支持的容器结构拒绝，不猜结构。

**与现有按内容 Hash 去重的关系**：参考实现保留路径去重与完整性 Hash，但没有让同内容、不同可读名称共享一个输出路径。目标项目可复用现有内容 Hash 计算来缓存“编码结果”，不能悄悄回退成“所有同内容资源都改成第一张图的名字”。编码缓存应有总字节上限、任务级清理，并把编码参数/输出格式纳入 key。

## 8.2 DOM 属性语义，而不是宽泛正则

使用离屏 `<template>` 解析内核 DOM：
- `custom-src` 不会被当成 `src`；
- `data-src` 若存在，作为源引用，不回退到不相关预览图；
- 只有 `src` 确认指向同一资源时才一起更新；
- 保留 alt/title/style 等属性；
- 跳过代码和查询嵌入的渲染副本；
- 链接与图片同源时可一起更新；
- DOM 序列化会规范化 HTML，不承诺字节级原样。

**必须补目标项目 Lute round-trip 夹具**：独立浏览器测试证明属性匹配逻辑，不代表所有思源节点都能无差异地往返序列化。

## 8.3 并发边界

插件内共用写锁避免本 Feature 的多个写任务互相覆盖；写前两次读取及持久化后再次比较减少冲突窗口。

但 `/api/block/updateBlock` 的 `lockType` 不是版本 CAS。用户编辑、其他插件、其他窗口、同步仍可能在最后读和写之间发生变化。SQL 路径不能声称绝对原子。检测到变化就停止/报告冲突，不覆盖用户新文本。[H12]

也不把多个 HTTP 写请求包装成 Promise.all 就称为“事务”。取消发生在请求发出后，只能阻止后续操作，不能撤销已提交的内核写入。

## 8.4 状态与错误

任务状态：`preparing / preview / applying / done / partial / cancelled / failed / unknown`。

- `uploaded`：已经生成并上传的新资源数；
- `referencesChanged`：SQL 路径可确认的引用数；原生不能直接得知则为 null；
- `storageRecordsChanged`：原生 updated 等存储记录量；
- `unknown`：结果未确认，不自动重试；
- `partial`：部分明确成功，部分冲突/失败；成功部分不盲目倒回。

原始上传请求可能已经落盘但响应超时；此时不能删除新资源“做清理”，因为用户或宿主可能已经使用它。

## 8.5 可恢复日志

`JobJournal` 在首次引用写入前保存不可变 before/after 计划，随后记录 sent/verified/conflict/unknown。配置写入和日志写入分开；不把正文快照塞进图片配置。

日志含笔记 DOM、资源路径，可能含私密信息或带 token 的 URL。因此：
- 仅保存在本插件明确命名的私有存储；
- 不默认上传诊断；
- UI/控制台默认不输出完整正文；
- 不支持把加密笔记本明文写入普通日志；
- 后续增加日志索引、数量/时长限额和显式“删除任务记录”，只删除本插件日志，不连带删 assets；
- 目标接线需将日志/未确认任务接入已有 TaskRegistry；重启后**不自动继续引用写入**。

条件恢复代码已给出。仅当当前块与本次 `after` 快照完全相同才恢复 `before`；已经被用户编辑的块报告冲突。恢复前验证原始资源仍可读；原生任务优先使用宿主历史，不做粗暴的 `newPath → oldPath` 全局反向替换，因为多对一映射可能不可逆。

---

# 9. 设置页与任务窗口

## 9.1 布局

```text
┌ Core：OmniKit 导航 ─┬ 图片压缩         [Feature 总开关] ┐
│ 通用                │ 运行状态 / 宿主版本 / 能力提示     │
│ 图片压缩            ├──────────────────────────────────┤
│ 其他 Feature        │ 自动处理                         │
│                     │ 全局范围 / 上传 / 外链 / 文档名单 │
│                     │ 编码质量与尺寸                   │
│                     │ 原图保留                         │
│                     │ [单图删除] + 批量强制保留说明      │
│                     │ 图片来源                         │
│                     │ 本地读取 / HTTPS 来源名单         │
│                     │ 高级限制（折叠）                  │
│                     ├──────────────────────────────────┤
│                     │ 更改未保存        [放弃] [保存]   │
└─────────────────────┴──────────────────────────────────┘
```

使用 `b3-button`、`b3-switch`、`b3-text-field` 与 `--b3-theme-*` 变量；不写死整页白底和蓝色。窄屏控制项换行，危险说明不被横向挤出。高级性能参数折叠，不让新用户一眼看到十几个数字框。

## 9.2 必须保留的交互

- Feature 停用时可以调整参数，说明“运行已停用”。
- 设置草稿与已保存值分离；整组保存，避免数字输入一半就写盘。
- 保存前校验范围、扩展名、origin、文档 rootID。
- 外部同步改变了配置且本地有未保存草稿时显示冲突；不静默覆盖草稿，也不回写旧版本。
- 保存回调在 store 的串行 update 内再次检查 baseline，避免检查后变化。
- Svelte 深度状态是 Proxy：用 `$state.snapshot()` 获取可序列化快照，不能直接 `structuredClone(proxy)`。
- 图片 schema 不支持时可备份重置，但不是自动升级兼容。
- 全局自动关闭时，文档白名单仍有效且不清空。
- “单图删除”旁永久显示“文档批量永远保留原图”。

## 9.3 任务窗口

展示阶段、唯一来源准备进度、上传数、跳过/失败数、引用后端、明确的引用/存储计数。扫描和 native apply 无可靠百分比时用不定进度，不造一个看似精准的进度值。

取消文案解释“停止后续操作，已提交修改不会自动撤销”。未知状态显示“先检查任务记录，不要重复提交”。SQL 成功旁显示覆盖范围提示，不只显示绿色“全部完成”。

三份完整组件在代码附录：`ImageSettingsPanel.svelte`、`ImageSettingsBridge.svelte`、`ImageTaskPanel.svelte`。**它们未在本环境的真实 Svelte 工程中编译或渲染，本轮没有把上一版 HTML 原型截图当作这些组件已验证的证据。**

---

# 10. 交给 Agent 的具体实施步骤

## 10.1 先固定基线与测试

```bash
git switch -c refactor/image-compressor-v2 f178de06b9233e1e2968b8f18bd224d4d5939266
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

先记录原仓库真实测试结果，再改动。本文测试不是原仓库测试的替代品。

## 10.2 配置与设置接线

1. 保持 `IMAGE_FEATURE_ID = "imageCompressor"`。
2. 图片注册 codec 换成 `config.ts` 的 `defaults / parseConfig`。
3. 从旧 codec 删除 schema1 的 skip 布尔兼容读取；保留旧文件备份保护机制。
4. 文件名使用 Core 统一派生函数；当前 ID 派生结果不变。
5. SettingsRoot / FeatureRegistration Props 按第 5.5 节调整。
6. 图片 `settingsView` 改为 `ImageSettingsBridge`，其他 Feature 仍由各自组件负责。
7. 两份 i18n 合并进现有 `src/i18n`，不要移动项目 i18n 根目录。
8. 展示能力时区分“桌面前端理论上支持”和“实际 require/传输/接口已探测成功”；Bridge 的桌面提示是版本/前端提示，不是运行时完整证明。

## 10.3 Feature 运行时接线

保留当前 `ImageCompressorFeature` 和 `imageMenuContributions`。在 `onEnable(context, scope)` 调用 `createImageRuntime()`，注入现有 store、翻译和**明确的编辑器上下文解析器**。将 runtime.dispose 归入当前 FeatureScope。

`resolveEditor(protyle)` 只接受事件传入的 protyle，检查 rootID、notebook、element、disabled；不能使用页面第一个 `.protyle` 兜底。现有代码已有 identity/menu router，可复用并补类型。

菜单动作分别连接：

```ts
// 传入的 editorContext 来自触发该菜单的 editor，而不是当前全局焦点。
runtime.controller.single(targetImage, editorContext);
runtime.controller.document(editorContext);
runtime.controller.singleFromFile(targetImage, editorContext);
```

用统一错误边界捕获菜单 Promise，显示错误而不是产生 unhandled rejection。文档树入口若没有可验证的编辑器上下文，先打开/定位目标文档或明确不提供该动作，不能将别的文档作为目标。

接线时**移除或停用旧的** AutoUploadHandler、SingleImageAction、DocumentBatchAction 的重复注册；不能新旧两套同时监听同一上传事件。

## 10.4 运行时初始化代码的定位

`runtime.integration.ts` 展示实际装配：
- HttpKernel；
- 可选 DesktopBridge；
- SourceReader；
- 估算内存预算与本地 BIC Worker URL；
- AssetStore；
- **唯一** ReferenceService；
- ImageJobRunner；
- 独立 SingleOriginalFinalizer；
- ImageController；
- 自动上传和文档观察器。

它不是新 Plugin 入口；不可新建第二个顶栏、Dock 或全局事件总线。

`ImageController.document()` 不会访问 finalizer。仅 `single()` 在整个任务明确成功后进入清理；选择 File 兜底时清理也禁止。这个调用图和 finalizer 的运行时检查要同时保留。

## 10.5 构建与依赖

保留项目现有 BIC 本地 bundle 复制逻辑，确保包中有 `browser-image-compression.js`，不要 runtime CDN。锁定版本、锁文件、许可证信息。主入口仍符合思源加载要求，Worker 资源与入口构建分开验证。

本地文件能力动态加载 Node built-ins，移动/Web 构建不得静态依赖 `fs`、Electron 或 sharp。`.integration.ts` 的 `siyuan`/Svelte 类型和 `imageCompression` adapter 必须在目标工程重新检查，不能因为独立 core tsc 通过就跳过这一项。

## 10.6 推荐 PR 顺序

| PR | 范围 | 放行条件 |
|---|---|---|
| 1 | v2 codec、命名、配置重置、来源解析 | v1 拒绝、无自动覆盖、路径测试通过 |
| 2 | 请求语义、native/SQL 引用、物理消歧 | 旧版真实共享替换；原生写后无 SQL；无误改 |
| 3 | 编码保护、输出校验、任务管线 | 动画保护、低收益不替换、内存/取消验证 |
| 4 | 本地路径和 local-files | 单图/混合批次/大小限制/权限/顺序验证 |
| 5 | 外链手动和自动 | 真实图床、CORS、重定向、同步/撤销测试 |
| 6 | 原图归档与单图清理 | batch 禁删、归档失败保留、未知清理不重试 |
| 7 | Svelte 设置/进度、日志恢复接线 | 真 Svelte 编译、主题/窄屏、挂卸载无泄漏 |
| 8 | 实机矩阵、构建/发布和架构文档 | API 真实响应夹具、桌面/移动/旧版验收 |

---

# 11. 进一步优化与明确不做的事

## 11.1 值得做，但不挤进第一轮高风险改造

**编码缓存**：任务内缓存编码结果，key 包含源内容 Hash、配置、引擎版本、输出格式；设置总字节 LRU 上限。上传命名仍按来源独立决定，避免内容去重破坏名称与资源身份。

**引用扫描性能**：当前旧版完整扫描可作为正确性基线。后续用 SQL assets/spans 索引作候选加速，但必须有覆盖证明和完整性回退，不能用一个 LIMIT 64 查询替代整工作区。

**任务恢复 UX**：将 JobJournal 接入任务列表，提供“检查当前状态”“查看影响文档”“条件恢复”“删除本插件日志”。不自动重试 unknown；日志索引只存元数据，完整快照按需读取。

**资源预览**：单图压缩前后并排对比可提升文字截图体验。预览 Blob URL 必须释放；预览不是已保存，不改变笔记。任务窗口可链接到受影响文档，不输出整个签名 URL。

**质量模式**：照片、文字截图、透明素材分组预设；“真正无损 WebP”作为独立 codec 模式研发。不要把“高质量”文案当作 lossless 实现。

**本地文件授权**：会话目录授权可减少多图确认，但不能永久保存任意外部目录信任；移动/Web 继续要求用户选择 File。

**能力面板**：明确显示 native 可用/SQL/权限受限、Worker 是否真的启动、桌面文件桥是否存在、清理 profile 是否受审计。状态在内存，不写入用户配置当永久事实。

**性能回归**：大图、50/200 图片任务、长文档、多个编辑器、快速开关、反复打开设置。估算内存预算是准入控制，不是进程 RSS 硬上限；保留移动端单并发默认。

## 11.2 明确拒绝

不做全局 fetch/XHR monkey patch；不覆盖原资源路径；不直接 UPDATE 数据库；不绕过宿主加密边界；不删除电脑文件；不把历史备份字节计成已回收磁盘；不对失败请求无限重试；不通过 SQL 零引用作全工作区删除证明；不做图片配置 v1 迁移；不引入完整依赖注入容器或动态脚本 Feature 市场。

---

# 12. 复核记录、验收与验证边界

## 12.1 本轮多轮复核产生的实际改动

| 复核 | 初始风险 | 最终处理 |
|---|---|---|
| 版本核查 | 把 v3.8.9 误当首次支持 | 核实 v3.8.3 缺失、v3.8.4 数组接口存在 |
| 旧版安全 | native catch 后一律 SQL | 只读 404/405 可切换；写后错误绝不切换 |
| 资源身份 | 只凭 assets 字符串相同 | 增加目录级物理消歧，拒绝多个位置/符号链接 |
| 上传协议 | 想象 `action:"continue"` | 官方仅 replace/cancel；异步回退 replace 原始 input |
| 上传归档 | “未删除”冒充“已保留” | 原 File 先归档并确认，不增加 host 批次数量 |
| 多文件 | 用可压缩图片数判断“单图” | 固定原始总输入数；混合批次仍保留 |
| 自动外链 | 可见 DOM 基线误判折叠图 | 先读完整持久化基线 |
| 自动重复图 | 假定新增图片在末尾 | 同块同 URL 图片统一替换，不猜出现序号 |
| 并发队列 | Promise.all 提前 reject，后台 worker 仍运行 | 停发新任务并等待已启动 worker 收尾 |
| Svelte | 对状态 Proxy structuredClone | 改用 `$state.snapshot()` |
| 写前校验 | 校验后又等待日志网络 I/O | 日志持久化之后再次读取并比对 |
| 恢复 | 全局反向路径替换 | 只恢复仍匹配 after 快照的 SQL 块 |
| MIME | 空 MIME 导致本地文件全拒绝 | 签名确认真实格式；冲突 MIME 仍拒绝 |
| 统计 | native updated 当图片数/磁盘节省 | 区分存储记录、引用、未知，不虚报磁盘回收 |

## 12.2 本次已执行验证

- 独立核心 TypeScript：`tsc -p tsconfig.json` 通过。
- **Node 测试：66 项，66 通过，0 失败。**
- **Chromium 独立浏览器测试：19 项，19 通过，0 页面脚本错误。**
- 浏览器测试覆盖精确 HTML 属性、Unicode/实体、所属块、共享两文档 SQL 更新、冲突不覆盖、native 写后不 SQL、条件恢复、真实 WebP 夹具解码。
- 图片夹具由固定种子的 Pillow 脚本生成，未使用用户笔记数据。
- BIC 编码 adapter 的 Node 测试使用注入的测试编码器；**不是实际 BIC 性能/编码质量基准**。

## 12.3 尚未验证，Agent 必须补

本环境没有安装目标仓库依赖，**没有执行原仓库 `pnpm check/test/build`，没有编译 `.integration.ts` 与 Svelte 组件，没有启动真实思源桌面、浏览器或移动端。** 独立浏览器测试的内核 API 是 mock，不能代替真实契约测试。

必须补的矩阵：

| 类别 | 最低验收 |
|---|---|
| 宿主版本 | v3.8.3 旧 SQL；v3.8.4 native；v3.8.9 清理；真实目标最新版 |
| 原生 API | 真实返回数组、partial、dryRun、skippedNotebooks、历史路径、错误 data |
| SQL | 搜索限制很小仍完整翻页；未索引/关闭/加密文档；父子块；HTML/AV 边界 |
| 文件位置 | 全局、笔记本、文档 assets；同名副本；符号链接；大小写；按需资源未下载 |
| 上传 | File[]、local-files、混合、同名、目录、超限、取消、另一个插件先替换 |
| 平台 | Windows/macOS/Linux；Web 远程内核；移动端选图 |
| 网络 | 无 CORS、允许 CORS、重定向到未授权 origin、带查询 token、401/403、断网 |
| 图片 | 透明、方向、长图、大像素、APNG、动画 WebP、损坏字节、低收益 |
| 生命周期 | 启用中关闭、上传中关闭、旧菜单回调、多个编辑器、同步、undo/redo |
| UI | 浅色/深色/第三方主题；窄屏；键盘焦点；草稿与外部同步冲突 |
| 发布 | 本地 Worker 真正运行、断网可用、CSP、ZIP 资源与许可证齐全 |
| 删除 | 每一条 batch 路径都没有删除请求；native 单图校验失败保留；SQL 永不自动清理 |
| 恢复 | 日志保存失败、写入未知、重启后不自动续写、用户修改后拒绝回滚 |

**发布准则**：不把没有测试的输入类型写成支持，不把 mock 结果写成实机通过，不把草稿代码写成已合并功能。实施 Agent 应保留这些验证边界，逐项用真实结果替换。

---

# 13. 完整代码

## 13.1 文件清单与使用方式

以下为同一套相互闭合的参考实现，不是互不相干的碎片。

- 通用核心：`core.ts`、`config.ts`、`kernel.ts`、`state.ts`。
- 来源：`source.ts`、`download.ts`、`desktop.ts`。
- 图片与资源：`image.ts`、`assets.ts`、`asset-identity.ts`。
- 引用与任务：`dom.ts`、`references.ts`、`jobs.ts`、`recovery.ts`。
- 功能入口：`auto-upload.ts`、`remote-auto.ts`、`controller.ts`。
- 目标工程接线：`runtime.integration.ts`、`ui-host.integration.ts`。
- 设置/任务 UI：三个 Svelte 文件和两份 i18n。
- 验证：Node 测试、浏览器测试、夹具生成脚本、独立 TypeScript 配置。

接线文件中的环境接口（事件上下文、菜单、翻译、现有 JsonStore）由现有仓库提供；不要重新实现一个主 Plugin。对话框确认等 integration 文案包含中文参考文本，正式发布时同样移入现有 i18n，而不是让核心业务层调用特定语言。


## 13.2 `core.ts`

通用能力最小参考；接入时与现有 FeatureScope/FeatureKit 合并，不新增第二套主插件生命周期。

```typescript
/** Shared, framework-independent utilities. No SiYuan business logic here. */
export type Dispose = () => void;
export function abortIf(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError");
}
export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
export function clone<T>(v: T): T { return structuredClone(v); }
export function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class Scope {
  private readonly controller = new AbortController();
  private disposers = new Set<Dispose>();
  get signal(): AbortSignal { return this.controller.signal; }
  get active(): boolean { return !this.signal.aborted; }
  own(dispose: Dispose): Dispose {
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      this.disposers.delete(once);
      dispose();
    };
    if (this.active) this.disposers.add(once); else once();
    return once;
  }
  guard<A extends unknown[]>(fn: (...a: A) => void): (...a: A) => void {
    return (...a) => { if (this.active) fn(...a); };
  }
  dispose(): void {
    if (!this.active) return;
    this.controller.abort();
    const errors: unknown[] = [];
    for (const dispose of [...this.disposers].reverse()) {
      try { dispose(); } catch (e) { errors.push(e); }
    }
    if (errors.length) console.error("Scope cleanup failures", errors);
  }
}

/** A merged signal with explicit listener cleanup; do not accumulate listeners. */
export function deadline(parent: AbortSignal | undefined, ms: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(parent?.reason);
  if (parent?.aborted) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Deadline exceeded")), ms);
  return {
    signal: controller.signal,
    close() { clearTimeout(timer); parent?.removeEventListener("abort", abort); },
  };
}

export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();
  async run<T>(key: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => current);
    this.tails.set(key, tail);
    await previous.catch(() => undefined);
    try { abortIf(signal); return await fn(); }
    finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export async function mapLimited<T>(
  values: readonly T[], limit: number, signal: AbortSignal | undefined,
  run: (value: T, index: number) => Promise<void>,
): Promise<void> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid concurrency");
  let cursor = 0, failed = false;
  let failure: unknown;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (!failed) {
      try {
        abortIf(signal);
        const index = cursor++;
        if (index >= values.length) return;
        await run(values[index], index);
      } catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  });
  await Promise.all(workers);
  if (failed) throw failure;
}

export class MemoryBudget {
  private used = 0;
  private readonly mutex = new KeyedMutex();
  constructor(readonly capacity: number) {}
  /** Serial admission; reservations are released even if a decoder throws. */
  async run<T>(bytes: number, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > this.capacity)
      throw new Error("Image exceeds memory budget");
    for (;;) {
      abortIf(signal);
      const granted = await this.mutex.run("budget", signal, async () => {
        if (this.used + bytes > this.capacity) return false;
        this.used += bytes;
        return true;
      });
      if (granted) break;
      await new Promise<void>(resolve => setTimeout(resolve, 25));
    }
    try { return await fn(); }
    finally { this.used -= bytes; }
  }
}

export interface ConfigStore<T> {
  snapshot(): Readonly<T>;
  update(mutator: (draft: T) => void): Promise<boolean>;
  subscribe(listener: (next: Readonly<T>) => void): Dispose;
  readonly needsRecovery: boolean;
  readonly error?: string;
}
export interface EventPort {
  on(name: string, handler: (event: CustomEvent<any>) => void): void;
  off(name: string, handler: (event: CustomEvent<any>) => void): void;
}
export interface FeatureKit<T> {
  readonly id: string;
  readonly scope: Scope;
  readonly config: ConfigStore<T>;
  on(name: string, handler: (event: CustomEvent<any>) => void): Dispose;
  subscribe(listener: (next: Readonly<T>) => void): Dispose;
}
export function createKit<T>(
  id: string, scope: Scope, config: ConfigStore<T>, bus: EventPort,
): FeatureKit<T> {
  return Object.freeze({
    id, scope, config,
    on(name: string, handler: (event: CustomEvent<any>) => void) {
      const guarded = scope.guard(handler);
      bus.on(name, guarded);
      return scope.own(() => bus.off(name, guarded));
    },
    subscribe(listener: (next: Readonly<T>) => void) {
      return scope.own(config.subscribe(scope.guard(listener)));
    },
  });
}
```

## 13.3 `config.ts`



```typescript
import { isRecord } from "./core.js";
export const MiB = 1024 * 1024;
export const NODE_ID = /^\d{14}-[a-z0-9]{7}$/;
export interface ImageConfig {
  schemaVersion: 2;
  auto: {
    globalEnabled: boolean;
    pageAllowlist: Record<string, { grantedAt: number; title: string }>;
    uploads: boolean;
    remoteImages: boolean;
  };
  compression: {
    initialQuality: number;
    maxDimension: number;
    minInputBytes: number;
    minSavingBytes: number;
    minSavingRatio: number;
    maxInputBytes: number;
    maxPixels: number;
    maxEncodeMs: number;
    concurrencyDesktop: number;
    concurrencyMobile: number;
    excludedExtensions: string[];
  };
  sources: { remoteOrigins: string[]; desktopLocalFiles: boolean };
  retention: { deleteSingleOriginal: boolean };
  references: { backend: "auto" | "sql"; maxDocuments: number };
}
export class UnsupportedConfigError extends Error {}
export function defaults(): ImageConfig {
  return {
    schemaVersion: 2,
    auto: { globalEnabled: false, pageAllowlist: {}, uploads: true, remoteImages: false },
    compression: {
      initialQuality: 0.8, maxDimension: 4096, minInputBytes: 100 * 1024,
      minSavingBytes: 4096, minSavingRatio: 0.05, maxInputBytes: 32 * MiB,
      maxPixels: 32_000_000, maxEncodeMs: 45_000,
      concurrencyDesktop: 2, concurrencyMobile: 1,
      excludedExtensions: ["gif", "svg", "webp"],
    },
    sources: { remoteOrigins: [], desktopLocalFiles: true },
    retention: { deleteSingleOriginal: false },
    references: { backend: "auto", maxDocuments: 10_000 },
  };
}
function object(v: unknown, name: string): Record<string, unknown> {
  if (!isRecord(v)) throw new Error(`${name}: object required`);
  return v;
}
function bool(v: unknown, name: string): boolean {
  if (typeof v !== "boolean") throw new Error(`${name}: boolean required`);
  return v;
}
function number(v: unknown, name: string, min: number, max: number, integer = false): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max
      || integer && !Number.isSafeInteger(v)) throw new Error(`${name}: out of range`);
  return v;
}
export function parseExtensions(raw: string): string[] {
  const values = raw.split(/[,，]/).map(s => s.trim().replace(/^\./, "").toLowerCase()).filter(Boolean);
  if (values.some(s => !/^[a-z0-9]+$/.test(s))) throw new Error("Invalid extension");
  return [...new Set(values)];
}
/** Only v2 is accepted. No v1 field mapping, default-filling or auto-rewrite. */
export function parseConfig(raw: unknown): ImageConfig {
  const r = object(raw, "config");
  if (r.schemaVersion !== 2) throw new UnsupportedConfigError("Only image config schemaVersion 2 is supported");
  const a = object(r.auto, "auto"), c = object(r.compression, "compression");
  const s = object(r.sources, "sources"), t = object(r.retention, "retention");
  const refs = object(r.references, "references"), pages = object(a.pageAllowlist, "pageAllowlist");
  const pageAllowlist: ImageConfig["auto"]["pageAllowlist"] = {};
  for (const [id, value] of Object.entries(pages)) {
    if (!NODE_ID.test(id)) throw new Error("Invalid document ID");
    const p = object(value, "permission");
    if (typeof p.title !== "string" || p.title.length > 512) throw new Error("Invalid title");
    pageAllowlist[id] = { grantedAt: number(p.grantedAt, "grantedAt", 0, Number.MAX_SAFE_INTEGER, true), title: p.title };
  }
  if (!Array.isArray(c.excludedExtensions) || c.excludedExtensions.some(v => typeof v !== "string" || !/^[a-z0-9]+$/.test(v)))
    throw new Error("Invalid excludedExtensions");
  if (!Array.isArray(s.remoteOrigins) || s.remoteOrigins.length > 128) throw new Error("Invalid remoteOrigins");
  const origins = s.remoteOrigins.map(v => {
    if (typeof v !== "string") throw new Error("Invalid origin");
    const u = new URL(v);
    if (u.protocol !== "https:" || u.username || u.password || u.origin !== v)
      throw new Error("Automatic download requires an exact HTTPS origin");
    return v;
  });
  if (refs.backend !== "auto" && refs.backend !== "sql") throw new Error("Invalid backend");
  return {
    schemaVersion: 2,
    auto: { globalEnabled: bool(a.globalEnabled, "globalEnabled"), pageAllowlist,
      uploads: bool(a.uploads, "uploads"), remoteImages: bool(a.remoteImages, "remoteImages") },
    compression: {
      initialQuality: number(c.initialQuality, "initialQuality", 0.1, 1),
      maxDimension: number(c.maxDimension, "maxDimension", 256, 8192, true),
      minInputBytes: number(c.minInputBytes, "minInputBytes", 0, 128 * MiB, true),
      minSavingBytes: number(c.minSavingBytes, "minSavingBytes", 0, MiB, true),
      minSavingRatio: number(c.minSavingRatio, "minSavingRatio", 0, 0.9),
      maxInputBytes: number(c.maxInputBytes, "maxInputBytes", MiB, 128 * MiB, true),
      maxPixels: number(c.maxPixels, "maxPixels", 1_000_000, 64_000_000, true),
      maxEncodeMs: number(c.maxEncodeMs, "maxEncodeMs", 1000, 90_000, true),
      concurrencyDesktop: number(c.concurrencyDesktop, "concurrencyDesktop", 1, 4, true),
      concurrencyMobile: number(c.concurrencyMobile, "concurrencyMobile", 1, 2, true),
      excludedExtensions: [...new Set(c.excludedExtensions as string[])],
    },
    sources: { remoteOrigins: [...new Set(origins)], desktopLocalFiles: bool(s.desktopLocalFiles, "desktopLocalFiles") },
    retention: { deleteSingleOriginal: bool(t.deleteSingleOriginal, "deleteSingleOriginal") },
    references: { backend: refs.backend, maxDocuments: number(refs.maxDocuments, "maxDocuments", 1, 100_000, true) },
  };
}
export function configFile(id: string): string {
  if (!/^[a-z][a-zA-Z0-9]*$/.test(id)) throw new Error("Invalid feature ID");
  return `feature-${id.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}.json`;
}
export function validateFeatureFiles(ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate feature ID");
  const names = ids.map(configFile);
  if (new Set(names).size !== names.length) throw new Error("Feature filename collision");
}
export function autoAllowed(c: ImageConfig, rootID: string): boolean {
  return NODE_ID.test(rootID) && (c.auto.globalEnabled || Object.hasOwn(c.auto.pageAllowlist, rootID));
}
export type Intent =
  | { kind: "document"; rootID: string }
  | { kind: "manual-single"; rootID: string }
  | { kind: "upload"; rootID: string; originalInputCount: number }
  | { kind: "remote-auto"; rootID: string; blockID: string };
export function retainOriginal(intent: Intent, config: ImageConfig): boolean {
  if (intent.kind === "document" || intent.kind === "remote-auto") return true;
  if (intent.kind === "upload" && intent.originalInputCount !== 1) return true;
  return !config.retention.deleteSingleOriginal;
}
```

## 13.4 `kernel.ts`



```typescript
import { abortIf, deadline, isRecord } from "./core.js";
export interface Envelope<T = unknown> { code: number; msg: string; data: T }
export class RequestError extends Error {
  constructor(
    message: string,
    readonly outcome: "not-sent" | "read-failed" | "unknown-write",
    readonly status?: number,
    readonly response?: unknown,
    options?: ErrorOptions,
  ) { super(message, options); this.name = "RequestError"; }
}
export interface Kernel {
  post(path: string, body: object | FormData, mode: "read" | "write",
       signal?: AbortSignal, timeoutMs?: number): Promise<Envelope>;
}
export class HttpKernel implements Kernel {
  constructor(private readonly origin: string, private readonly send: typeof fetch = fetch) {
    const u = new URL(origin);
    if (!["http:", "https:"].includes(u.protocol) || u.origin !== origin) throw new Error("Invalid kernel origin");
  }
  async post(path: string, body: object | FormData, mode: "read" | "write",
    signal?: AbortSignal, timeoutMs = 30_000): Promise<Envelope> {
    if (!/^\/api\/[a-zA-Z0-9]+\/[a-zA-Z0-9]+$/.test(path))
      throw new RequestError("Invalid endpoint", "not-sent");
    if (signal?.aborted) throw new RequestError("Cancelled before dispatch", "not-sent");
    let payload: string | FormData;
    try { payload = body instanceof FormData ? body : JSON.stringify(body); }
    catch (cause) { throw new RequestError("Invalid request body", "not-sent", undefined, undefined, { cause }); }
    const timer = deadline(signal, timeoutMs);
    let dispatched = false;
    try {
      abortIf(timer.signal);
      dispatched = true;
      const response = await this.send(new URL(path, this.origin), {
        method: "POST", credentials: "same-origin", redirect: "error",
        headers: payload instanceof FormData ? undefined : { "Content-Type": "application/json" },
        body: payload, signal: timer.signal,
      });
      if (!response.ok) throw new RequestError(`Kernel HTTP ${response.status}`,
        mode === "read" ? "read-failed" : "unknown-write", response.status);
      const raw: unknown = await response.json();
      if (!isRecord(raw) || !Number.isInteger(raw.code) || typeof raw.msg !== "string" || !("data" in raw))
        throw new Error("Invalid kernel response");
      // Keep code!=0 AND its data. Native writes may report partial completion.
      return raw as unknown as Envelope;
    } catch (cause) {
      if (cause instanceof RequestError) throw cause;
      throw new RequestError("Kernel operation not confirmed",
        !dispatched ? "not-sent" : mode === "write" ? "unknown-write" : "read-failed",
        undefined, undefined, { cause });
    } finally { timer.close(); }
  }
}
export async function readData<T>(k: Kernel, path: string, body: object, signal?: AbortSignal): Promise<T> {
  const r = await k.post(path, body, "read", signal);
  if (r.code !== 0) throw new Error(`Read refused (${r.code}): ${r.msg}`);
  return r.data as T; // Domain adapters MUST validate the shape before relying on it.
}
export function unsupportedRead(error: unknown): boolean {
  return error instanceof RequestError && error.outcome === "read-failed"
    && (error.status === 404 || error.status === 405);
}
```

## 13.5 `state.ts`



```typescript
import { clone, type Dispose } from "./core.js";
export class StateStore<T> {
  private readonly listeners = new Set<(value: T) => void>();
  constructor(private value: T) {}
  snapshot(): T { return clone(this.value); }
  set(value: T): void {
    this.value = clone(value);
    for (const listener of this.listeners) {
      try { listener(this.snapshot()); } catch (error) { console.error("State listener failed", error); }
    }
  }
  subscribe(listener: (value: T) => void): Dispose {
    this.listeners.add(listener); listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }
}
```

## 13.6 `source.ts`



```typescript
export type ImageSource =
  | { kind: "asset"; raw: string; key: string; path: string; fetchURL: string; box?: string; name: string }
  | { kind: "remote"; raw: string; key: string; url: string; name: string }
  | { kind: "file"; raw: string; key: string; fileURL: string; name: string };
const ID = /^\d{14}-[a-z0-9]{7}$/;
function decodeSegment(s: string): string {
  const v = decodeURIComponent(s);
  if (!v || v === "." || v === ".." || /[\/\\\u0000-\u001f]/.test(v))
    throw new Error("Unsafe path segment");
  return v;
}
function assetPath(path: string): string {
  const withoutPrefix = path.replace(/^\.?\//, "");
  if (!withoutPrefix.startsWith("assets/")) throw new Error("Not an asset path");
  const parts = withoutPrefix.split("/");
  return parts.map(decodeSegment).map(encodeURIComponent).join("/");
}
function filename(path: string): string {
  const part = path.replace(/\\/g, "/").split("/").pop() || "image";
  try { return decodeURIComponent(part); } catch { return part; }
}
/**
 * One path classification boundary. Do not turn arbitrary paths into kernel API paths.
 * Only box= is accepted on local assets; unknown query transforms require an explicit adapter.
 */
export function resolveSource(raw: string, kernelOrigin: string): ImageSource {
  if (!raw || raw !== raw.trim() || /[\u0000-\u001f]/.test(raw))
    throw new Error("Invalid image source");
  if (/^(?:\.\\)?assets\\/.test(raw)) {
    const resolved = resolveSource(raw.replace(/\\/g, "/"), kernelOrigin);
    return { ...resolved, raw };
  }
  if (/^(?:\.\/*)?assets\//.test(raw) || /^\/assets\//.test(raw)) {
    // Validate before URL normalisation: URL would silently remove ../ segments.
    const pathOnly = raw.split(/[?#]/)[0];
    const canonical = assetPath(pathOnly);
    const u = new URL(raw.replace(/^\.\//, "/").replace(/^assets\//, "/assets/"), kernelOrigin);
    if (u.hash || [...u.searchParams.keys()].some(k => k !== "box") || u.searchParams.getAll("box").length > 1)
      throw new Error("Unsupported asset URL suffix");
    const box = u.searchParams.get("box") || undefined;
    if (box && !ID.test(box)) throw new Error("Invalid asset notebook");
    const suffix = box ? `?box=${box}` : "";
    return { kind: "asset", raw, key: `asset:${canonical}${suffix}`, path: canonical,
      fetchURL: new URL(`/${canonical}${suffix}`, kernelOrigin).href, box, name: filename(pathOnly) };
  }
  if (/^[a-zA-Z]:[\\/]/.test(raw) || /^file:/i.test(raw)
      || /^\\\\/.test(raw) || raw.startsWith("/") && !raw.startsWith("//")) {
    let u: URL;
    if (/^[a-zA-Z]:[\\/]/.test(raw)) {
      const normal = raw.replace(/\\/g, "/");
      u = new URL("file:///" + normal.split("/").map((s, i) => i ? encodeURIComponent(s) : s.toUpperCase()).join("/"));
    } else if (/^\\\\/.test(raw)) {
      const [host, ...parts] = raw.slice(2).split("\\");
      u = new URL(`file://${host}/${parts.map(encodeURIComponent).join("/")}`);
    } else if (raw.startsWith("/")) {
      u = new URL("file://" + raw.split("/").map(encodeURIComponent).join("/"));
    } else {
      const normal = raw.replace(/^file:\/\/([a-zA-Z]:[\\/])/, "file:///$1").replace(/\\/g, "/");
      if (/%(?:2f|5c|00)/i.test(normal)) throw new Error("Encoded file separator refused");
      u = new URL(normal);
    }
    if (u.protocol !== "file:" || u.search || u.hash || u.username || u.password)
      throw new Error("Invalid local file URL");
    if (u.hostname && u.hostname !== "localhost") throw new Error("UNC/network file reads are disabled");
    return { kind: "file", raw, key: `file:${u.href}`, fileURL: u.href, name: filename(u.pathname) };
  }
  const u = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
  if (u.origin === kernelOrigin && u.pathname.startsWith("/assets/")) {
    const v = resolveSource(u.pathname + u.search + u.hash, kernelOrigin);
    return { ...v, raw };
  }
  if (!["https:", "http:"].includes(u.protocol) || u.username || u.password)
    throw new Error("Only HTTP(S) image links are supported");
  // Fragment is retained in the reference identity; the transport never sends it.
  return { kind: "remote", raw, key: `remote:${u.href}`, url: u.href, name: filename(u.pathname) };
}
export function trySource(raw: string, origin: string): ImageSource | undefined {
  try { return resolveSource(raw, origin); } catch { return undefined; }
}
export function outputName(sourceName: string): string {
  const base = sourceName.replace(/\\/g, "/").split("/").pop() || "image";
  const stem = base.replace(/\.[a-zA-Z0-9]{1,10}$/, "")
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").replace(/[. ]+$/, "") || "image";
  // Keep the readable stem. The kernel remains the authority for its resource ID.
  return Array.from(stem).slice(0, 120).join("") + ".webp";
}
export function imageSourceAttribute(image: HTMLImageElement): string | undefined {
  // An existing data-src is authoritative. Do not silently fall back to another image.
  const value = image.hasAttribute("data-src") ? image.getAttribute("data-src") : image.getAttribute("src");
  return value || undefined;
}
```

## 13.7 `download.ts`



```typescript
import { abortIf, deadline } from "./core.js";
import type { ImageSource } from "./source.js";
export interface Downloaded { blob: Blob; name: string }
export interface ReadOptions {
  maxBytes: number; timeoutMs: number; signal?: AbortSignal;
  allowedOrigins: ReadonlySet<string>;
  providedFiles?: ReadonlyMap<string, File>;
}
export interface DesktopBridge {
  readFile(fileURL: string, options: ReadOptions): Promise<Downloaded>;
  download(url: string, options: ReadOptions): Promise<Downloaded>;
}
export function requireRemotePermission(raw: string, origins: ReadonlySet<string>): URL {
  const u = new URL(raw);
  if (!["https:", "http:"].includes(u.protocol) || u.username || u.password || !origins.has(u.origin))
    throw new Error("Remote origin not authorised");
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
      || host.includes(":") || host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host))
    throw new Error("Automatic/direct network reads reject literal and local addresses");
  return u;
}
export async function boundedResponse(response: Response, limit: number, signal?: AbortSignal): Promise<Blob> {
  if (!response.ok || !response.body) throw new Error(`Image download failed: HTTP ${response.status}`);
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > limit) { await response.body.cancel(); throw new Error("Image exceeds byte limit"); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      abortIf(signal);
      const { done, value } = await reader.read();
      abortIf(signal);
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Image exceeds byte limit");
      chunks.push(value);
    }
    if (!size) throw new Error("Empty download");
    return new Blob(chunks, { type: response.headers.get("content-type")?.split(";")[0] || "" });
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { signal?.removeEventListener("abort", cancel); reader.releaseLock(); }
}
export class SourceReader {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly desktop?: DesktopBridge,
  ) {}
  async read(source: ImageSource, options: ReadOptions): Promise<Downloaded> {
    abortIf(options.signal);
    const provided = options.providedFiles?.get(source.key);
    if (provided) {
      if (provided.size > options.maxBytes) throw new Error("Selected file exceeds byte limit");
      return { blob: provided, name: provided.name };
    }
    if (source.kind === "file") {
      if (!this.desktop) throw new Error("This frontend cannot read a computer path; select the image file instead");
      return this.desktop.readFile(source.fileURL, options);
    }
    if (source.kind === "remote") {
      requireRemotePermission(source.url, options.allowedOrigins);
      // Select a transport BEFORE dispatch, never silently try an unapproved proxy.
      if (this.desktop) return this.desktop.download(source.url, options);
    }
    const d = deadline(options.signal, options.timeoutMs);
    try {
      const response = await this.fetcher(source.kind === "asset" ? source.fetchURL : source.url, {
        credentials: source.kind === "asset" ? "same-origin" : "omit",
        referrerPolicy: "no-referrer", redirect: "error", signal: d.signal,
      });
      return { blob: await boundedResponse(response, options.maxBytes, d.signal), name: source.name };
    } finally { d.close(); }
  }
}
```

## 13.8 `desktop.ts`



```typescript
/**
 * Optional desktop-only boundary. Call only after getFrontend()/require capability checks.
 * `any` is confined to Node's dynamically loaded built-ins; no Node imports enter mobile builds.
 * No unlink/write/shell API is exposed.
 */
import { abortIf, deadline } from "./core.js";
import { requireRemotePermission, type DesktopBridge, type Downloaded, type ReadOptions } from "./download.js";
export type NodeRequire = (name: string) => any;
export type LocalConsent = (realPath: string) => Promise<boolean>;
function publicIPv4(address: string): boolean {
  const p = address.split(".").map(Number);
  if (p.length !== 4 || p.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  const [a, b, c] = p;
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || a === 100 && b >= 64 && b <= 127
    || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
    || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99)
    || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
    || a === 203 && b === 0 && c === 113);
}
export function createDesktopBridge(load: NodeRequire, approve: LocalConsent): DesktopBridge {
  const fs = load("node:fs/promises");
  const url = load("node:url");
  const dns = load("node:dns/promises");
  const https = load("node:https");
  const http = load("node:http");

  return {
    async readFile(fileURL: string, options: ReadOptions): Promise<Downloaded> {
      const u = new URL(fileURL);
      if (u.protocol !== "file:" || u.host && u.host !== "localhost" || u.search || u.hash)
        throw new Error("Invalid or network file URL");
      const nativePath: string = url.fileURLToPath(u);
      const real: string = await fs.realpath(nativePath);
      abortIf(options.signal);
      // Per-file consent or an explicitly granted session folder; never infer consent from note text.
      if (!await approve(real)) throw new Error("Local file read not authorised");
      abortIf(options.signal);
      const handle = await fs.open(real, "r");
      const d = deadline(options.signal, options.timeoutMs);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size <= 0 || before.size > options.maxBytes)
          throw new Error("Not a regular file or exceeds byte limit");
        const pieces: Uint8Array[] = [];
        let position = 0;
        while (position < before.size) {
          abortIf(d.signal);
          const buffer = new Uint8Array(Math.min(256 * 1024, before.size - position));
          const result = await handle.read(buffer, 0, buffer.length, position);
          if (!result.bytesRead) throw new Error("Local file shortened while reading");
          position += result.bytesRead;
          pieces.push(buffer.slice(0, result.bytesRead));
        }
        const after = await handle.stat();
        abortIf(d.signal);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino)
          throw new Error("Local file changed while reading");
        return { blob: new Blob(pieces), name: real.replace(/\\/g, "/").split("/").pop() || "image" };
      } finally { d.close(); await handle.close(); }
    },

    async download(raw: string, options: ReadOptions): Promise<Downloaded> {
      const d = deadline(options.signal, options.timeoutMs);
      let current = requireRemotePermission(raw, options.allowedOrigins);
      try {
        for (let redirect = 0; redirect <= 3; redirect++) {
          abortIf(d.signal);
          current = requireRemotePermission(current.href, options.allowedOrigins);
          // Deliberately IPv4-only here. IPv6 support needs a vetted full address-range classifier.
          const addresses: Array<{ address: string; family: number }> = await dns.lookup(current.hostname, { all: true, family: 4 });
          abortIf(d.signal);
          if (!addresses.length || addresses.some(a => !publicIPv4(a.address)))
            throw new Error("Private/special network destination refused");
          const address = addresses[0].address;
          const result = await new Promise<{ bytes?: Uint8Array[]; location?: string; mime?: string }>((resolve, reject) => {
            let settled = false;
            let response: any;
            const cleanup = () => d.signal.removeEventListener("abort", onAbort);
            const finish = (error?: unknown, value?: { bytes?: Uint8Array[]; location?: string; mime?: string }) => {
              if (settled) return;
              settled = true; cleanup();
              if (error) reject(error); else resolve(value!);
            };
            const request = (current.protocol === "https:" ? https : http).request(current, {
              method: "GET", agent: false, family: 4,
              headers: { Accept: "image/*", "Accept-Encoding": "identity" },
              // Connect to the validated IP, preserving the URL hostname for TLS/Host validation.
              lookup: (_hostname: string, opt: any, callback: any) => {
                if (opt?.all) callback(null, [{ address, family: 4 }]);
                else callback(null, address, 4);
              },
            }, (res: any) => {
              response = res;
              const status = res.statusCode ?? 0;
              if ([301, 302, 303, 307, 308].includes(status) && typeof res.headers.location === "string") {
                finish(undefined, { location: res.headers.location }); res.destroy(); return;
              }
              if (status < 200 || status >= 300) {
                finish(new Error(`Remote HTTP ${status}`)); res.destroy(); return;
              }
              if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") {
                finish(new Error("Unexpected compressed transfer")); res.destroy(); return;
              }
              if (Number(res.headers["content-length"]) > options.maxBytes) {
                finish(new Error("Image exceeds byte limit")); res.destroy(); return;
              }
              const chunks: Uint8Array[] = [];
              let size = 0;
              res.on("data", (chunk: Uint8Array) => {
                size += chunk.byteLength;
                if (size > options.maxBytes) {
                  finish(new Error("Image exceeds byte limit")); res.destroy(); request.destroy(); return;
                }
                chunks.push(new Uint8Array(chunk));
              });
              res.on("end", () => size ? finish(undefined, { bytes: chunks, mime: res.headers["content-type"] })
                : finish(new Error("Empty image response")));
              res.on("aborted", () => finish(new Error("Response aborted")));
              res.on("error", (error: unknown) => finish(error));
            });
            const onAbort = () => {
              finish(new DOMException("Cancelled", "AbortError"));
              response?.destroy(); request.destroy();
            };
            d.signal.addEventListener("abort", onAbort, { once: true });
            request.on("error", (error: unknown) => finish(error));
            if (d.signal.aborted) onAbort(); else request.end();
          });
          if (result.location) {
            if (redirect === 3) throw new Error("Too many redirects");
            const next = new URL(result.location, current);
            // Every redirect needs an already-approved origin; never carry authentication.
            if (current.protocol === "https:" && next.protocol !== "https:") throw new Error("TLS downgrade refused");
            current = requireRemotePermission(next.href, options.allowedOrigins);
            continue;
          }
          return { blob: new Blob(result.bytes!, { type: result.mime?.split(";")[0] || "" }),
            name: decodeURIComponent(current.pathname.split("/").pop() || "image") };
        }
        throw new Error("Download did not complete");
      } finally { d.close(); }
    },
  };
}
```

## 13.9 `image.ts`



```typescript
import { abortIf, deadline, MemoryBudget } from "./core.js";
import type { ImageConfig } from "./config.js";
import { outputName } from "./source.js";

export interface ImageInfo { mime: "image/png" | "image/jpeg" | "image/webp"; width: number; height: number; animated: boolean }
const text = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
/** Structural guard, not a replacement for a sandboxed image decoder. */
export function inspectImage(b: Uint8Array): ImageInfo {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  if (png.every((x, i) => b[i] === x)) {
    let p = 8, width = 0, height = 0, animated = false, data = false;
    while (p + 12 <= b.length) {
      const n = v.getUint32(p), tag = text(b, p + 4, 4);
      if (n > b.length - p - 12) throw new Error("Truncated PNG");
      if (!width && tag !== "IHDR") throw new Error("Missing PNG header");
      if (tag === "IHDR") {
        if (width || n !== 13) throw new Error("Invalid PNG header");
        width = v.getUint32(p + 8); height = v.getUint32(p + 12);
        if (!width || !height) throw new Error("Empty PNG dimensions");
      }
      if (["acTL", "fcTL", "fdAT"].includes(tag)) animated = true;
      if (tag === "IDAT" && n > 0) data = true;
      if (tag === "IEND") {
        if (!data || n !== 0 || p + 12 !== b.length) throw new Error("Invalid PNG end");
        return { mime: "image/png", width, height, animated };
      }
      p += n + 12;
    }
    throw new Error("PNG is incomplete");
  }
  if (b.length >= 12 && text(b, 0, 4) === "RIFF" && text(b, 8, 4) === "WEBP") {
    if (v.getUint32(4, true) + 8 !== b.length) throw new Error("WebP length mismatch");
    let p = 12, width = 0, height = 0, animated = false, data = false;
    while (p + 8 <= b.length) {
      const tag = text(b, p, 4), n = v.getUint32(p + 4, true), q = p + 8;
      if (n > b.length - q) throw new Error("Truncated WebP");
      if (tag === "VP8X") {
        if (n !== 10) throw new Error("Invalid WebP extended header");
        animated ||= (b[q] & 2) !== 0;
        width = 1 + b[q + 4] + (b[q + 5] << 8) + (b[q + 6] << 16);
        height = 1 + b[q + 7] + (b[q + 8] << 8) + (b[q + 9] << 16);
      } else if (tag === "VP8 ") {
        if (n < 10 || text(b, q + 3, 3) !== "\x9d\x01\x2a") throw new Error("Invalid WebP frame");
        if (!width) { width = v.getUint16(q + 6, true) & 0x3fff; height = v.getUint16(q + 8, true) & 0x3fff; }
        data = true;
      } else if (tag === "VP8L") {
        if (n < 5 || b[q] !== 0x2f) throw new Error("Invalid lossless WebP frame");
        const bits = v.getUint32(q + 1, true);
        if (!width) { width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
        data = true;
      }
      if (tag === "ANIM" || tag === "ANMF") animated = true;
      p += 8 + n + (n & 1);
    }
    if (p !== b.length || !width || !height || !data && !animated) throw new Error("Invalid WebP");
    return { mime: "image/webp", width, height, animated };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let p = 2, width = 0, height = 0;
    while (p + 1 < b.length) {
      if (b[p++] !== 0xff) throw new Error("Invalid JPEG marker");
      while (b[p] === 0xff) p++;
      const marker = b[p++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (p + 2 > b.length) throw new Error("Truncated JPEG");
      const n = v.getUint16(p);
      if (n < 2 || n > b.length - p) throw new Error("Truncated JPEG segment");
      if (marker === 0xe2 && text(b, p + 2, 4) === "MPF\0") throw new Error("Multi-picture JPEG is protected");
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (n < 8 || b[p + 7] !== 1 && b[p + 7] !== 3) throw new Error("Unsupported JPEG colour components");
        height = v.getUint16(p + 3); width = v.getUint16(p + 5);
      }
      p += n;
    }
    if (!width || !height) throw new Error("Unsupported/incomplete JPEG");
    return { mime: "image/jpeg", width, height, animated: false };
  }
  throw new Error("Unsupported image signature; GIF/SVG/HEIF/AVIF are not converted by this engine");
}
export interface BicOptions {
  fileType: string; initialQuality: number; maxWidthOrHeight: number;
  maxSizeMB: number; maxIteration: number; alwaysKeepResolution: boolean;
  useWebWorker: boolean; libURL: string; signal: AbortSignal; preserveExif: boolean;
  onProgress?: (percentage: number) => void;
}
export type BicFunction = (file: File, options: BicOptions) => Promise<Blob>;
export interface EncodedImage { file: File; originalBytes: number; outputBytes: number; width: number; height: number }
export type EncodeResult = { kind: "encoded"; value: EncodedImage } | { kind: "skipped"; reason: string };
export async function verifyBitmap(blob: Blob, signal?: AbortSignal): Promise<{ width: number; height: number }> {
  abortIf(signal);
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    try { abortIf(signal); return { width: bitmap.width, height: bitmap.height }; }
    finally { bitmap.close(); }
  }
  const objectURL = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      const cleanup = () => { signal?.removeEventListener("abort", cancel); image.onload = null; image.onerror = null; image.src = ""; };
      const cancel = () => { cleanup(); reject(new DOMException("Cancelled", "AbortError")); };
      image.onload = () => { const value = { width: image.naturalWidth, height: image.naturalHeight }; cleanup(); resolve(value); };
      image.onerror = () => { cleanup(); reject(new Error("Image decoder rejected output")); };
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) cancel(); else image.src = objectURL;
    });
  } finally { URL.revokeObjectURL(objectURL); }
}
export class BicEncoder {
  constructor(private readonly bic: BicFunction, private readonly libURL: string,
    private readonly budget: MemoryBudget, private readonly decode = verifyBitmap) {}

  async encode(blob: Blob, name: string, config: ImageConfig, signal?: AbortSignal,
    onProgress?: (n: number) => void): Promise<EncodeResult> {
    abortIf(signal);
    const c = config.compression;
    const ext = name.split(/[?#]/)[0].split(".").pop()?.toLowerCase() ?? "";
    if (/excalidraw|(?:^|[\/\\])drawings?[\/\\._-]/i.test(name) || c.excludedExtensions.includes(ext))
      return { kind: "skipped", reason: "protected-extension" };
    if (blob.size < c.minInputBytes) return { kind: "skipped", reason: "below-minimum-input" };
    if (blob.size > c.maxInputBytes) throw new Error("Input exceeds byte limit");
    const info = inspectImage(new Uint8Array(await blob.arrayBuffer()));
    if (info.animated) return { kind: "skipped", reason: "animation-protected" };
    const declared = blob.type.split(";")[0].toLowerCase();
    if (declared.startsWith("image/") && declared !== info.mime) throw new Error("Image MIME/signature mismatch");
    const expected: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
    if (expected[ext] && expected[ext] !== info.mime) throw new Error("Image extension/signature mismatch");
    if (!Number.isSafeInteger(info.width * info.height) || info.width * info.height > c.maxPixels)
      throw new Error("Decoded pixel limit exceeded");
    const reservation = info.width * info.height * 12 + blob.size * 2;
    return this.budget.run(reservation, signal, async () => {
      const d = deadline(signal, c.maxEncodeMs);
      try {
        const input = new File([blob], name, { type: info.mime });
        const output = await this.bic(input, {
          fileType: "image/webp", initialQuality: c.initialQuality,
          maxWidthOrHeight: c.maxDimension, maxSizeMB: Infinity,
          maxIteration: 3, alwaysKeepResolution: true,
          useWebWorker: true, libURL: this.libURL, signal: d.signal,
          preserveExif: false, onProgress,
        });
        abortIf(d.signal);
        if (output.type !== "image/webp" || !output.size || output.size > c.maxInputBytes)
          throw new Error("Encoder returned an invalid format/size");
        const actual = inspectImage(new Uint8Array(await output.arrayBuffer()));
        if (actual.mime !== "image/webp" || actual.animated) throw new Error("Encoder output signature mismatch");
        const dimensions = await this.decode(output, d.signal);
        if (!dimensions.width || !dimensions.height || dimensions.width !== actual.width || dimensions.height !== actual.height
            || Math.max(dimensions.width, dimensions.height) > c.maxDimension
            || dimensions.width * dimensions.height > info.width * info.height)
          throw new Error("Unexpected output dimensions");
        const saved = blob.size - output.size;
        if (saved < c.minSavingBytes || saved <= 0 || saved / blob.size < c.minSavingRatio)
          return { kind: "skipped", reason: "insufficient-savings" };
        return { kind: "encoded", value: {
          file: new File([output], outputName(name), { type: "image/webp" }),
          originalBytes: blob.size, outputBytes: output.size, ...dimensions,
        } };
      } finally { d.close(); }
    });
  }
}
```

## 13.10 `asset-identity.ts`

旧版资源实体消歧；只读读取工作区目录，不读取任意电脑文件。

```typescript
import { abortIf, isRecord } from "./core.js";
import { NODE_ID } from "./config.js";
import { type Kernel, readData } from "./kernel.js";

interface Entry { name: string; isDir: boolean; isSymlink: boolean }
/**
 * Read-only physical identity preflight for the legacy backend.
 * A literal assets/a.png is NOT sufficient proof that every document uses one physical file.
 * Only ordinary, symlink-free resource directories are accepted.
 */
export async function ordinaryAssetLocations(
  k: Kernel, paths: readonly string[], signal?: AbortSignal,
): Promise<Record<string, string>> {
  if (!paths.length) return {};
  const books = await readData<unknown>(k, "/api/notebook/lsNotebooks", {}, signal);
  if (!isRecord(books) || !Array.isArray(books.notebooks)) throw new Error("Notebook inventory unavailable");
  const ids = new Set<string>();
  for (const b of books.notebooks) {
    if (!isRecord(b) || typeof b.id !== "string" || !NODE_ID.test(b.id) || b.closed === true || b.encrypted === true)
      throw new Error("Only open ordinary notebooks support legacy resource identity checks");
    ids.add(b.id);
  }
  const cache = new Map<string, Entry[]>();
  async function list(path: string): Promise<Entry[]> {
    abortIf(signal);
    if (cache.has(path)) return cache.get(path)!;
    if (cache.size >= 5000) throw new Error("Resource directory scan limit reached");
    const rows = await readData<unknown>(k, "/api/file/readDir", { path }, signal);
    if (!Array.isArray(rows)) throw new Error("Directory response unavailable");
    const entries: Entry[] = [];
    for (const r of rows) {
      if (!isRecord(r) || typeof r.name !== "string" || !r.name || r.name === "." || r.name === ".."
          || /[\/\\\u0000-\u001f]/.test(r.name) || typeof r.isDir !== "boolean"
          || typeof r.isSymlink !== "boolean") throw new Error("Directory entry cannot be verified");
      entries.push(r as unknown as Entry);
    }
    cache.set(path, entries); return entries;
  }
  const roots: string[] = [], data = await list("/data");
  const global = data.find(e => e.name === "assets");
  if (global) {
    if (!global.isDir || global.isSymlink) throw new Error("Global resource directory is not ordinary");
    roots.push("/data/assets");
  }
  const pending: string[] = [];
  for (const e of data) if (NODE_ID.test(e.name) && e.isDir) {
    if (!ids.has(e.name) || e.isSymlink) throw new Error("Unaccounted or symlinked notebook directory");
    pending.push(`/data/${e.name}`);
  }
  for (let i = 0; i < pending.length; i++) {
    const path = pending[i];
    for (const e of await list(path)) {
      if (!e.isDir) continue;
      if (e.name === "assets") {
        if (e.isSymlink) throw new Error("Symlinked resource directory is unsupported");
        roots.push(`${path}/assets`);
      } else if (NODE_ID.test(e.name)) {
        if (e.isSymlink) throw new Error("Symlinked document directory is unsupported");
        pending.push(`${path}/${e.name}`);
      }
    }
  }
  const result: Record<string, string> = {};
  for (const raw of new Set(paths)) {
    if (!raw.startsWith("assets/") || /[?#\\]/.test(raw)) throw new Error("Nonordinary resource identity");
    const parts = raw.slice(7).split("/").map(part => {
      const p = decodeURIComponent(part);
      if (!p || p === "." || p === ".." || /[\/\\\u0000-\u001f]/.test(p)) throw new Error("Invalid resource segment");
      return p;
    });
    const found: string[] = [];
    for (const root of roots) {
      let folder = root, exists = true;
      for (let i = 0; i < parts.length; i++) {
        const matches = (await list(folder)).filter(e => e.name.toLowerCase() === parts[i].toLowerCase());
        if (!matches.length) { exists = false; break; }
        if (matches.length !== 1 || matches[0].name !== parts[i] || matches[0].isSymlink)
          throw new Error("Resource has case/symlink ambiguity");
        const entry = matches[0], last = i === parts.length - 1;
        if (entry.isDir === last) throw new Error("Resource file/directory shape mismatch");
        folder += `/${entry.name}`;
      }
      if (exists) found.push(folder);
    }
    if (found.length !== 1) throw new Error("Resource missing or ambiguous across physical directories");
    result[raw] = found[0];
  }
  return result;
}
```

## 13.11 `assets.ts`



```typescript
import { abortIf, isRecord } from "./core.js";
import { type Kernel, RequestError, readData } from "./kernel.js";
import { resolveSource, type ImageSource } from "./source.js";
import { type ImageConfig, type Intent, retainOriginal, NODE_ID } from "./config.js";
import { type ReferenceResult, parseNative, nativeCovered } from "./references.js";

export async function digest(blob: Blob): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, "0")).join("");
}
export class AssetStore {
  constructor(private readonly k: Kernel, private readonly origin: string) {}
  async upload(file: File, rootID: string, signal?: AbortSignal): Promise<string> {
    if (!NODE_ID.test(rootID)) throw new Error("Invalid upload document");
    abortIf(signal);
    const form = new FormData();
    form.append("file[]", file, file.name);
    form.append("id", rootID);
    const reply = await this.k.post("/api/asset/upload", form, "write", signal, 60_000);
    const data = reply.data;
    if (reply.code !== 0 || !isRecord(data))
      throw new RequestError("Upload not confirmed", "unknown-write", undefined, reply);
    if (Array.isArray(data.failedFiles) && data.failedFiles.length || Array.isArray(data.errFiles) && data.errFiles.length)
      throw new RequestError("Upload failed or partial", "unknown-write", undefined, reply);
    let path: unknown;
    if (Array.isArray(data.succFiles)) {
      if (data.succFiles.length !== 1 || !isRecord(data.succFiles[0]) || data.succFiles[0].index !== 0)
        throw new RequestError("Unexpected upload mapping", "unknown-write", undefined, reply);
      path = data.succFiles[0].path;
    } else if (isRecord(data.succMap)) {
      // Legacy single-file upload only. Never use Object.values()[0] for a multi-file request.
      const entries = Object.entries(data.succMap);
      if (entries.length === 1 && entries[0][0] === file.name) path = entries[0][1];
    }
    if (typeof path !== "string") throw new RequestError("Upload returned no reliable path", "unknown-write", undefined, reply);
    const source = resolveSource(path, this.origin);
    if (source.kind !== "asset") throw new RequestError("Upload returned a non-asset path", "unknown-write", undefined, reply);
    return path;
  }

  /** Archive + kernel-visible pin. A plugin-private JSON list alone is NOT an asset reference. */
  async archive(file: File, rootID: string, signal?: AbortSignal): Promise<string> {
    const path = await this.upload(file, rootID, signal);
    const attr = `custom-data-assets-omnikit-${crypto.randomUUID().replace(/-/g, "")}`;
    const reply = await this.k.post("/api/attr/setBlockAttrs", { id: rootID, attrs: { [attr]: path } }, "write", signal);
    if (reply.code !== 0) throw new RequestError("Original archive pin not confirmed", "unknown-write", undefined, reply);
    const attrs = await readData<unknown>(this.k, "/api/attr/getBlockAttrs", { id: rootID }, signal);
    if (!isRecord(attrs) || attrs[attr] !== path) throw new Error("Original archive pin could not be verified");
    return path;
  }
}
export interface CleanupResult {
  status: "retained" | "removed-from-live-assets" | "unknown";
  reason: string;
}
const REVIEWED_CLEANUP_VERSIONS = new Set(["3.8.9"]);

/**
 * Separate capability: DO NOT inject this class into document/batch runners.
 * Version profiles are expanded only after source audit and integration tests.
 */
export class SingleOriginalFinalizer {
  constructor(private readonly k: Kernel, private readonly hostVersion: string) {}
  async finish(
    intent: Intent, config: ImageConfig, source: ImageSource, replacement: string,
    result: ReferenceResult, verifyOriginalUnchanged: () => Promise<boolean>,
    signal?: AbortSignal,
  ): Promise<CleanupResult> {
    const keep = (reason: string): CleanupResult => ({ status: "retained", reason });
    if (intent.kind !== "manual-single") return keep("not-manual-single");
    if (retainOriginal(intent, config)) return keep("retention-setting");
    if (source.kind !== "asset" || source.box) return keep("external-or-encrypted-source");
    if (source.raw === replacement) return keep("same-path");
    if (result.backend !== "native" || result.state !== "verified" || !result.cleanupEligible)
      return keep("reference-coverage-insufficient");
    if (!REVIEWED_CLEANUP_VERSIONS.has(this.hostVersion)) return keep("cleanup-contract-not-reviewed");
    abortIf(signal);
    if (!await verifyOriginalUnchanged()) return keep("original-content-changed");
    const found = await this.k.post("/api/asset/findAssetReferences", { paths: [source.path] }, "read", signal, 120_000);
    const data = parseNative(found.data);
    if (data.items.length !== 1 || data.items[0].oldPath !== source.path || data.items[0].newPath !== "" || !data.dryRun
        || !nativeCovered(found, data) || data.references.length || data.items.some(i => i.references.length))
      return keep("references-remain");
    const unused = await readData<unknown>(this.k, "/api/asset/getUnusedAssets", {}, signal);
    if (!Array.isArray(unused)) return keep("unused-list-unavailable");
    const decoded = decodeURIComponent(source.path);
    const candidates = unused.filter(v => {
      if (!isRecord(v) || typeof v.item !== "string") return false;
      const parts = v.item.split("/");
      const at = parts.indexOf("assets");
      if (at < 0 || parts.some(p => !p || p === "." || p === ".." || p.includes("\\"))
          || parts.slice(0, at).some(p => !NODE_ID.test(p))) return false;
      return parts.slice(at).join("/") === decoded;
    }) as Array<{ item: string }>;
    if (candidates.length !== 1) return keep("unused-physical-path-ambiguous");
    // Use the DATA-relative path issued by the kernel, not a guessed /data/assets prefix.
    abortIf(signal);
    try {
      const removed = await this.k.post("/api/asset/removeUnusedAsset", { path: candidates[0].item }, "write", signal, 120_000);
      if (removed.code !== 0 || !isRecord(removed.data) || typeof removed.data.path !== "string" || !removed.data.path)
        return { status: "unknown", reason: "cleanup-not-confirmed" };
      return { status: "removed-from-live-assets", reason: "kernel-history-retained; physical disk savings not asserted" };
    } catch {
      return { status: "unknown", reason: "cleanup-result-unknown; do-not-resend" };
    }
  }
}
```

## 13.12 `dom.ts`



```typescript
import { imageSourceAttribute, trySource } from "./source.js";
export interface Ref {
  blockID: string; raw: string; key: string;
  kind: "image" | "link"; attribute: string; element: Element;
}
export interface Mapping {
  key: string; oldPath: string; newPath: string;
  selection?: { blockID: string; expectedCount: number; imageIndices: number[] };
}
export interface BlockPatch {
  id: string; rootID: string; notebook: string;
  before: string; after: string; changes: number;
  oldKeys: string[]; expectedOldCounts: Record<string, number>; expectedNewCounts: Record<string, number>;
}
function template(dom: string): HTMLTemplateElement {
  if (!dom.trim()) throw new Error("Empty block DOM");
  const t = document.createElement("template");
  t.innerHTML = dom; // Inert, disconnected; no live editor DOM is changed.
  return t;
}
function refsIn(root: ParentNode, origin: string): Ref[] {
  const result: Ref[] = [];
  for (const element of root.querySelectorAll("img, a[href], span[data-href]")) {
    if (element.closest("pre, code, script, style, [data-type='NodeCodeBlock'], [data-type='NodeBlockQueryEmbed']")) continue;
    let raw: string | undefined, attribute: string, kind: Ref["kind"];
    if (element.tagName === "IMG") {
      raw = imageSourceAttribute(element as HTMLImageElement);
      attribute = element.hasAttribute("data-src") ? "data-src" : "src"; kind = "image";
    } else {
      if (element.tagName === "SPAN" && !element.getAttribute("data-type")?.split(/\s+/).includes("a")) continue;
      attribute = element.tagName === "A" ? "href" : "data-href";
      raw = element.getAttribute(attribute) || undefined; kind = "link";
    }
    if (!raw) continue;
    const source = trySource(raw, origin);
    if (!source) continue;
    const blockID = element.closest("[data-node-id]")?.getAttribute("data-node-id");
    if (!blockID) throw new Error("Reference has no owning block");
    result.push({ blockID, raw, key: source.key, kind, attribute, element });
  }
  return result;
}
export function scanDOM(dom: string, origin: string): Omit<Ref, "element">[] {
  return refsIn(template(dom).content, origin).map(({ element: _e, ...ref }) => ref);
}
export function buildBlockPatch(
  dom: string, id: string, rootID: string, notebook: string,
  mappings: readonly Mapping[], origin: string,
): BlockPatch | undefined {
  const t = template(dom);
  const roots = [...t.content.querySelectorAll("[data-node-id]")].filter(e => e.getAttribute("data-node-id") === id);
  if (roots.length !== 1) throw new Error("Block DOM identity mismatch");
  const block = roots[0];
  // Do not submit a parent snapshot containing child blocks: update each owner separately.
  if (block.querySelector("[data-node-id]")) throw new Error("Container block mutation refused");
  const list = refsIn(t.content, origin).filter(r => r.blockID === id);
  const byKey = new Map(mappings.map(m => [m.key, m]));
  for (const mapping of mappings) {
    if (!mapping.selection) continue;
    const selected = mapping.selection;
    const images = list.filter(r => r.kind === "image" && r.key === mapping.key);
    if (selected.blockID !== id || images.length !== selected.expectedCount
        || new Set(selected.imageIndices).size !== selected.imageIndices.length
        || selected.imageIndices.some(i => !Number.isSafeInteger(i) || i < 0 || i >= images.length))
      throw new Error("Selected image occurrences changed");
  }
  let changes = 0;
  const oldKeys = new Set<string>();
  for (const ref of list) {
    const mapping = byKey.get(ref.key);
    if (!mapping) continue;
    if (mapping.selection) {
      const imageIndex = list.filter(r => r.kind === "image" && r.key === ref.key).indexOf(ref);
      if (ref.kind !== "image" || !mapping.selection.imageIndices.includes(imageIndex)) continue;
    }
    const target = trySource(mapping.newPath, origin);
    if (!target || target.kind !== "asset") throw new Error("Replacement must be a local asset");
    ref.element.setAttribute(ref.attribute, mapping.newPath);
    // Keep a separate thumbnail untouched; update src only when it denotes the SAME source.
    if (ref.kind === "image" && ref.attribute === "data-src") {
      const src = ref.element.getAttribute("src");
      if (src && trySource(src, origin)?.key === ref.key) ref.element.setAttribute("src", mapping.newPath);
    }
    changes++; oldKeys.add(ref.key);
  }
  if (!changes) return undefined;
  const after = t.innerHTML;
  const expectedNewCounts: Record<string, number> = {};
  for (const mapping of mappings) {
    const key = trySource(mapping.newPath, origin)?.key;
    if (key) expectedNewCounts[key] = scanDOM(after, origin).filter(r => r.blockID === id && r.key === key).length;
  }
  const expectedOldCounts: Record<string, number> = {};
  for (const key of oldKeys) expectedOldCounts[key] = scanDOM(after, origin).filter(r => r.blockID === id && r.key === key).length;
  return { id, rootID, notebook, before: dom, after, changes, oldKeys: [...oldKeys], expectedOldCounts, expectedNewCounts };
}
export function patchWasApplied(dom: string, patch: BlockPatch, origin: string): boolean {
  const refs = scanDOM(dom, origin).filter(r => r.blockID === patch.id);
  return patch.oldKeys.every(key => refs.filter(r => r.key === key).length === patch.expectedOldCounts[key])
    && Object.entries(patch.expectedNewCounts).every(([key, n]) => refs.filter(r => r.key === key).length === n);
}
```

## 13.13 `references.ts`

实际包含 native 计划、SQL 分页/DOM 计划、聚合写入与后验检查。

```typescript
import { abortIf, isRecord, KeyedMutex } from "./core.js";
import { NODE_ID } from "./config.js";
import { ordinaryAssetLocations } from "./asset-identity.js";
import { type Envelope, type Kernel, RequestError, readData, unsupportedRead } from "./kernel.js";
import { buildBlockPatch, patchWasApplied, scanDOM, type Mapping, type BlockPatch } from "./dom.js";

export interface NativeRef { type: string; blockID: string; rootID: string; relinkable: boolean; reason: string }
export interface NativeItem { oldPath: string; newPath: string; ok: boolean; reason: string; updated: number; references: NativeRef[] }
export interface NativeData {
  items: NativeItem[]; references: NativeRef[]; skippedNotebooks: string[];
  unavailableAttributeViews?: unknown[]; dryRun: boolean; historyPath: string; updated: number;
}
export function parseNative(raw: unknown): NativeData {
  if (!isRecord(raw) || !Array.isArray(raw.items) || !Array.isArray(raw.references)
      || !Array.isArray(raw.skippedNotebooks) || raw.skippedNotebooks.some(x => typeof x !== "string")
      || raw.unavailableAttributeViews !== undefined && !Array.isArray(raw.unavailableAttributeViews)
      || typeof raw.dryRun !== "boolean" || typeof raw.historyPath !== "string"
      || !Number.isSafeInteger(raw.updated) || (raw.updated as number) < 0)
    throw new Error("Unsupported native response schema");
  const ref = (v: unknown): NativeRef => {
    if (!isRecord(v) || typeof v.type !== "string" || typeof v.blockID !== "string"
        || typeof v.rootID !== "string" || typeof v.relinkable !== "boolean" || typeof v.reason !== "string")
      throw new Error("Invalid native reference");
    return v as unknown as NativeRef;
  };
  const items = raw.items.map(v => {
    if (!isRecord(v) || typeof v.oldPath !== "string" || typeof v.newPath !== "string"
        || typeof v.ok !== "boolean" || typeof v.reason !== "string" || !Array.isArray(v.references)
        || !Number.isSafeInteger(v.updated) || (v.updated as number) < 0) throw new Error("Invalid native item");
    return { ...v, references: v.references.map(ref) } as unknown as NativeItem;
  });
  return { ...raw, items, references: raw.references.map(ref) } as unknown as NativeData;
}
export function nativeCovered(r: Envelope, data: NativeData): boolean {
  return r.code === 0 && data.items.every(i => i.ok && !i.reason && i.references.every(r => r.relinkable))
    && data.references.every(r => r.relinkable) && !data.skippedNotebooks.length
    && !(data.unavailableAttributeViews?.length);
}
function matchNative(data: NativeData, mappings: readonly Mapping[], dryRun: boolean, lookup = false): void {
  if (data.dryRun !== dryRun || data.items.length !== mappings.length) throw new Error("Native response mismatch");
  const found = new Map(data.items.map(i => [i.oldPath, i]));
  if (found.size !== mappings.length) throw new Error("Duplicate native result");
  for (const mapping of mappings) {
    const item = found.get(mapping.oldPath);
    if (!item || item.newPath !== (lookup ? "" : mapping.newPath)) throw new Error("Native mapping mismatch");
  }
}
export interface DocumentRow { id: string; root_id: string; box: string }
export function sqlLiteral(value: string): string {
  if (value.includes("\0")) throw new Error("NUL is not allowed in SQL literals");
  return `'${value.replace(/'/g, "''")}'`;
}
/** Keyset pagination: a short page is NOT proof of completion because host search limits may truncate it. */
export async function scanIndexedDocuments(k: Kernel, max: number, signal?: AbortSignal): Promise<DocumentRow[]> {
  const result: DocumentRow[] = [];
  let cursor = "";
  for (;;) {
    abortIf(signal);
    const stmt = `SELECT id, root_id, box FROM blocks WHERE type = 'd' AND id > ${sqlLiteral(cursor)} ORDER BY id ASC LIMIT 64`;
    const rows = await readData<unknown>(k, "/api/query/sql", { stmt, mode: "readonly" }, signal);
    if (!Array.isArray(rows)) throw new Error("SQL did not return rows");
    if (!rows.length) return result;
    for (const r of rows) {
      if (!isRecord(r) || typeof r.id !== "string" || !NODE_ID.test(r.id) || r.id <= cursor
          || r.root_id !== r.id || typeof r.box !== "string" || !NODE_ID.test(r.box))
        throw new Error("Invalid or unordered SQL document row");
      cursor = r.id;
      result.push(r as unknown as DocumentRow);
      if (result.length > max) throw new Error("Document scan limit exceeded; no references were changed");
    }
  }
}
export async function blockDOM(k: Kernel, id: string, notebook: string, signal?: AbortSignal): Promise<string> {
  if (!NODE_ID.test(id) || notebook && !NODE_ID.test(notebook)) throw new Error("Invalid block identity");
  const r = await readData<unknown>(k, "/api/block/getBlockDOM", { id, ...(notebook ? { notebook } : {}) }, signal);
  if (!isRecord(r) || r.id !== undefined && r.id !== id || typeof r.dom !== "string" || !r.dom.trim())
    throw new Error("Invalid block DOM response");
  return r.dom;
}
export type ReferencePlan =
  | { backend: "native"; mappings: Mapping[]; preview: NativeData; rootIDs: string[] }
  | { backend: "sql"; mappings: Mapping[]; patches: BlockPatch[]; rootIDs: string[];
      documents: DocumentRow[]; coverage: "indexed-blocks"; selectedOnly: boolean;
      assetLocations: Record<string, string> };
export interface ReferenceResult {
  backend: "native" | "sql"; state: "verified" | "partial" | "unknown";
  referencesChanged: number | null; storageRecordsChanged: number | null;
  verifiedBlocks: string[]; conflictBlocks: string[]; historyPath?: string;
  cleanupEligible: boolean; reason?: string;
}
export interface ReferenceJournal {
  beforeCommit(plan: ReferencePlan): Promise<void>;
  blockState(id: string, state: "sent" | "verified" | "conflict" | "unknown"): Promise<void>;
}
export class ReferenceService {
  // Share ONE instance per feature. All reference writers, including auto URL actions, use it.
  private readonly writer = new KeyedMutex();
  constructor(private readonly k: Kernel, private readonly origin: string) {}

  async plan(
    mappings: Mapping[], seed: DocumentRow, maxDocuments: number,
    forceSQL = false, selectedBlockID: string | undefined = undefined, signal?: AbortSignal,
  ): Promise<ReferencePlan> {
    if (!mappings.length || new Set(mappings.map(m => m.key)).size !== mappings.length)
      throw new Error("Empty/duplicate mappings");
    const selectedOnly = Boolean(selectedBlockID);
    if (selectedBlockID && !NODE_ID.test(selectedBlockID)) throw new Error("Invalid selected block");
    const nativePossible = !forceSQL && !selectedOnly
      && mappings.every(m => m.key.startsWith("asset:") && !m.key.includes("?") && m.oldPath.startsWith("assets/"));
    if (nativePossible) {
      try {
        const lookup = await this.k.post("/api/asset/findAssetReferences", { paths: mappings.map(m => m.oldPath) }, "read", signal, 120_000);
        if (lookup.code !== 0) throw new Error(`Native reference scan refused: ${lookup.msg}`);
        const found = parseNative(lookup.data);
        matchNative(found, mappings, true, true);
        const reply = await this.k.post("/api/asset/relinkAsset",
          { mappings: mappings.map(({ oldPath, newPath }) => ({ oldPath, newPath })), dryRun: true }, "read", signal, 120_000);
        const data = parseNative(reply.data);
        matchNative(data, mappings, true);
        if (!nativeCovered(reply, data)) throw new Error("Native preflight reports unsupported/incomplete references");
        return { backend: "native", mappings, preview: data,
          rootIDs: [...new Set(data.references.map(r => r.rootID).filter(Boolean))] };
      } catch (error) {
        // ONLY definitive endpoint absence in a read/dry-run can select SQL.
        // Permissions, partial results, schema corruption and timeouts do not silently downgrade.
        if (!unsupportedRead(error)) throw error;
      }
    }
    if (!selectedOnly) {
      const data = await readData<unknown>(this.k, "/api/notebook/lsNotebooks", {}, signal);
      if (!isRecord(data) || !Array.isArray(data.notebooks)) throw new Error("Cannot verify notebook scope");
      if (data.notebooks.some(n => !isRecord(n) || n.closed === true || n.encrypted === true))
        throw new Error("SQL scope is incomplete: open ordinary notebooks; encrypted notebooks need a separate adapter");
    }
    const assetPaths = mappings.flatMap(m => [m.oldPath, m.newPath]).filter(p => p.startsWith("assets/"));
    // External-source tasks need the new asset identity too; encrypted assets are not guessed.
    const assetLocations = await ordinaryAssetLocations(this.k, assetPaths, signal);
    const documents = selectedOnly ? [seed] : await scanIndexedDocuments(this.k, maxDocuments, signal);
    if (!documents.some(d => d.id === seed.id)) documents.push(seed);
    const keys = new Set(mappings.map(m => m.key));
    const patches: BlockPatch[] = [];
    let bytes = 0;
    for (const doc of documents) {
      abortIf(signal);
      const dom = await blockDOM(this.k, doc.id, doc.box, signal);
      const owners = new Set(scanDOM(dom, this.origin).filter(r => keys.has(r.key) && (!selectedBlockID || r.blockID === selectedBlockID)).map(r => r.blockID));
      for (const id of owners) {
        const before = await blockDOM(this.k, id, doc.box, signal);
        const patch = buildBlockPatch(before, id, doc.id, doc.box, mappings, this.origin);
        if (patch) {
          bytes += (patch.before.length + patch.after.length) * 2;
          if (bytes > 16 * 1024 * 1024) throw new Error("Reference plan is too large; no writes performed");
          patches.push(patch);
        }
      }
    }
    if (!patches.length) throw new Error("No persisted target references found");
    return { backend: "sql", mappings, patches, documents, assetLocations, coverage: "indexed-blocks",
      rootIDs: [...new Set(patches.map(p => p.rootID))], selectedOnly };
  }

  withWriteLease<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    return this.writer.run("all-image-reference-writes", signal, operation);
  }

  async commit(plan: ReferencePlan, journal: ReferenceJournal, signal?: AbortSignal): Promise<ReferenceResult> {
    return this.withWriteLease(signal, async () => {
      abortIf(signal);
      await journal.beforeCommit(plan); // Immutable before/after plan must be durable before writing.
      abortIf(signal);
      if (plan.backend === "native") {
        try {
          const r = await this.k.post("/api/asset/relinkAsset", {
            mappings: plan.mappings.map(({ oldPath, newPath }) => ({ oldPath, newPath })), dryRun: false,
          }, "write", signal, 120_000);
          const data = parseNative(r.data);
          matchNative(data, plan.mappings, false);
          if (!nativeCovered(r, data)) return { backend: "native", state: "partial",
            referencesChanged: null, storageRecordsChanged: data.updated, verifiedBlocks: [], conflictBlocks: [],
            historyPath: data.historyPath, cleanupEligible: false, reason: r.msg || "partial native result" };
          const check = await this.k.post("/api/asset/findAssetReferences",
            { paths: plan.mappings.map(m => m.oldPath) }, "read", signal, 120_000);
          const after = parseNative(check.data);
          matchNative(after, plan.mappings, true, true);
          const verified = nativeCovered(check, after) && after.references.length === 0
            && after.items.every(i => i.references.length === 0);
          return { backend: "native", state: verified ? "verified" : "partial",
            referencesChanged: null, storageRecordsChanged: data.updated,
            verifiedBlocks: [...new Set(data.references.map(r => r.blockID).filter(Boolean))], conflictBlocks: [],
            historyPath: data.historyPath, cleanupEligible: verified };
        } catch (error) {
          // NO SQL fallback, NO resend, even if the WRITE received 404/timeout/invalid JSON.
          return { backend: "native", state: "unknown", referencesChanged: null, storageRecordsChanged: null,
            verifiedBlocks: [], conflictBlocks: [], cleanupEligible: false, reason: String(error) };
        }
      }
      const currentLocations = await ordinaryAssetLocations(this.k, Object.keys(plan.assetLocations), signal);
      if (Object.entries(plan.assetLocations).some(([p, location]) => currentLocations[p] !== location))
        throw new Error("Resource locations changed after preview");
      const verifiedBlocks: string[] = [], conflictBlocks: string[] = [];
      let count = 0;
      for (const patch of plan.patches) {
        if (signal?.aborted) return { backend: "sql", state: "partial", referencesChanged: count,
          storageRecordsChanged: verifiedBlocks.length, verifiedBlocks, conflictBlocks, cleanupEligible: false, reason: "cancelled-after-partial-work" };
        const current = await blockDOM(this.k, patch.id, patch.notebook, signal);
        if (current !== patch.before) {
          conflictBlocks.push(patch.id); await journal.blockState(patch.id, "conflict"); continue;
        }
        await journal.blockState(patch.id, "sent");
        abortIf(signal);
        if (await blockDOM(this.k, patch.id, patch.notebook, signal) !== patch.before) {
          conflictBlocks.push(patch.id); await journal.blockState(patch.id, "conflict"); continue;
        }
        abortIf(signal);
        try {
          const result = await this.k.post("/api/block/updateBlock",
            { id: patch.id, dataType: "dom", data: patch.after, lockType: true }, "write", signal);
          if (result.code !== 0) throw new RequestError("Block write not confirmed", "unknown-write", undefined, result);
          const latest = await blockDOM(this.k, patch.id, patch.notebook, signal);
          if (!patchWasApplied(latest, patch, this.origin)) throw new Error("Block verification did not match");
          verifiedBlocks.push(patch.id); count += patch.changes;
          await journal.blockState(patch.id, "verified");
        } catch (error) {
          await journal.blockState(patch.id, "unknown");
          return { backend: "sql", state: "unknown", referencesChanged: count,
            storageRecordsChanged: verifiedBlocks.length, verifiedBlocks, conflictBlocks,
            cleanupEligible: false, reason: String(error) };
        }
      }
      // A second full indexed scan catches newly introduced old links. It is not server-side CAS.
      if (plan.selectedOnly) {
        let verified = !conflictBlocks.length;
        for (const patch of plan.patches)
          verified &&= patchWasApplied(await blockDOM(this.k, patch.id, patch.notebook, signal), patch, this.origin);
        return { backend: "sql", state: verified ? "verified" : "partial",
          referencesChanged: count, storageRecordsChanged: verifiedBlocks.length,
          verifiedBlocks, conflictBlocks, cleanupEligible: false, reason: "Selected block only" };
      }
      const after = await scanIndexedDocuments(this.k, 100_000, signal);
      const keys = new Set(plan.mappings.map(m => m.key));
      let remaining = false;
      for (const doc of after) {
        if (scanDOM(await blockDOM(this.k, doc.id, doc.box, signal), this.origin).some(r => keys.has(r.key))) remaining = true;
      }
      const inventoryStable = plan.selectedOnly
        || [...after].map(d => d.id).sort().join() === [...plan.documents].map(d => d.id).sort().join();
      return { backend: "sql", state: !remaining && !conflictBlocks.length && inventoryStable ? "verified" : "partial",
        referencesChanged: count, storageRecordsChanged: verifiedBlocks.length,
        verifiedBlocks, conflictBlocks, cleanupEligible: false,
        reason: "SQL verification covers indexed ordinary block references only; originals are retained" };
    });
  }
}
```

## 13.14 `jobs.ts`

任务编排故意没有清理依赖。日志索引/恢复入口接入现有 TaskRegistry，禁止重启自动续写。

```typescript
import { abortIf, clone, deadline, isRecord, mapLimited } from "./core.js";
import { retainOriginal, type ImageConfig, type Intent } from "./config.js";
import { resolveSource, type ImageSource } from "./source.js";
import { SourceReader, type ReadOptions } from "./download.js";
import { AssetStore, digest } from "./assets.js";
import { BicEncoder } from "./image.js";
import { type ReferenceJournal, type ReferencePlan, type ReferenceResult, ReferenceService, type DocumentRow } from "./references.js";
import { RequestError } from "./kernel.js";
import type { Mapping } from "./dom.js";

export interface PluginData {
  saveData(name: string, data: unknown): Promise<unknown>;
}
export interface JobState {
  id: string; phase: "preparing" | "preview" | "applying" | "done" | "partial" | "cancelled" | "failed" | "unknown";
  total: number; completed: number; uploaded: number; skipped: number; failed: number;
  blocks: Record<string, string>; messages: string[];
  referenceResult?: ReferenceResult;
}
export class JobJournal implements ReferenceJournal {
  private tail: Promise<void> = Promise.resolve();
  private uncertain = false;
  constructor(private readonly io: PluginData, readonly state: JobState,
    private readonly notify: (state: Readonly<JobState>) => void = () => undefined) {}
  private async write(name: string, data: unknown): Promise<void> {
    if (this.uncertain) throw new Error("Journal write is uncertain; stop this job");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = new Error("Journal write timeout");
    try {
      const response = await Promise.race([
        this.io.saveData(name, clone(data)),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(timeoutError), 30_000); }),
      ]);
      if (isRecord(response) && "code" in response && response.code !== 0) throw new Error("Journal save refused");
    } catch (error) {
      if (error === timeoutError) this.uncertain = true;
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  }
  async checkpoint(): Promise<void> {
    const snapshot = clone(this.state);
    this.tail = this.tail.then(() => this.write(`feature-image-compressor.job-${this.state.id}.json`, snapshot));
    await this.tail;
    this.notify(snapshot);
  }
  async beforeCommit(plan: ReferencePlan): Promise<void> {
    await this.tail;
    await this.write(`feature-image-compressor.job-${this.state.id}.plan.json`, plan);
    this.state.phase = "applying";
    await this.checkpoint();
  }
  async blockState(id: string, state: "sent" | "verified" | "conflict" | "unknown"): Promise<void> {
    this.state.blocks[id] = state;
    await this.checkpoint();
  }
}
export interface Prepared {
  source: ImageSource; path: string; originalHash: string;
  originalBytes: number; outputBytes: number;
}
export interface JobOutput {
  state: JobState; prepared: Prepared[]; referenceResult?: ReferenceResult;
}
export interface RunJob {
  intent: Intent; document: DocumentRow; sources: ImageSource[];
  config: ImageConfig; mobile: boolean; signal?: AbortSignal;
  allowedOrigins: ReadonlySet<string>;
  selection?: { expectedCount: number; imageIndices: number[] };
  providedFiles?: ReadonlyMap<string, File>;
  onState?: (state: Readonly<JobState>) => void;
  confirm(plan: ReferencePlan): Promise<boolean>;
}

/** No deletion dependency or method is available to this runner. */
export class ImageJobRunner {
  constructor(
    private readonly reader: SourceReader, private readonly encoder: BicEncoder,
    private readonly assets: AssetStore, private readonly references: ReferenceService,
    private readonly io: PluginData,
    private readonly origin: string,
    private readonly notify: (state: Readonly<JobState>) => void = () => undefined,
  ) {}

  async run(input: RunJob): Promise<JobOutput> {
    // Freeze the intent/config for this job. A settings change never upgrades a document job to deletion.
    const intent = Object.freeze(clone(input.intent));
    const config = clone(input.config);
    if (input.mobile) {
      config.compression.maxPixels = Math.min(config.compression.maxPixels, 12_000_000);
      config.compression.maxInputBytes = Math.min(config.compression.maxInputBytes, 16 * 1024 * 1024);
    }
    const sources = [...new Map(input.sources.map(s => [s.key, s])).values()];
    const state: JobState = { id: crypto.randomUUID(), phase: "preparing", total: sources.length,
      completed: 0, uploaded: 0, skipped: 0, failed: 0, blocks: {}, messages: [] };
    const notify = input.onState ?? this.notify;
    const journal = new JobJournal(this.io, state, notify);
    const prepared: Prepared[] = [];
    const options: ReadOptions = { maxBytes: config.compression.maxInputBytes,
      timeoutMs: 30_000, signal: input.signal, allowedOrigins: input.allowedOrigins, providedFiles: input.providedFiles };
    let writing = false, unknownUpload = false;
    try {
      await journal.checkpoint();
      const limit = input.mobile ? config.compression.concurrencyMobile : config.compression.concurrencyDesktop;
      await mapLimited(sources, limit, input.signal, async source => {
        try {
          abortIf(input.signal);
          const original = await this.reader.read(source, options);
          const originalHash = await digest(original.blob);
          const compressed = await this.encoder.encode(original.blob, original.name, config, input.signal);
          if (compressed.kind === "skipped") { state.skipped++; return; }
          abortIf(input.signal);
          if (source.kind !== "asset" && retainOriginal(intent, config)) {
            // External originals are never deleted; retaining also archives the downloaded bytes.
            await this.assets.archive(new File([original.blob], original.name, { type: original.blob.type }),
              input.document.id, input.signal);
          }
          const path = await this.assets.upload(compressed.value.file, input.document.id, input.signal);
          // Verify bytes returned by the actual path, including possible host deduplication.
          const returned = resolveSource(path, this.origin);
          const reloaded = await this.reader.read(returned, options);
          if (await digest(reloaded.blob) !== await digest(compressed.value.file))
            throw new Error("Uploaded bytes did not match encoded output");
          prepared.push({ source, path, originalHash, originalBytes: original.blob.size, outputBytes: compressed.value.outputBytes });
          state.uploaded++;
        } catch (error) {
          if (error instanceof RequestError && error.outcome === "unknown-write") {
            unknownUpload = true;
            throw error;
          }
          if (input.signal?.aborted) throw error;
          state.failed++;
          // Do not include raw URL query strings or absolute local paths in UI/logs.
          state.messages.push(error instanceof Error ? error.name + ": " + error.message : "Preparation failed");
        } finally { state.completed++; await journal.checkpoint(); }
      });
      abortIf(input.signal);
      if (!prepared.length) { state.phase = state.failed ? "failed" : "done"; await journal.checkpoint(); return { state, prepared }; }
      const mappings: Mapping[] = prepared.map(p => ({
        key: p.source.key,
        oldPath: p.source.kind === "asset" ? p.source.path : p.source.raw,
        newPath: p.path,
        ...(intent.kind === "remote-auto" && input.selection ? {
          selection: { blockID: intent.blockID, ...input.selection },
        } : {}),
      }));
      const plan = await this.references.plan(mappings, input.document, config.references.maxDocuments,
        config.references.backend === "sql", intent.kind === "remote-auto" ? intent.blockID : undefined, input.signal);
      state.phase = "preview"; await journal.checkpoint();
      if (!await input.confirm(plan)) { state.phase = "cancelled"; await journal.checkpoint(); return { state, prepared }; }
      abortIf(input.signal);
      writing = true;
      const referenceResult = await this.references.commit(plan, journal, input.signal);
      state.referenceResult = referenceResult;
      state.phase = referenceResult.state === "verified" ? (state.failed ? "partial" : "done") : referenceResult.state;
      await journal.checkpoint();
      return { state, prepared, referenceResult };
    } catch (error) {
      state.phase = writing || unknownUpload ? "unknown" : input.signal?.aborted ? "cancelled" : "failed";
      state.messages.push(error instanceof Error ? error.message : "Job failed");
      await journal.checkpoint().catch(() => undefined);
      notify(clone(state));
      return { state, prepared };
    }
  }
}
```

## 13.15 `recovery.ts`



```typescript
import { isRecord, abortIf } from "./core.js";
import { NODE_ID } from "./config.js";
import { type Kernel } from "./kernel.js";
import { ReferenceService, blockDOM, type ReferencePlan } from "./references.js";
import type { BlockPatch } from "./dom.js";

/** Strictly validate a persisted SQL plan before using any of its IDs or DOM. */
export function readRecoveryPatches(raw: unknown): BlockPatch[] {
  if (!isRecord(raw) || raw.backend !== "sql" || !Array.isArray(raw.patches) || raw.patches.length > 10_000)
    throw new Error("Only an explicit SQL plan supports conditional block restoration");
  return raw.patches.map(p => {
    if (!isRecord(p) || !["id", "rootID", "notebook"].every(k => typeof p[k] === "string" && NODE_ID.test(p[k] as string))
        || typeof p.before !== "string" || typeof p.after !== "string" || !p.before || !p.after
        || (p.before.length + p.after.length) * 2 > 16 * 1024 * 1024)
      throw new Error("Invalid recovery block");
    return p as unknown as BlockPatch;
  });
}
export async function inspectRecovery(k: Kernel, raw: unknown, signal?: AbortSignal) {
  const result: Array<{ id: string; state: "unchanged" | "can-restore" | "conflict" }> = [];
  for (const patch of readRecoveryPatches(raw)) {
    const now = await blockDOM(k, patch.id, patch.notebook, signal);
    result.push({ id: patch.id, state: now === patch.before ? "unchanged" : now === patch.after ? "can-restore" : "conflict" });
  }
  return result;
}
/**
 * Explicit user action only. Native tasks use kernel history; NEVER reverse mappings globally.
 * The caller verifies original assets are still readable before permitting any restoration.
 */
export async function restoreSQLPlan(
  k: Kernel, references: ReferenceService, raw: unknown,
  verifyOriginals: () => Promise<boolean>,
  saveRecoveryState: (id: string, state: string) => Promise<void>,
  signal?: AbortSignal,
) {
  const patches = readRecoveryPatches(raw);
  return references.withWriteLease(signal, async () => {
    if (!await verifyOriginals()) throw new Error("Original files are unavailable; restoration refused");
    const result: Record<string, "restored" | "unchanged" | "conflict" | "unknown"> = {};
    for (const patch of patches) {
      abortIf(signal);
      const now = await blockDOM(k, patch.id, patch.notebook, signal);
      if (now === patch.before) { result[patch.id] = "unchanged"; continue; }
      if (now !== patch.after) { result[patch.id] = "conflict"; continue; }
      await saveRecoveryState(patch.id, "restore-sent");
      abortIf(signal);
      try {
        const r = await k.post("/api/block/updateBlock", {
          id: patch.id, dataType: "dom", data: patch.before, lockType: true,
        }, "write", signal);
        if (r.code !== 0 || await blockDOM(k, patch.id, patch.notebook, signal) !== patch.before)
          throw new Error("Restore not verified");
        result[patch.id] = "restored";
        await saveRecoveryState(patch.id, "restored");
      } catch {
        result[patch.id] = "unknown";
        await saveRecoveryState(patch.id, "unknown").catch(() => undefined);
        break; // no resend; partial success is retained
      }
    }
    return result;
  });
}
```

## 13.16 `auto-upload.ts`



```typescript
import { abortIf, deadline, type Scope, type EventPort } from "./core.js";
import { autoAllowed, retainOriginal, type ImageConfig } from "./config.js";
import { SourceReader } from "./download.js";
import { resolveSource } from "./source.js";
import { AssetStore } from "./assets.js";
import { BicEncoder } from "./image.js";
import { RequestError } from "./kernel.js";

export interface LocalFile { path: string; size: number | null; isDir?: boolean }
export type UploadInput = { kind: "files"; files: File[] } | { kind: "local-files"; files: LocalFile[] };
// The official protocol has replace/cancel, NOT action:"continue".
export type UploadDecision = { action: "replace"; input: UploadInput } | { action: "cancel" };
export interface UploadResult {
  requestId: string; status: "success" | "partial" | "failed" | "canceled";
  input: UploadInput; acceptedInput?: UploadInput;
  succFiles?: Array<{ index: number; name: string; path: string }>;
}
export interface UploadDetail {
  requestId: string; target: string; source: string;
  protyle?: { block?: { rootID?: string } };
  input: UploadInput; signal: AbortSignal;
  allowedInputKinds?: Array<UploadInput["kind"]>; requiredFileCount?: number;
  respondWith(value: PromiseLike<UploadDecision>): void;
  onComplete?(callback: (result: UploadResult) => void): void;
}
export interface UploadDeps {
  bus: EventPort; scope: Scope; config(): ImageConfig;
  reader: SourceReader; encoder: BicEncoder; assets: AssetStore; origin: string;
  notice(message: string): void;
}
export function installAutoUpload(d: UploadDeps): () => void {
  const listener = (event: CustomEvent<UploadDetail>) => {
    const e = event.detail, c = d.config(), rootID = e?.protyle?.block?.rootID;
    if (!d.scope.active || !c.auto.uploads || !rootID || !autoAllowed(c, rootID)
        || e.target !== "editor" || typeof e.respondWith !== "function" || !e.input
        || !["files", "local-files"].includes(e.input.kind) || !Array.isArray(e.input.files)) return;
    const original = e.input;
    const count = original.files.length;
    if (!count || count > 16 || e.requiredFileCount !== undefined && e.requiredFileCount !== count) return;
    if (original.kind === "local-files" &&
      (!c.sources.desktopLocalFiles || original.files.some(f => f.isDir)
        || e.allowedInputKinds && !e.allowedInputKinds.includes("files"))) return;

    let replacements: File[] = [];
    let completion: UploadResult | undefined;
    let prepared = false, registered = false, notified = false;
    const notify = () => {
      if (!d.scope.active || !prepared || notified || !replacements.length) return;
      if (!registered) { notified = true; d.notice("Compression prepared; host upload is not yet confirmed"); return; }
      if (!completion || completion.requestId !== e.requestId) return;
      const accepted = completion.acceptedInput ?? completion.input;
      const uploaded = accepted.kind === "files" && completion.succFiles
        ? completion.succFiles.filter(row => replacements.includes(accepted.files[row.index])).length : 0;
      notified = true;
      d.notice(`Host upload ${completion.status}; confirmed compressed files: ${uploaded}. Document save is separate.`);
    };
    if (typeof e.onComplete === "function") {
      try { e.onComplete(result => { completion = result; notify(); }); registered = true; }
      catch { registered = false; }
    }
    const registrationAbort = new AbortController();

    const response = (async (): Promise<UploadDecision> => {
      const total = deadline(d.scope.signal, 110_000);
      const hostController = new AbortController();
      const cancel = () => hostController.abort();
      e.signal?.addEventListener("abort", cancel, { once: true });
      const cancelScope = () => hostController.abort();
      total.signal.addEventListener("abort", cancelScope, { once: true });
      registrationAbort.signal.addEventListener("abort", cancelScope, { once: true });
      if (e.signal?.aborted || total.signal.aborted) hostController.abort();
      try {
        const signal = hostController.signal;
        let files: File[];
        if (original.kind === "files") {
          if (original.files.some(f => !(f instanceof File))) return { action: "replace", input: original };
          files = original.files;
        } else {
          // Conversion is all-or-nothing: never mix File and local-files or reorder a mixed batch.
          files = [];
          let bytes = 0;
          for (const item of original.files) {
            abortIf(signal);
            const source = resolveSource(item.path, d.origin);
            if (source.kind !== "file") throw new Error("Invalid desktop upload path");
            const read = await d.reader.read(source, { maxBytes: c.compression.maxInputBytes, timeoutMs: 30_000,
              allowedOrigins: new Set(), signal });
            bytes += read.blob.size;
            if (bytes > 64 * 1024 * 1024) throw new Error("Local upload materialisation exceeds batch limit");
            files.push(new File([read.blob], read.name, { type: read.blob.type }));
          }
        }
        const output = [...files];
        for (let index = 0; index < files.length; index++) {
          abortIf(signal);
          const file = files[index];
          // Non-images in a mixed upload remain unchanged.
          if (!/\.(?:png|jpe?g|webp)$/i.test(file.name) && !/^image\/(?:png|jpeg|webp)$/.test(file.type)) continue;
          try {
            const result = await d.encoder.encode(file, file.name, c, signal);
            if (result.kind === "skipped") continue;
            const intent = { kind: "upload" as const, rootID, originalInputCount: count };
            if (retainOriginal(intent, c)) await d.assets.archive(file, rootID, signal);
            abortIf(signal);
            output[index] = result.value.file;
          } catch (error) {
            if (signal.aborted || error instanceof RequestError && error.outcome === "unknown-write") throw error;
            // Compression/archive error: retain this file; never promise that archival succeeded.
            output[index] = file;
          }
        }
        abortIf(signal);
        replacements = output.filter((f, i) => f !== files[i]);
        prepared = true; notify();
        if (!replacements.length) return { action: "replace", input: original };
        return { action: "replace", input: { kind: "files", files: output } };
      } catch {
        replacements = []; prepared = true;
        return { action: "replace", input: original };
      } finally {
        total.close();
        registrationAbort.signal.removeEventListener("abort", cancelScope);
        e.signal?.removeEventListener("abort", cancel);
        total.signal.removeEventListener("abort", cancelScope);
      }
    })();
    // Registration stays in the event's synchronous call stack.
    try { e.respondWith(response); }
    catch { registrationAbort.abort(); void response.catch(() => undefined); }
  };
  d.bus.on("before-upload-assets", listener);
  return d.scope.own(() => d.bus.off("before-upload-assets", listener));
}
```

## 13.17 `remote-auto.ts`



```typescript
import { abortIf, Scope } from "./core.js";
import { autoAllowed, type ImageConfig } from "./config.js";
import { blockDOM, type DocumentRow } from "./references.js";
import { scanDOM } from "./dom.js";
import { resolveSource, type ImageSource } from "./source.js";
import type { Kernel } from "./kernel.js";
import type { ImageJobRunner } from "./jobs.js";

interface Candidate { blockID: string; source: ImageSource; count: number }
export interface RemoteWatchOptions {
  editor: HTMLElement; document: DocumentRow; scope: Scope;
  kernel: Kernel; jobs: ImageJobRunner; origin: string; mobile: boolean;
  config(): ImageConfig;
  notice(message: string): void;
}
export async function watchRemoteImages(o: RemoteWatchOptions): Promise<() => void> {
  const local = new Scope();
  const releaseFromParent = o.scope.own(() => local.dispose());
  const key = (id: string, sourceKey: string) => `${id}\n${sourceKey}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false, rebase = false, reading = false, rerun = false;
  const running = new Set<string>();
  let queue = Promise.resolve();

  async function snapshot(): Promise<Map<string, Candidate>> {
    const dom = await blockDOM(o.kernel, o.document.id, o.document.box, local.signal);
    const result = new Map<string, Candidate>();
    for (const ref of scanDOM(dom, o.origin).filter(r => r.kind === "image")) {
      const identity = key(ref.blockID, ref.key), existing = result.get(identity);
      if (existing) existing.count++;
      else result.set(identity, { blockID: ref.blockID, source: resolveSource(ref.raw, o.origin), count: 1 });
    }
    return result;
  }
  // COMPLETE persisted baseline: folded/offscreen images are not treated as new insertions.
  let previous = await snapshot();
  abortIf(local.signal);

  const onUndo = (event: Event) => {
    const type = (event as InputEvent).inputType;
    if (type === "historyUndo" || type === "historyRedo") rebase = true;
  };
  o.editor.addEventListener("beforeinput", onUndo, true);
  local.own(() => o.editor.removeEventListener("beforeinput", onUndo, true));

  async function process(candidate: Candidate, oldCount: number) {
    const identity = key(candidate.blockID, candidate.source.key);
    if (disposed || running.has(identity) || candidate.source.kind !== "remote") return;
    running.add(identity);
    try {
      const c = o.config();
      if (!c.auto.remoteImages || !autoAllowed(c, o.document.id)) return;
      const refs = scanDOM(await blockDOM(o.kernel, candidate.blockID, o.document.box, local.signal), o.origin);
      if (refs.filter(r => r.kind === "image" && r.key === candidate.source.key).length !== candidate.count) return;
      const result = await o.jobs.run({
        intent: { kind: "remote-auto", rootID: o.document.id, blockID: candidate.blockID },
        document: o.document, sources: [candidate.source], config: c, mobile: o.mobile,
        signal: local.signal, allowedOrigins: new Set(c.sources.remoteOrigins),
        // Same URL is one resource within this block. Replace ALL its image occurrences,
        // not an assumed "new last index": the user may have inserted at the beginning.
        selection: { expectedCount: candidate.count,
          imageIndices: Array.from({ length: candidate.count }, (_, i) => i) },
        confirm: async plan => plan.backend === "sql" && plan.patches.every(p => p.id === candidate.blockID),
      });
      if (result.state.phase !== "done") o.notice(`Automatic URL compression: ${result.state.phase}`);
    } catch (error) {
      if (local.active) o.notice(error instanceof Error ? error.message : "Automatic image processing failed");
    } finally { running.delete(identity); }
  }

  async function sweep() {
    if (!local.active) return;
    if (reading) { rerun = true; return; }
    reading = true;
    try {
      const current = await snapshot(), old = previous;
      previous = current;
      if (rebase) { rebase = false; return; }
      const c = o.config();
      if (!c.auto.remoteImages || !autoAllowed(c, o.document.id)) return;
      const added = [...current].filter(([identity, candidate]) =>
        candidate.source.kind === "remote" && candidate.count > (old.get(identity)?.count ?? 0)
        && c.sources.remoteOrigins.includes(new URL(candidate.source.url).origin));
      if (added.length > 20) { o.notice("Many new external images detected; use a manual document job"); return; }
      // Sequential auto jobs avoid two precomputed plans fighting over one block.
      for (const [identity, candidate] of added)
        queue = queue.then(() => process(candidate, old.get(identity)?.count ?? 0)).catch(() => undefined);
    } catch (error) {
      if (local.active) o.notice(error instanceof Error ? error.message : "Cannot read persisted images");
    } finally {
      reading = false;
      if (rerun && local.active) { rerun = false; schedule(350); }
    }
  }
  function schedule(ms: number) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void sweep();
      // A second READ catches an image whose DOM was updated before its transaction was persisted.
      if (local.active) timer = setTimeout(() => void sweep(), 900);
    }, ms);
  }
  const containsImage = (node: Node) => node instanceof Element
    && (node.matches("img") || !!node.querySelector("img"));
  const observer = new MutationObserver(records => {
    if (records.some(r => r.type === "attributes" && r.target instanceof HTMLImageElement
      || [...r.addedNodes, ...r.removedNodes].some(containsImage))) schedule(450);
  });
  observer.observe(o.editor, { childList: true, subtree: true, attributes: true,
    attributeFilter: ["src", "data-src"] });
  local.own(() => { observer.disconnect(); if (timer) clearTimeout(timer); });
  // Dispose/recreate on sync-start/end, document switch and editor destruction.
  return () => { disposed = true; releaseFromParent(); };
}
```

## 13.18 `controller.ts`

单图、整篇、显式 File 兜底的调用边界；document 方法不调用 finalizer。

```typescript
import { Scope, clone, abortIf, isRecord } from "./core.js";
import { NODE_ID, type ImageConfig, type Intent } from "./config.js";
import { type Kernel, readData } from "./kernel.js";
import { scanDOM } from "./dom.js";
import { blockDOM, sqlLiteral, type DocumentRow, type ReferencePlan } from "./references.js";
import { resolveSource, trySource, imageSourceAttribute, type ImageSource } from "./source.js";
import { SourceReader } from "./download.js";
import { digest, SingleOriginalFinalizer } from "./assets.js";
import { ImageJobRunner, type JobState, type JobOutput } from "./jobs.js";
import { StateStore } from "./state.js";

export interface ImageUI {
  confirm(title: string, message: string, signal: AbortSignal): Promise<boolean>;
  pickImage(name: string, signal: AbortSignal): Promise<File | undefined>;
  progress(state: StateStore<JobState>, cancel: () => void): { close(): void };
  notify(message: string): void;
}
export interface EditorContext { rootID: string; notebook: string; disabled?: boolean }
export class ImageController {
  constructor(private readonly kernel: Kernel, private readonly origin: string,
    private readonly scope: Scope, private readonly config: () => ImageConfig,
    private readonly runner: ImageJobRunner, private readonly reader: SourceReader,
    private readonly singleFinalizer: SingleOriginalFinalizer, private readonly ui: ImageUI,
    private readonly desktopFiles: boolean, private readonly mobile: boolean) {}

  private async identity(context: EditorContext): Promise<DocumentRow> {
    if (context.disabled || !NODE_ID.test(context.rootID) || !NODE_ID.test(context.notebook))
      throw new Error("没有可写的文档上下文");
    const rows = await readData<unknown>(this.kernel, "/api/query/sql", {
      stmt: `SELECT id, root_id, box FROM blocks WHERE type = 'd' AND id = ${sqlLiteral(context.rootID)} LIMIT 1`,
      mode: "readonly",
    }, this.scope.signal);
    if (!Array.isArray(rows) || rows.length !== 1 || !isRecord(rows[0])
        || rows[0].id !== context.rootID || rows[0].root_id !== context.rootID || rows[0].box !== context.notebook)
      throw new Error("无法确认普通文档身份；加密或未索引文档不降级猜测");
    return rows[0] as unknown as DocumentRow;
  }

  async document(context: EditorContext): Promise<JobOutput | undefined> {
    const doc = await this.identity(context);
    const dom = await blockDOM(this.kernel, doc.id, doc.box, this.scope.signal);
    const refs = scanDOM(dom, this.origin).filter(r => r.kind === "image");
    const sources = refs.map(r => resolveSource(r.raw, this.origin));
    if (!sources.length) { this.ui.notify("没有可识别的图片来源"); return; }
    // A document task can never reach SingleOriginalFinalizer.
    return this.run({ kind: "document", rootID: doc.id }, doc, sources);
  }

  async singleFromFile(image: HTMLImageElement, context: EditorContext): Promise<JobOutput | undefined> {
    const raw = imageSourceAttribute(image);
    if (!raw) throw new Error("无法确定图片来源");
    const source = resolveSource(raw, this.origin);
    if (!await this.ui.confirm("使用选择的原文件",
      "请选择此链接对应的同一张原图；不会根据文件名自动匹配文件。", this.scope.signal)) return;
    const file = await this.ui.pickImage(source.name, this.scope.signal);
    if (!file) return;
    return this.single(image, context, file);
  }

  async single(image: HTMLImageElement, context: EditorContext, providedOriginal?: File): Promise<JobOutput | undefined> {
    const doc = await this.identity(context);
    const blockID = image.closest("[data-node-id]")?.getAttribute("data-node-id");
    const raw = imageSourceAttribute(image);
    if (!blockID || !NODE_ID.test(blockID) || !raw) throw new Error("无法确定选中图片");
    const source = resolveSource(raw, this.origin);
    const dom = await blockDOM(this.kernel, doc.id, doc.box, this.scope.signal);
    if (!scanDOM(dom, this.origin).some(r => r.blockID === blockID && r.kind === "image" && r.key === source.key))
      throw new Error("图片尚未保存或已经改变，请重新选择");
    const intent: Intent = { kind: "manual-single", rootID: doc.id };
    const c = clone(this.config());
    const output = await this.run(intent, doc, [source], c,
      providedOriginal ? new Map([[source.key, providedOriginal]]) : new Map());
    if (output?.referenceResult?.state !== "verified" || output.state.phase !== "done") return output;
    const item = output.prepared.find(p => p.source.key === source.key);
    if (!item || providedOriginal) return output;
    try {
      const cleanup = await this.singleFinalizer.finish(intent, c, source, item.path, output.referenceResult,
        async () => {
          const original = await this.reader.read(source, {
            maxBytes: c.compression.maxInputBytes, timeoutMs: 30_000,
            allowedOrigins: new Set(c.sources.remoteOrigins), signal: this.scope.signal,
          });
          return await digest(original.blob) === item.originalHash;
        }, this.scope.signal);
      this.ui.notify(cleanup.status === "removed-from-live-assets"
        ? "引用更新完成；原资源已移出活动资源目录，宿主历史仍保留备份"
        : cleanup.status === "unknown" ? "引用更新完成；清理结果未确认，请勿重复删除"
        : `引用更新完成；原图保留（${cleanup.reason}）`);
    } catch {
      this.ui.notify("引用更新完成；未满足清理校验，原图保留");
    }
    return output;
  }

  private async run(intent: Intent, doc: DocumentRow, sources: ImageSource[], c = clone(this.config()),
    providedFiles: ReadonlyMap<string, File> = new Map()) {
    const local = new Map(providedFiles);
    const allowedOrigins = new Set(c.sources.remoteOrigins);
    for (const source of new Map(sources.map(s => [s.key, s])).values()) {
      abortIf(this.scope.signal);
      if (local.has(source.key)) continue;
      if (source.kind === "remote") {
        const origin = new URL(source.url).origin;
        if (!allowedOrigins.has(origin)) {
          if (!await this.ui.confirm("请求外链图片",
            `本次任务将从 ${origin} 下载图片。不会发送 Cookie；此确认不加入永久自动下载名单。`,
            this.scope.signal)) return undefined;
          allowedOrigins.add(origin);
        }
      } else if (source.kind === "file") {
        if (!c.sources.desktopLocalFiles) throw new Error("本地文件处理已关闭");
        if (!this.desktopFiles) {
          // Remote browser/mobile: the user's selected File is an explicit replacement source.
          // Never interpret a client path as a server filesystem path.
          if (!await this.ui.confirm("选择本地原图",
            `当前环境不能读取此电脑路径。请确认接下来选择的文件就是 ${source.name} 对应原图。`,
            this.scope.signal)) return undefined;
          const file = await this.ui.pickImage(source.name, this.scope.signal);
          if (!file) return undefined;
          local.set(source.key, file);
        }
      }
    }
    const task = new AbortController();
    const abort = () => task.abort();
    const unlink = this.scope.own(abort);
    const state = new StateStore<JobState>({ id: "", phase: "preparing", total: sources.length,
      completed: 0, uploaded: 0, skipped: 0, failed: 0, blocks: {}, messages: [] });
    const view = this.ui.progress(state, abort);
    this.scope.own(() => view.close());
    try {
      return await this.runner.run({ intent, document: doc, sources, config: c, mobile: this.mobile,
        signal: task.signal, allowedOrigins, providedFiles: local, onState: value => state.set(clone(value)),
        confirm: plan => this.confirmPlan(plan, intent, task.signal) });
    } finally {
      // Removing the scope-owned abort is safe: this task has already finished.
      unlink();
      local.clear();
    }
  }

  private confirmPlan(plan: ReferencePlan, intent: Intent, signal: AbortSignal): Promise<boolean> {
    const coverage = plan.backend === "native" ? "宿主资源引用重链接"
      : "SQL 兼容路径：已索引普通文档中的图片/链接；不保证覆盖属性视图、模板或其他插件私有数据";
    const count = plan.backend === "sql" ? `${plan.patches.length} 个块`
      : `${plan.preview.references.length} 条预检记录（不等于图片数）`;
    const keep = intent.kind === "document" ? "本次是文档批量任务，原图强制保留。"
      : "单图删除还须通过独立安全校验；SQL 路径不会自动删除原图。";
    return this.ui.confirm("确认更新共享引用",
      `${coverage}\n涉及 ${plan.rootIDs.length} 篇文档、${count}。\n其他文档共享同一图片的链接也会更新。\n${keep}\n已生成的资源在取消时保留，避免误删其他引用。`, signal);
  }
}
```

## 13.19 `editor-context.ts`



```typescript
import { isRecord } from "./core.js";
import { NODE_ID } from "./config.js";
import type { EditorContext } from "./controller.js";

/** Never fall back to the first globally visible editor. */
export function resolveEditor(protyle: unknown): { element: HTMLElement; context: EditorContext } | undefined {
  if (!isRecord(protyle) || !isRecord(protyle.block) || !(protyle.element instanceof HTMLElement)) return;
  const rootID = protyle.block.rootID;
  const notebook = typeof protyle.notebookId === "string" ? protyle.notebookId : protyle.block.box;
  if (typeof rootID !== "string" || !NODE_ID.test(rootID) || typeof notebook !== "string" || !NODE_ID.test(notebook)) return;
  return { element: protyle.element, context: { rootID, notebook, disabled: protyle.disabled === true } };
}
export function menuImage(element: unknown): HTMLImageElement | undefined {
  if (!(element instanceof HTMLElement)) return;
  if (element instanceof HTMLImageElement) return element;
  return element.querySelector("img") ?? undefined;
}
export function runMenuAction(action: () => Promise<unknown>, notice: (message: string) => void): void {
  void action().catch(error => notice(error instanceof Error ? error.message : "Image action failed"));
}
```

## 13.20 `ImageSettingsPanel.svelte`

目标 Svelte 5 代码；未在本环境编译。Core 总开关不在本组件中复制。

```svelte
<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { ConfigStore } from "./core.js";
  import { clone, same } from "./core.js";
  import { defaults, parseConfig, parseExtensions, NODE_ID, type ImageConfig } from "./config.js";

  interface Props {
    store: ConfigStore<ImageConfig>;
    featureRunning: boolean;
    capabilities: { hostVersion: string; referenceMode: string; localFiles: boolean; cleanup: boolean };
    t: (key: string) => string;
    validateDocument: (id: string) => Promise<{ id: string; title: string }>;
    resetWithoutMigration: () => Promise<void>;
  }
  let { store, featureRunning, capabilities, t, validateDocument, resetWithoutMigration }: Props = $props();
  let baseline = $state<ImageConfig>(untrack(() => clone(store.snapshot())));
  let draft = $state<ImageConfig>(untrack(() => clone(store.snapshot())));
  let extensions = $state(draft.compression.excludedExtensions.join(", "));
  let origins = $state(draft.sources.remoteOrigins.join("\n"));
  let busy = $state(false), conflict = $state(false), error = $state("");
  let readOnly = $state(untrack(() => store.needsRecovery));
  let rootID = $state(""), search = $state("");
  let dirty = $derived(!same(draft, baseline)
    || extensions !== baseline.compression.excludedExtensions.join(", ")
    || origins !== baseline.sources.remoteOrigins.join("\n"));
  const permissionRows = $derived(Object.entries(draft.auto.pageAllowlist)
    .filter(([id, meta]) => (id + meta.title).toLowerCase().includes(search.toLowerCase())));

  function adopt(next: Readonly<ImageConfig>) {
    baseline = clone(next); draft = clone(next);
    extensions = next.compression.excludedExtensions.join(", ");
    origins = next.sources.remoteOrigins.join("\n");
    conflict = false; error = "";
  }
  onMount(() => store.subscribe(value => {
    readOnly = store.needsRecovery;
    if (!dirty) adopt(value);
    else if (!same(value, baseline) && !busy) conflict = true;
  }));
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy || readOnly || conflict) return;
    busy = true; error = "";
    try {
      const next = parseConfig({
        ...$state.snapshot(draft),
        compression: { ...draft.compression, excludedExtensions: parseExtensions(extensions) },
        sources: { ...draft.sources, remoteOrigins: origins.split(/\r?\n/).map(v => v.trim()).filter(Boolean) },
      });
      const expected = $state.snapshot(baseline);
      await store.update(current => {
        if (!same(current, expected)) throw new Error(t("settings.concurrentChange"));
        Object.assign(current, next);
      });
      adopt(store.snapshot());
    } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    finally { busy = false; }
  }
  async function addDocument() {
    if (!NODE_ID.test(rootID) || busy || readOnly) { error = t("settings.invalidDocument"); return; }
    busy = true; error = "";
    try {
      const result = await validateDocument(rootID);
      if (result.id !== rootID) throw new Error(t("settings.invalidDocument"));
      draft.auto.pageAllowlist[rootID] = { grantedAt: Date.now(), title: result.title };
      rootID = "";
    } catch (cause) { error = String(cause); }
    finally { busy = false; }
  }
  async function recover() {
    busy = true; error = "";
    try { await resetWithoutMigration(); adopt(store.snapshot()); }
    catch (cause) { error = String(cause); }
    finally { busy = false; }
  }
</script>

<form class="omnikit-image-settings" onsubmit={save}>
  {#if readOnly}
    <div class="notice notice--error" role="alert">
      <strong>{t("settings.configBlocked")}</strong>
      <p>{t("settings.noMigration")}</p>
      <button type="button" class="b3-button b3-button--outline" disabled={busy} onclick={recover}>
        {t("settings.backupReset")}
      </button>
    </div>
  {/if}
  {#if !featureRunning}<div class="notice">{t("settings.disabledButEditable")}</div>{/if}
  <div class="capabilities">
    <span>{t("settings.host")}: {capabilities.hostVersion}</span>
    <span>{t("settings.references")}: {capabilities.referenceMode}</span>
    <span>{t("settings.localRead")}: {t(capabilities.localFiles ? "settings.available" : "settings.unavailable")}</span>
  </div>

  <fieldset disabled={busy || readOnly}>
    <section class="setting-card">
      <header><h3>{t("settings.automation")}</h3><p>{t("settings.automationHelp")}</p></header>
      <label class="setting-row">
        <span><strong>{t("settings.global")}</strong><small>{t("settings.globalHelp")}</small></span>
        <input type="checkbox" class="b3-switch" bind:checked={draft.auto.globalEnabled} />
      </label>
      <label class="setting-row">
        <span><strong>{t("settings.uploads")}</strong><small>{t("settings.uploadsHelp")}</small></span>
        <input type="checkbox" class="b3-switch" bind:checked={draft.auto.uploads} />
      </label>
      <label class="setting-row">
        <span><strong>{t("settings.remoteAuto")}</strong><small>{t("settings.remoteHelp")}</small></span>
        <input type="checkbox" class="b3-switch" bind:checked={draft.auto.remoteImages} />
      </label>
    </section>

    <section class="setting-card">
      <header><h3>{t("settings.quality")}</h3><p>{t("settings.qualityHelp")}</p></header>
      <label class="setting-row">
        <span><strong>{t("settings.initialQuality")}</strong><small>{t("settings.notSimilarity")}</small></span>
        <span class="range-control">
          <input type="range" min="0.1" max="1" step="0.01" bind:value={draft.compression.initialQuality}
            aria-label={t("settings.initialQuality")} />
          <output>{Math.round(draft.compression.initialQuality * 100)}%</output>
        </span>
      </label>
      <label class="setting-row">
        <span><strong>{t("settings.maxDimension")}</strong><small>{t("settings.dimensionHelp")}</small></span>
        <span class="number-control"><input type="number" class="b3-text-field" min="256" max="8192" step="1"
          bind:value={draft.compression.maxDimension} /><span>px</span></span>
      </label>
      <label class="setting-row">
        <span><strong>{t("settings.exclusions")}</strong><small>{t("settings.protectedFormats")}</small></span>
        <input class="b3-text-field text-control" bind:value={extensions} />
      </label>
    </section>

    <section class="setting-card safety-card">
      <header><h3>{t("settings.originals")}</h3><p>{t("settings.originalsHelp")}</p></header>
      <label class="setting-row">
        <span><strong>{t("settings.deleteSingle")}</strong><small>{t("settings.deleteSingleHelp")}</small></span>
        <input type="checkbox" class="b3-switch" bind:checked={draft.retention.deleteSingleOriginal} />
      </label>
      <div class="notice"><strong>{t("settings.batchAlwaysKeeps")}</strong></div>
      {#if draft.retention.deleteSingleOriginal && !capabilities.cleanup}
        <p class="warning">{t("settings.cleanupUnavailable")}</p>
      {/if}
      <p class="footnote">{t("settings.neverDeleteComputerFile")}</p>
    </section>

    <section class="setting-card">
      <header><h3>{t("settings.sources")}</h3><p>{t("settings.sourcesHelp")}</p></header>
      <label class="stacked">
        <strong>{t("settings.allowedOrigins")}</strong>
        <textarea class="b3-text-field" rows="3" spellcheck="false" bind:value={origins}
          placeholder="https://images.example.com"></textarea>
        <small>{t("settings.originHelp")}</small>
      </label>
      <label class="setting-row">
        <span><strong>{t("settings.localFiles")}</strong><small>{t("settings.localFilesHelp")}</small></span>
        <input type="checkbox" class="b3-switch" bind:checked={draft.sources.desktopLocalFiles}
          disabled={!capabilities.localFiles} />
      </label>
    </section>

    <section class="setting-card">
      <header><h3>{t("settings.documents")} · {Object.keys(draft.auto.pageAllowlist).length}</h3>
        <p>{t("settings.documentsHelp")}</p></header>
      <div class="document-controls">
        <input class="b3-text-field" bind:value={search} placeholder={t("settings.searchDocuments")}
          aria-label={t("settings.searchDocuments")} />
        <input class="b3-text-field" bind:value={rootID} placeholder={t("settings.documentID")}
          aria-label={t("settings.documentID")} />
        <button type="button" class="b3-button b3-button--outline" onclick={addDocument}>{t("settings.add")}</button>
      </div>
      <div class="document-list">
        {#each permissionRows as [id, meta] (id)}
          <div class="document-row">
            <span><strong>{meta.title || id}</strong><small>{id}</small></span>
            <button type="button" class="b3-button b3-button--text" onclick={() => delete draft.auto.pageAllowlist[id]}
              aria-label={`${t("settings.remove")} ${meta.title || id}`}>{t("settings.remove")}</button>
          </div>
        {:else}<p class="footnote">{t("settings.noDocuments")}</p>{/each}
      </div>
    </section>

    <details class="setting-card">
      <summary>{t("settings.advanced")}</summary>
      <div class="advanced-grid">
        {#each [
          ["minInputBytes", "settings.minInput"], ["minSavingBytes", "settings.minSavingBytes"],
          ["maxInputBytes", "settings.maxInput"], ["maxPixels", "settings.maxPixels"],
          ["maxEncodeMs", "settings.maxTime"], ["concurrencyDesktop", "settings.desktopConcurrency"],
          ["concurrencyMobile", "settings.mobileConcurrency"],
        ] as item}
          {@const key = item[0] as "minInputBytes" | "minSavingBytes" | "maxInputBytes" | "maxPixels" | "maxEncodeMs" | "concurrencyDesktop" | "concurrencyMobile"}
          <label class="stacked">{t(item[1])}
            <input class="b3-text-field" type="number" step="1" bind:value={draft.compression[key]} />
          </label>
        {/each}
        <label class="stacked">{t("settings.minSavingRatio")}
          <input class="b3-text-field" type="number" min="0" max="0.9" step="0.01" bind:value={draft.compression.minSavingRatio} />
        </label>
        <label class="stacked">{t("settings.referenceBackend")}
          <select class="b3-select" bind:value={draft.references.backend}>
            <option value="auto">{t("settings.backendAuto")}</option>
            <option value="sql">{t("settings.backendSQL")}</option>
          </select>
        </label>
      </div>
    </details>
  </fieldset>

  {#if conflict}
    <div class="notice notice--error" role="alert">
      {t("settings.concurrentChange")}
      <button type="button" class="b3-button b3-button--outline" onclick={() => adopt(store.snapshot())}>
        {t("settings.discardReload")}
      </button>
    </div>
  {/if}
  {#if error}<p class="warning" role="alert">{error}</p>{/if}
  <footer class="save-bar">
    <span aria-live="polite">{t(busy ? "settings.saving" : dirty ? "settings.unsaved" : "settings.saved")}</span>
    <button type="button" class="b3-button b3-button--outline" disabled={busy || readOnly}
      onclick={() => { draft = defaults(); extensions = draft.compression.excludedExtensions.join(", "); origins = ""; }}>
      {t("settings.resetDraft")}
    </button>
    <button type="submit" class="b3-button" disabled={busy || readOnly || conflict || !dirty}>{t("settings.save")}</button>
  </footer>
</form>

<style>
  .omnikit-image-settings { color: var(--b3-theme-on-background); max-width: 940px; margin: auto; }
  fieldset { border: 0; padding: 0; margin: 0; min-width: 0; display: grid; gap: 16px; }
  .setting-card { border: 1px solid var(--b3-border-color); border-radius: 8px; padding: 16px 20px; }
  header { margin-bottom: 8px; } h3 { font-size: 15px; margin: 0 0 6px; }
  p, small, .footnote { color: var(--b3-theme-on-surface); line-height: 1.6; }
  p { margin: 4px 0; } small { display: block; font-size: 12px; margin-top: 4px; }
  .setting-row { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 24px; align-items: center; padding: 14px 0; }
  .setting-row + .setting-row { border-top: 1px solid var(--b3-border-color); }
  .range-control { display: flex; align-items: center; gap: 12px; width: 220px; }
  .range-control input { width: 160px; accent-color: var(--b3-theme-primary); }
  output { min-width: 40px; text-align: right; font-variant-numeric: tabular-nums; }
  .number-control { display: flex; align-items: center; gap: 8px; }
  .number-control input { width: 104px; } .text-control { width: 220px; }
  .stacked { display: grid; gap: 8px; min-width: 0; }
  textarea { resize: vertical; width: 100%; box-sizing: border-box; }
  .notice { background: var(--b3-theme-surface); border-radius: 6px; padding: 12px; margin: 8px 0 16px; line-height: 1.6; }
  .notice--error { border-inline-start: 3px solid var(--b3-theme-error); }
  .warning { color: var(--b3-theme-error); }
  .capabilities { display: flex; flex-wrap: wrap; gap: 8px 20px; margin-bottom: 16px; color: var(--b3-theme-on-surface); font-size: 12px; }
  .document-controls { display: flex; flex-wrap: wrap; gap: 8px; }
  .document-controls input { flex: 1 1 180px; min-width: 0; }
  .document-list { max-height: 240px; overflow: auto; margin-top: 12px; }
  .document-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0; }
  .document-row span { min-width: 0; } .document-row strong { display: block; overflow: hidden; text-overflow: ellipsis; }
  .advanced-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 16px; padding-top: 18px; }
  summary { cursor: pointer; font-weight: 600; }
  .save-bar { position: sticky; bottom: 0; display: flex; align-items: center; gap: 12px; margin-top: 20px; padding: 14px 0;
    background: var(--b3-theme-background); border-top: 1px solid var(--b3-border-color); }
  .save-bar > span { flex: 1; color: var(--b3-theme-on-surface); }
  @media (max-width: 620px) {
    .setting-card { padding: 12px; } .setting-row { gap: 12px; }
    .setting-row:has(.range-control), .setting-row:has(.text-control) { grid-template-columns: 1fr; }
    .range-control, .text-control { width: 100%; } .range-control input { flex: 1; }
    .advanced-grid { grid-template-columns: 1fr; } .save-bar { flex-wrap: wrap; }
    .save-bar > span { flex-basis: 100%; }
  }
</style>
```

## 13.21 `ImageSettingsBridge.svelte`

停用时仍可显示设置的定义级 Bridge；codec 必须先换成 v2。

```svelte
<script lang="ts">
  // Definition-owned settings view: it remains usable while the feature runtime is stopped.
  import { onMount } from "svelte";
  import { getFrontend } from "siyuan";
  import type { ConfigStore } from "./core.js";
  import { Scope, isRecord } from "./core.js";
  import { type ImageConfig, NODE_ID } from "./config.js";
  import { HttpKernel, readData } from "./kernel.js";
  import { sqlLiteral } from "./references.js";
  import { createImageUI } from "./ui-host.integration.js";
  import ImageSettingsPanel from "./ImageSettingsPanel.svelte";

  interface Props {
    store: ConfigStore<ImageConfig> & { recoverWithBackup(): Promise<void> };
    runtimePhase: string;
    t: (key: string) => string;
  }
  let { store, runtimePhase, t }: Props = $props();
  let hostVersion = $state("unknown");
  let localFiles = $state(false);
  const scope = new Scope();
  const kernel = new HttpKernel(location.origin);
  const ui = createImageUI(scope, key => t(key));
  onMount(() => {
    localFiles = ["desktop", "desktop-window"].includes(getFrontend());
    void readData<unknown>(kernel, "/api/system/version", {}, scope.signal).then(value => {
      if (scope.active && typeof value === "string") hostVersion = value;
    }).catch(() => undefined);
    return () => scope.dispose();
  });
  async function validateDocument(id: string) {
    if (!NODE_ID.test(id)) throw new Error(t("settings.invalidDocument"));
    const rows = await readData<unknown>(kernel, "/api/query/sql", {
      stmt: `SELECT id, root_id, content FROM blocks WHERE id = ${sqlLiteral(id)} AND type = 'd' LIMIT 1`,
      mode: "readonly",
    }, scope.signal);
    if (!Array.isArray(rows) || rows.length !== 1 || !isRecord(rows[0])
        || rows[0].id !== id || rows[0].root_id !== id || typeof rows[0].content !== "string")
      throw new Error(t("settings.invalidDocument"));
    return { id, title: rows[0].content.slice(0, 512) };
  }
  async function resetWithoutMigration() {
    if (!await ui.confirm(t("settings.resetTitle"), t("settings.resetDescription"), scope.signal)) return;
    // Existing JsonStore already has backup-before-reset, serialized writes and confirmed commit.
    // Its codec must be switched to defaults()/parseConfig() from config.ts.
    await store.recoverWithBackup();
  }
</script>
<ImageSettingsPanel {store} {t} {validateDocument} {resetWithoutMigration}
  featureRunning={runtimePhase === "enabled"}
  capabilities={{ hostVersion, referenceMode: "auto / SQL fallback",
    localFiles, cleanup: hostVersion === "3.8.9" }} />
```

## 13.22 `ImageTaskPanel.svelte`



```svelte
<script lang="ts">
  import { onMount, untrack } from "svelte";
  import type { StateStore } from "./state.js";
  import type { JobState } from "./jobs.js";
  interface Props { job: StateStore<JobState>; cancel: () => void; t: (key: string) => string }
  let { job, cancel, t }: Props = $props();
  let state = $state(untrack(() => job.snapshot()));
  onMount(() => job.subscribe(next => { state = next; }));
  let active = $derived(["preparing", "preview", "applying"].includes(state.phase));
</script>
<section class="image-task" aria-busy={active}>
  <header>
    <h3>{t(`task.${state.phase}`)}</h3>
    <span class="ft__smaller">{state.id}</span>
  </header>
  {#if state.phase === "preparing"}
    <progress max={Math.max(1, state.total)} value={state.completed} aria-label={t("task.progress")}></progress>
  {:else if active}<progress aria-label={t("task.progress")}></progress>{/if}
  <div class="metrics">
    <div><strong>{state.completed} / {state.total}</strong><span>{t("task.prepared")}</span></div>
    <div><strong>{state.uploaded}</strong><span>{t("task.uploaded")}</span></div>
    <div><strong>{state.skipped}</strong><span>{t("task.skipped")}</span></div>
    <div><strong>{state.failed}</strong><span>{t("task.failedItems")}</span></div>
  </div>
  {#if state.referenceResult}
    <p>{t("task.backend")}: {state.referenceResult.backend}</p>
    {#if state.referenceResult.backend === "sql"}<p class="note">{t("task.sqlCoverage")}</p>{/if}
    {#if state.referenceResult.referencesChanged !== null}
      <p>{t("task.referencesChanged")}: {state.referenceResult.referencesChanged}</p>
    {/if}
    {#if state.referenceResult.storageRecordsChanged !== null}
      <p>{t("task.storageChanged")}: {state.referenceResult.storageRecordsChanged}</p>
    {/if}
  {/if}
  {#if state.phase === "unknown"}<p class="warning" role="alert">{t("task.unknownHelp")}</p>{/if}
  <p class="note">{t("task.cancelHelp")}</p>
  {#if state.messages.length}
    <details><summary>{t("task.details")}</summary>
      {#each state.messages as message}<p class="message">{message}</p>{/each}
    </details>
  {/if}
  {#if active}<button type="button" class="b3-button b3-button--outline" onclick={cancel}>{t("task.cancel")}</button>{/if}
</section>
<style>
  .image-task { padding: 20px; min-width: 0; color: var(--b3-theme-on-background); }
  h3 { margin: 0 0 8px; } header span { overflow-wrap: anywhere; color: var(--b3-theme-on-surface); }
  progress { width: 100%; height: 8px; margin: 20px 0; accent-color: var(--b3-theme-primary); }
  .metrics { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 12px; margin: 16px 0; }
  .metrics div { padding: 12px; border: 1px solid var(--b3-border-color); border-radius: 6px; }
  .metrics strong, .metrics span { display: block; }
  .metrics strong { font-size: 20px; font-variant-numeric: tabular-nums; }
  .metrics span, .note { color: var(--b3-theme-on-surface); font-size: 12px; margin-top: 6px; }
  .warning { color: var(--b3-theme-error); } .message { overflow-wrap: anywhere; }
  details { max-height: 200px; overflow: auto; margin: 12px 0; }
  @media (max-width: 480px) { .metrics { grid-template-columns: repeat(2,minmax(0,1fr)); } }
</style>
```

## 13.23 `ui-host.integration.ts`

SiYuan Dialog + Svelte 宿主容器；须在真实 SDK/框架版本下检查。

```typescript
/**
 * Compile this file in the actual SiYuan + Svelte 5 project.
 * Excluded from the dependency-free reference tsconfig, not claimed as integration-tested.
 */
import { Dialog, showMessage } from "siyuan";
import { mount, unmount, type Component } from "svelte";
import { Scope } from "./core.js";
import type { ImageUI } from "./controller.js";
import ImageTaskPanel from "./ImageTaskPanel.svelte";

export function mountDialog<P extends Record<string, any>>(
  scope: Scope, title: string, View: Component<P>, props: P, onClose: () => void,
): { close(): void } {
  let instance: ReturnType<typeof mount> | undefined;
  let closed = false;
  let release: () => void = () => {};
  const dialog = new Dialog({
    title, content: '<div class="omnikit-view-host"></div>',
    width: "min(900px, 94vw)",
    destroyCallback: () => {
      if (closed) return;
      closed = true; onClose();
      if (instance) void unmount(instance);
      release();
    },
  });
  instance = mount(View, { target: dialog.element.querySelector(".omnikit-view-host")!, props });
  release = scope.own(() => { if (!closed) dialog.destroy(); });
  return { close: release };
}
export function createImageUI(scope: Scope, t: (key: string) => string): ImageUI {
  return {
    notify(message) { if (scope.active) showMessage(message, 5000); },
    progress(state, cancel) {
      return mountDialog(scope, t("image.task.title"), ImageTaskPanel, { job: state, cancel, t }, cancel);
    },
    confirm(title, message, signal) {
      return new Promise<boolean>(resolve => {
        if (signal.aborted || !scope.active) { resolve(false); return; }
        let settled = false;
        let release: () => void = () => {};
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", cancel);
          resolve(value);
          dialog.destroy();
          release();
        };
        const cancel = () => finish(false);
        const dialog = new Dialog({
          title, content: '<div class="b3-dialog__content"><p class="omnikit-confirm-text"></p><div class="omnikit-confirm-actions"></div></div>',
          width: "min(640px, 94vw)", destroyCallback: cancel,
        });
        const paragraph = dialog.element.querySelector(".omnikit-confirm-text") as HTMLElement;
        paragraph.textContent = message; paragraph.style.whiteSpace = "pre-wrap";
        const actions = dialog.element.querySelector(".omnikit-confirm-actions")!;
        for (const [label, answer] of [[t("common.cancel"), false], [t("common.confirm"), true]] as const) {
          const button = document.createElement("button");
          button.className = "b3-button b3-button--outline";
          button.style.marginInlineEnd = "12px"; button.textContent = label;
          button.onclick = () => finish(answer); actions.append(button);
        }
        signal.addEventListener("abort", cancel, { once: true });
        release = scope.own(cancel);
      });
    },
    pickImage(name, signal) {
      return new Promise<File | undefined>(resolve => {
        if (signal.aborted || !scope.active) { resolve(undefined); return; }
        let settled = false;
        let release: () => void = () => {};
        const finish = (file?: File) => {
          if (settled) return;
          settled = true; signal.removeEventListener("abort", cancel);
          resolve(file); dialog.destroy(); release();
        };
        const cancel = () => finish();
        const dialog = new Dialog({
          title: t("sources.pickOriginal"), content: '<div class="b3-dialog__content"></div>',
          width: "min(560px, 94vw)", destroyCallback: cancel,
        });
        const host = dialog.element.querySelector(".b3-dialog__content")!;
        const label = document.createElement("label");
        label.textContent = `${t("sources.chooseMatchingFile")} ${name}`;
        const input = document.createElement("input");
        input.type = "file"; input.accept = "image/png,image/jpeg,image/webp";
        input.className = "b3-text-field"; input.style.display = "block"; input.style.marginTop = "16px";
        input.onchange = () => finish(input.files?.[0]);
        label.append(input); host.append(label);
        // A visible file input preserves the browser's user-activation requirement.
        signal.addEventListener("abort", cancel, { once: true });
        release = scope.own(cancel);
      });
    },
  };
}
```

## 13.24 `runtime.integration.ts`

实际环境装配示例。请注入 editor-context.ts 的 resolveEditor，并连接现有菜单，移除旧重复监听。

```typescript
/**
 * Integration seam; add to the existing ImageCompressorFeature.onEnable, not a second Plugin.
 * Keep the existing FeatureManager/BaseFeature/MenuRouter; provide these services to its actions.
 */
import imageCompression from "browser-image-compression";
import { getFrontend } from "siyuan";
import { Scope, MemoryBudget, type ConfigStore, type EventPort } from "./core.js";
import { defaults, parseConfig, type ImageConfig } from "./config.js";
import { HttpKernel, readData } from "./kernel.js";
import { createDesktopBridge } from "./desktop.js";
import { SourceReader } from "./download.js";
import { BicEncoder, type BicFunction } from "./image.js";
import { AssetStore, SingleOriginalFinalizer } from "./assets.js";
import { ReferenceService, type DocumentRow } from "./references.js";
import { ImageJobRunner, type PluginData } from "./jobs.js";
import { ImageController, type EditorContext } from "./controller.js";
import { installAutoUpload } from "./auto-upload.js";
import { watchRemoteImages } from "./remote-auto.js";
import { createImageUI } from "./ui-host.integration.js";
declare const require: ((name: string) => any) | undefined;

export interface RuntimeInput {
  plugin: PluginData & { name: string; eventBus: EventPort };
  store: ConfigStore<ImageConfig>;
  parentScope: { own(dispose: () => void): unknown; readonly signal: AbortSignal };
  t(key: string): string;
  // Existing MenuRouter supplies an authenticated editor context; no global ".protyle" fallback.
  resolveEditor(protyle: unknown): { element: HTMLElement; context: EditorContext } | undefined;
}
export async function createImageRuntime(input: RuntimeInput) {
  if (input.store.needsRecovery) throw new Error("Image configuration must be reset explicitly before enabling");
  const scope = new Scope();
  const cancel = () => scope.dispose();
  input.parentScope.own(cancel);
  input.parentScope.signal.addEventListener("abort", cancel, { once: true });
  scope.own(() => input.parentScope.signal.removeEventListener("abort", cancel));
  if (input.parentScope.signal.aborted) scope.dispose();
  const origin = location.origin;
  const kernel = new HttpKernel(origin);
  const ui = createImageUI(scope, input.t);
  const frontend = getFrontend();
  const mobile = frontend === "mobile" || frontend === "browser-mobile";
  let desktop;
  if ((frontend === "desktop" || frontend === "desktop-window") && typeof require === "function") {
    try {
      desktop = createDesktopBridge(require, path => ui.confirm(
        input.t("sources.localPermission"), path, scope.signal));
    } catch { /* isolated/browser renderer: explicit file-picker fallback */ }
  }
  const reader = new SourceReader(fetch, desktop);
  const budget = new MemoryBudget((mobile ? 192 : 512) * 1024 * 1024);
  const libraryURL = new URL(`/plugins/${encodeURIComponent(input.plugin.name)}/browser-image-compression.js`, origin).href;
  const encoder = new BicEncoder(imageCompression as BicFunction, libraryURL, budget);
  const assets = new AssetStore(kernel, origin);
  const references = new ReferenceService(kernel, origin);
  const runner = new ImageJobRunner(reader, encoder, assets, references, input.plugin, origin);
  let hostVersion = "unknown";
  try {
    const value = await readData<unknown>(kernel, "/api/system/version", {}, scope.signal);
    if (typeof value === "string") hostVersion = value;
  } catch { /* capabilities remain unknown, not falsely supported */ }
  const finalizer = new SingleOriginalFinalizer(kernel, hostVersion);
  const controller = new ImageController(kernel, origin, scope, () => parseConfig(input.store.snapshot()),
    runner, reader, finalizer, ui, !!desktop, mobile);

  // Even with a version hint, installAutoUpload validates the actual event contract.
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(hostVersion);
  const beforeUploadExpected = !!match && (
    +match[1] > 3 || +match[1] === 3 && (+match[2] > 8 || +match[2] === 8 && +match[3] >= 4));
  if (beforeUploadExpected) installAutoUpload({
    bus: input.plugin.eventBus, scope, config: () => parseConfig(input.store.snapshot()),
    reader, encoder, assets, origin, notice: ui.notify,
  });

  let suspended = false;
  const editors = new Map<HTMLElement, { context: EditorContext; child?: Scope; generation: number }>();
  const attach = (element: HTMLElement, context: EditorContext) => {
    const prior = editors.get(element);
    prior?.child?.dispose();
    const entry = { context, generation: (prior?.generation ?? 0) + 1, child: undefined as Scope | undefined };
    editors.set(element, entry);
    if (suspended || !scope.active || context.disabled || !input.store.snapshot().auto.remoteImages) return;
    const child = new Scope(); entry.child = child;
    const doc: DocumentRow = { id: context.rootID, root_id: context.rootID, box: context.notebook };
    void watchRemoteImages({ editor: element, document: doc, scope: child, kernel, jobs: runner,
      origin, mobile, config: () => parseConfig(input.store.snapshot()), notice: ui.notify })
      .then(dispose => { if (!scope.active || editors.get(element) !== entry) dispose(); else child.own(dispose); })
      .catch(() => { child.dispose(); });
  };
  const onEditor = (event: CustomEvent<any>) => {
    const resolved = input.resolveEditor(event.detail?.protyle);
    if (resolved) attach(resolved.element, resolved.context);
  };
  const listen = (name: string, fn: (event: CustomEvent<any>) => void) => {
    const guard = scope.guard(fn); input.plugin.eventBus.on(name, guard);
    scope.own(() => input.plugin.eventBus.off(name, guard));
  };
  for (const event of ["loaded-protyle-static", "switch-protyle"]) listen(event, onEditor);
  listen("destroy-protyle", event => {
    const resolved = input.resolveEditor(event.detail?.protyle);
    if (resolved) { editors.get(resolved.element)?.child?.dispose(); editors.delete(resolved.element); }
  });
  listen("sync-start", () => { suspended = true; for (const e of editors.values()) e.child?.dispose(); });
  listen("sync-end", () => { suspended = false; for (const [el, e] of [...editors]) attach(el, e.context); });
  listen("sync-fail", () => { suspended = false; for (const [el, e] of [...editors]) attach(el, e.context); });
  scope.own(input.store.subscribe(() => { for (const [el, e] of [...editors]) attach(el, e.context); }));
  scope.own(() => { for (const e of editors.values()) e.child?.dispose(); editors.clear(); });
  return {
    controller, runner, references, ui, hostVersion, desktopFiles: !!desktop,
    beforeUploadExpected,
    attachEditor: attach, // call for editors already open when the feature is enabled
    dispose: () => scope.dispose(),
  };
}
```

## 13.25 `i18n.zh-CN.json`



```json
{
  "settings.concurrentChange": "配置已在其他窗口改变。请先放弃本地草稿并重新载入，避免覆盖。",
  "settings.invalidDocument": "请输入并验证文档根块 ID。",
  "settings.configBlocked": "配置暂不可写",
  "settings.noMigration": "本版本只读取图片配置 schemaVersion 2，不转换或合并旧结构。",
  "settings.backupReset": "备份旧文件并重新初始化",
  "settings.disabledButEditable": "功能已停用；设置仍可编辑，重新启用后生效。",
  "settings.host": "思源版本",
  "settings.references": "引用处理",
  "settings.localRead": "本地文件读取",
  "settings.available": "可用",
  "settings.unavailable": "不可用",
  "settings.automation": "自动处理",
  "settings.automationHelp": "只处理新上传或新插入的图片，不回扫既有笔记。",
  "settings.global": "所有文档自动压缩",
  "settings.globalHelp": "关闭后仅在下方文档名单内自动处理；名单不会被清空。",
  "settings.uploads": "上传前压缩",
  "settings.uploadsHelp": "保持附件数量和顺序；失败项仍使用原文件。",
  "settings.remoteAuto": "新插入外链图片自动本地化",
  "settings.remoteHelp": "仅访问已授权域名；先确认图片引用已保存，再下载与替换。",
  "settings.quality": "画质与尺寸",
  "settings.qualityHelp": "输出 WebP。有损转换；文件没有明显变小时不替换。",
  "settings.initialQuality": "起始质量",
  "settings.notSimilarity": "不是相似度百分比；编码器可能在有限轮次内降低质量。",
  "settings.maxDimension": "最长边",
  "settings.dimensionHelp": "保持比例，不放大图片；原图像素过多时先拒绝解码。",
  "settings.exclusions": "额外排除扩展名",
  "settings.protectedFormats": "动画、SVG 和 Excalidraw 始终保护；移出名单不代表获得支持。",
  "settings.originals": "原图与数据安全",
  "settings.originalsHelp": "图片压缩、更新引用和清理原件是三个独立阶段。",
  "settings.deleteSingle": "单图成功后不保留工作区原图",
  "settings.deleteSingleHelp": "只适用于恰好一个文件的上传，或手动单图；已有资源还须通过引用与版本检查。",
  "settings.batchAlwaysKeeps": "文档批量始终保留原图，包括只有一张图的批量任务。",
  "settings.cleanupUnavailable": "当前宿主或引用模式不能证明清理安全；本机只保存该偏好，实际仍保留原图。",
  "settings.neverDeleteComputerFile": "不会删除电脑上的源文件，也不会删除网站上的文件。",
  "settings.sources": "来源与下载权限",
  "settings.sourcesHelp": "压缩在本机运行；下载外链仍会向目标服务器发送请求。",
  "settings.allowedOrigins": "允许自动访问的 HTTPS 来源",
  "settings.originHelp": "每行一个完整 origin，不含路径或通配符。例如 https://images.example.com。",
  "settings.localFiles": "读取桌面本地路径图片",
  "settings.localFilesHelp": "仍需文件读取授权；浏览器和移动端请通过文件选择器提供图片。",
  "settings.documents": "自动处理文档名单",
  "settings.documentsHelp": "全局开关关闭时，这些文档仍自动处理。",
  "settings.searchDocuments": "搜索文档标题或 ID",
  "settings.documentID": "文档根块 ID",
  "settings.add": "添加",
  "settings.remove": "移除",
  "settings.noDocuments": "没有匹配的文档。",
  "settings.advanced": "高级参数与兼容模式",
  "settings.minInput": "最小输入体积（字节）",
  "settings.minSavingBytes": "最少减少体积（字节）",
  "settings.maxInput": "最大输入体积（字节）",
  "settings.maxPixels": "最大输入像素数",
  "settings.maxTime": "单图编码时限（毫秒）",
  "settings.desktopConcurrency": "桌面并发",
  "settings.mobileConcurrency": "移动端并发",
  "settings.minSavingRatio": "最小体积减少比例（0–0.9）",
  "settings.referenceBackend": "引用更新方式",
  "settings.backendAuto": "原生优先，接口缺失时使用 SQL",
  "settings.backendSQL": "SQL 兼容模式（始终保留原图）",
  "settings.saving": "正在保存…",
  "settings.unsaved": "有未保存的修改",
  "settings.saved": "已保存",
  "settings.discardReload": "放弃草稿并载入",
  "settings.resetDraft": "恢复默认草稿",
  "settings.save": "保存设置",
  "task.preparing": "正在准备图片",
  "task.preview": "等待确认引用更新范围",
  "task.applying": "正在更新引用",
  "task.done": "处理完成",
  "task.partial": "部分完成，原图保留",
  "task.cancelled": "已停止后续处理",
  "task.failed": "处理失败，原图保留",
  "task.unknown": "部分操作结果尚未确认",
  "task.progress": "任务进度",
  "task.prepared": "已检查来源",
  "task.uploaded": "已上传压缩图",
  "task.skipped": "跳过",
  "task.failedItems": "准备失败",
  "task.backend": "引用处理方式",
  "task.referencesChanged": "已验证更新的引用",
  "task.storageChanged": "宿主更新记录数（不是图片数）",
  "task.unknownHelp": "不要直接重试写入。请先核对任务记录和当前引用；没有自动回滚或删除原图。",
  "task.cancelHelp": "取消会停止后续步骤；已经提交给思源的写入可能仍然完成，不等于撤销。",
  "task.details": "查看诊断信息",
  "task.cancel": "停止后续处理",
  "image.task.title": "图片处理任务",
  "common.cancel": "取消",
  "common.confirm": "确认",
  "sources.pickOriginal": "选择原图",
  "sources.chooseMatchingFile": "请选择对应的原文件：",
  "sources.localPermission": "允许读取这个本地文件？",
  "task.sqlCoverage": "SQL 兼容路径仅验证已索引普通文档中的支持引用；原图保留，不代表全工作区所有引用均已处理。",
  "settings.resetTitle": "备份旧配置并使用新版默认值？",
  "settings.resetDescription": "不会读取或迁移 schemaVersion 1 字段。先备份现有文件，再写入全新 schemaVersion 2 配置。"
}
```

## 13.26 `i18n.en.json`



```json
{
  "settings.concurrentChange": "Settings changed elsewhere. Discard this draft and reload before saving.",
  "settings.invalidDocument": "Enter a verified document root ID.",
  "settings.configBlocked": "Settings are read-only",
  "settings.noMigration": "This version accepts image schemaVersion 2 only; old structures are not migrated.",
  "settings.backupReset": "Back up and initialise new settings",
  "settings.disabledButEditable": "The feature is stopped. Settings remain editable and apply when enabled.",
  "settings.host": "SiYuan version",
  "settings.references": "References",
  "settings.localRead": "Local file access",
  "settings.available": "Available",
  "settings.unavailable": "Unavailable",
  "settings.automation": "Automation",
  "settings.automationHelp": "Process new uploads or inserted images; do not revisit existing notes.",
  "settings.global": "Enable automation in all documents",
  "settings.globalHelp": "When off, automation is limited to the document list; the list is retained.",
  "settings.uploads": "Compress before upload",
  "settings.uploadsHelp": "Preserve attachment count/order and retain original files on failure.",
  "settings.remoteAuto": "Localise newly inserted remote images",
  "settings.remoteHelp": "Use approved origins only and confirm the persisted reference before replacement.",
  "settings.quality": "Quality and dimensions",
  "settings.qualityHelp": "Output WebP using lossy conversion; skip replacements with insufficient savings.",
  "settings.initialQuality": "Initial quality",
  "settings.notSimilarity": "Not a similarity score; the encoder may lower quality over a bounded number of attempts.",
  "settings.maxDimension": "Maximum edge",
  "settings.dimensionHelp": "Preserve aspect ratio without upscaling; reject excessive source pixels before decoding.",
  "settings.exclusions": "Additional excluded extensions",
  "settings.protectedFormats": "Animation, SVG and Excalidraw remain protected regardless of this list.",
  "settings.originals": "Originals and data safety",
  "settings.originalsHelp": "Encoding, reference updates and original cleanup are separate stages.",
  "settings.deleteSingle": "Do not retain workspace originals after single-image success",
  "settings.deleteSingleHelp": "Only a one-file upload or a manual single-image action qualifies; existing assets need reference and host safety checks.",
  "settings.batchAlwaysKeeps": "Document jobs always retain originals, even when they contain only one image.",
  "settings.cleanupUnavailable": "Cleanup safety is not established for this host/backend. The preference is saved, but originals remain.",
  "settings.neverDeleteComputerFile": "Files on your computer and remote websites are never deleted.",
  "settings.sources": "Sources and download permissions",
  "settings.sourcesHelp": "Compression runs locally; downloading a remote image still contacts its server.",
  "settings.allowedOrigins": "Approved HTTPS origins for automation",
  "settings.originHelp": "One exact origin per line, with no path or wildcard, such as https://images.example.com.",
  "settings.localFiles": "Read desktop file-path images",
  "settings.localFilesHelp": "File access still requires consent; browser/mobile clients must select a file.",
  "settings.documents": "Automation document list",
  "settings.documentsHelp": "These documents retain automation when the global switch is off.",
  "settings.searchDocuments": "Search titles or IDs",
  "settings.documentID": "Document root ID",
  "settings.add": "Add",
  "settings.remove": "Remove",
  "settings.noDocuments": "No matching documents.",
  "settings.advanced": "Advanced options and compatibility",
  "settings.minInput": "Minimum input size (bytes)",
  "settings.minSavingBytes": "Minimum byte savings",
  "settings.maxInput": "Maximum input size (bytes)",
  "settings.maxPixels": "Maximum source pixels",
  "settings.maxTime": "Per-image encoding deadline (ms)",
  "settings.desktopConcurrency": "Desktop concurrency",
  "settings.mobileConcurrency": "Mobile concurrency",
  "settings.minSavingRatio": "Minimum savings ratio (0–0.9)",
  "settings.referenceBackend": "Reference backend",
  "settings.backendAuto": "Prefer native; use SQL when endpoints are absent",
  "settings.backendSQL": "SQL compatibility mode (retain originals)",
  "settings.saving": "Saving…",
  "settings.unsaved": "Unsaved changes",
  "settings.saved": "Saved",
  "settings.discardReload": "Discard draft and reload",
  "settings.resetDraft": "Reset draft to defaults",
  "settings.save": "Save settings",
  "task.preparing": "Preparing images",
  "task.preview": "Confirm reference scope",
  "task.applying": "Updating references",
  "task.done": "Completed",
  "task.partial": "Partially completed; originals retained",
  "task.cancelled": "Further work cancelled",
  "task.failed": "Failed; originals retained",
  "task.unknown": "Some operation results are unconfirmed",
  "task.progress": "Task progress",
  "task.prepared": "Sources checked",
  "task.uploaded": "Compressed assets uploaded",
  "task.skipped": "Skipped",
  "task.failedItems": "Preparation failures",
  "task.backend": "Reference backend",
  "task.referencesChanged": "Verified reference updates",
  "task.storageChanged": "Host records updated (not image count)",
  "task.unknownHelp": "Do not resend writes. Reconcile the journal and current references first; no automatic rollback or original deletion was performed.",
  "task.cancelHelp": "Cancel stops future steps. A write already submitted to SiYuan may still complete; cancellation is not undo.",
  "task.details": "Show diagnostics",
  "task.cancel": "Stop further work",
  "image.task.title": "Image processing",
  "common.cancel": "Cancel",
  "common.confirm": "Confirm",
  "sources.pickOriginal": "Select original image",
  "sources.chooseMatchingFile": "Select the matching original file:",
  "sources.localPermission": "Allow reading this local file?",
  "task.sqlCoverage": "SQL compatibility verifies supported references in indexed ordinary documents only; originals remain. This is not a full workspace reference guarantee.",
  "settings.resetTitle": "Back up old configuration and reset?",
  "settings.resetDescription": "SchemaVersion 1 fields will not be read or migrated. The existing file is backed up before a fresh schemaVersion 2 configuration is saved."
}
```

## 13.27 `tsconfig.json`

只检查依赖无关的核心；明确排除目标工程接线文件。

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"], "strict": true,
    "outDir": "./dist", "skipLibCheck": true, "noEmitOnError": true
  },
  "include": ["*.ts"], "exclude": ["*.integration.ts"]
}
```

## 13.28 `package.json`

独立参考测试包，不覆盖目标插件 package.json。

```json
{
  "name": "omnikit-image-v2-reference-tests",
  "private": true,
  "type": "module",
  "scripts": {
    "check": "tsc -p tsconfig.json",
    "test": "node --test tests.mjs"
  },
  "devDependencies": {
    "typescript": "5.8.3"
  }
}
```

## 13.29 `generate-fixtures.py`



```python
"""Generate deterministic test images. Requires Pillow, not used by the plugin."""
from pathlib import Path
from PIL import Image
import random

root = Path(__file__).resolve().parent / "fixtures"
root.mkdir(exist_ok=True)
rng = random.Random(42)
im = Image.frombytes("RGB", (128, 128), bytes(rng.randrange(256) for _ in range(128 * 128 * 3)))
im.save(root / "noise.png")
im.save(root / "noise.jpg", quality=90)
im.save(root / "noise.webp", quality=70)
im.convert("CMYK").save(root / "cmyk.jpg")
frames = [im.transpose(Image.Transpose.FLIP_LEFT_RIGHT)]
im.save(root / "animated.png", save_all=True, append_images=frames, duration=100, loop=0)
im.save(root / "animated.webp", save_all=True, append_images=frames, duration=100, loop=0)
```

## 13.30 `tests.mjs`

已运行的 Node 回归测试；编码器注入测试替身，不伪装成真实 BIC 基准。

```javascript
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { Scope, KeyedMutex, MemoryBudget, mapLimited } from "./dist/core.js";
import { defaults, parseConfig, retainOriginal, configFile, validateFeatureFiles, autoAllowed } from "./dist/config.js";
import { resolveSource, outputName } from "./dist/source.js";
import { HttpKernel, RequestError, unsupportedRead } from "./dist/kernel.js";
import { boundedResponse, SourceReader, requireRemotePermission } from "./dist/download.js";
import { inspectImage, BicEncoder } from "./dist/image.js";
import { scanIndexedDocuments, sqlLiteral, ReferenceService } from "./dist/references.js";
import { AssetStore, SingleOriginalFinalizer } from "./dist/assets.js";
import { installAutoUpload } from "./dist/auto-upload.js";
import { createDesktopBridge } from "./dist/desktop.js";
import { readRecoveryPatches } from "./dist/recovery.js";
import { createRequire } from "node:module";
import { ordinaryAssetLocations } from "./dist/asset-identity.js";

const origin = "http://127.0.0.1:6806", root = "20261112000000-aaaaaaa", box = "20261112000000-bbbbbbb";
const png = await fs.readFile(new URL("./fixtures/noise.png", import.meta.url));
const webp = await fs.readFile(new URL("./fixtures/noise.webp", import.meta.url));
const config = () => { const c=defaults(); c.auto.globalEnabled=true; return c; };
const ok = data => ({code:0,msg:"",data});
test("v2 defaults round trip", () => assert.deepEqual(parseConfig(defaults()),defaults()));
test("v1 is explicitly rejected", () => assert.throws(()=>parseConfig({...defaults(),schemaVersion:1})));
test("missing v2 fields are not compatibility-filled", () => {
  const c=defaults(); delete c.compression.minSavingBytes; assert.throws(()=>parseConfig(c));
});
test("non-integer concurrency is rejected", () => {
  const c=defaults(); c.compression.concurrencyDesktop=1.5; assert.throws(()=>parseConfig(c));
});
test("automatic origins require exact HTTPS origin", () => {
  const c=defaults(); c.sources.remoteOrigins=["https://example.org/images"]; assert.throws(()=>parseConfig(c));
});
test("core-derived feature filename preserves current image filename", () =>
  assert.equal(configFile("imageCompressor"),"feature-image-compressor.json"));
test("filename collisions fail fast", () => assert.throws(()=>validateFeatureFiles(["aBC","aBc"])));
test("global off means allowlist, not all-off", () => {
  const c=defaults(); assert.equal(autoAllowed(c,root),false);
  c.auto.pageAllowlist[root]={grantedAt:1,title:"a"}; assert.equal(autoAllowed(c,root),true);
});
for (const kind of ["document","remote-auto"]) for (const enabled of [false,true])
  test(`${kind}: retains originals when delete flag=${enabled}`, () => {
    const c=defaults(); c.retention.deleteSingleOriginal=enabled;
    assert.equal(retainOriginal({kind,rootID:root,blockID:root},c),true);
  });
test("multi-upload retention uses TOTAL original files", () => {
  const c=config(); c.retention.deleteSingleOriginal=true;
  assert.equal(retainOriginal({kind:"upload",rootID:root,originalInputCount:2},c),true);
  assert.equal(retainOriginal({kind:"upload",rootID:root,originalInputCount:1},c),false);
});
for (const value of ["assets/a.png","./assets/a.png","/assets/a.png",origin+"/assets/a.png","assets\\a.png"])
  test(`asset alias: ${value}`,()=>assert.equal(resolveSource(value,origin).key,"asset:assets/a.png"));
for (const value of ["assets/../a.png","assets/a%2Fb.png","assets/a%5Cb.png","assets/%2e%2e/a.png","javascript:alert(1)"])
  test(`refuse unsafe source: ${value}`,()=>assert.throws(()=>resolveSource(value,origin)));
test("Windows path is a file source, not an HTTP fetch",()=>assert.equal(resolveSource("C:\\images\\a.png",origin).fileURL,"file:///C:/images/a.png"));
test("file URL percent encoding is decoded only once by platform bridge",()=>{
  assert.equal(resolveSource("file:///tmp/a%2520.png",origin).fileURL,"file:///tmp/a%2520.png");
});
test("UNC reads disabled by default",()=>assert.throws(()=>resolveSource("\\\\server\\share\\a.png",origin)));
test("unknown asset transformation parameters are refused",()=>assert.throws(()=>resolveSource("assets/a.png?width=200",origin)));
test("readable output stem retained",()=>assert.equal(outputName("diagram-20261112000000-aaaaaaa.png"),"diagram-20261112000000-aaaaaaa.webp"));
test("remote query identity is not discarded",()=>assert.notEqual(resolveSource("https://example.org/a?x=1",origin).key,resolveSource("https://example.org/a?x=2",origin).key));
test("scope cancels synchronously and cleans late registrations",()=>{
  const s=new Scope(); let n=0; s.own(()=>n++); s.dispose(); s.own(()=>n++); s.dispose(); assert.equal(n,2);
});
test("mutex serialises writes",async()=>{
  const m=new KeyedMutex(), events=[];
  await Promise.all([1,2,3].map(i=>m.run("x",undefined,async()=>{events.push(i);await new Promise(r=>setTimeout(r,3));events.push(-i);})));
  assert.deepEqual(events,[1,-1,2,-2,3,-3]);
});
test("limited map waits for already-started work before rejecting",async()=>{
  let finished=false;
  await assert.rejects(mapLimited([0,1,2],2,undefined,async i=>{
    if(i===0){await new Promise(r=>setTimeout(r,2));throw Error("stop");}
    await new Promise(r=>setTimeout(r,10));finished=true;
  }));
  assert.equal(finished,true);
});
test("memory reservation releases after failure",async()=>{
  const b=new MemoryBudget(100);
  await assert.rejects(b.run(100,undefined,async()=>{throw Error("x");}));
  assert.equal(await b.run(100,undefined,async()=>7),7);
});
test("kernel write network failure is unknown, sent once",async()=>{
  let n=0; const k=new HttpKernel(origin,async()=>{n++;throw Error("network");});
  await assert.rejects(k.post("/api/block/updateBlock",{},"write"), e=>e.outcome==="unknown-write"); assert.equal(n,1);
});
test("HTTP read 404 allows fallback; write 404 does not",async()=>{
  const k=new HttpKernel(origin,async()=>new Response("",{status:404}));
  await assert.rejects(k.post("/api/asset/findAssetReferences",{},"read"),e=>unsupportedRead(e));
  await assert.rejects(k.post("/api/asset/relinkAsset",{},"write"),e=>!unsupportedRead(e)&&e.outcome==="unknown-write");
});
test("permission error does not allow fallback",()=>assert.equal(unsupportedRead(new RequestError("denied","read-failed",403)),false));
test("native error payload is preserved",async()=>{
  const k=new HttpKernel(origin,async()=>Response.json({code:-1,msg:"partial",data:{updated:1}}));
  assert.equal((await k.post("/api/asset/relinkAsset",{},"write")).data.updated,1);
});
test("SQL literal escaping does not emit second statement",()=>assert.equal(sqlLiteral("a'b"),"'a''b'"));
test("SQL pagination continues after short host-limited pages",async()=>{
  const rows=[{id:root,root_id:root,box},{id:"20261112000001-aaaaaaa",root_id:"20261112000001-aaaaaaa",box}]; let calls=0;
  const k={post:async(_p,b)=>{assert.equal(b.mode,"readonly");calls++;return ok(rows.length?[rows.shift()]:[]);}};
  assert.equal((await scanIndexedDocuments(k,20)).length,2);assert.equal(calls,3);
});
test("short SQL page must still advance cursor",async()=>{
  const k={post:async()=>ok([{id:root,root_id:root,box}])};
  await assert.rejects(scanIndexedDocuments(k,20),/unordered/);
});
test("stream byte limit works without content-length",async()=>{
  await assert.rejects(boundedResponse(new Response(new Uint8Array(20)),10),/byte limit/);
});
test("provided File permits manual browser path source",async()=>{
  const s=resolveSource("file:///tmp/a.png",origin), f=new File([png],"a.png",{type:"image/png"});
  const r=new SourceReader(async()=>{throw Error("unexpected network");});
  const value=await r.read(s,{maxBytes:1e6,timeoutMs:1000,allowedOrigins:new Set(),providedFiles:new Map([[s.key,f]])});
  assert.equal(value.blob,f);
});
test("remote allowlist rejects localhost and literal addresses",()=>{
  for (const u of ["http://localhost/a","http://127.0.0.1/a","http://[::1]/a"]) assert.throws(()=>requireRemotePermission(u,new Set([new URL(u).origin])));
});
test("PNG/JPEG/WebP dimensions inspected from real fixtures",async()=>{
  for (const name of ["noise.png","noise.jpg","noise.webp"]) {
    const info=inspectImage(await fs.readFile(new URL("./fixtures/"+name,import.meta.url)));
    assert.equal(info.width,128);assert.equal(info.height,128);assert.equal(info.animated,false);
  }
});
test("APNG and animated WebP are detected",async()=>{
  for (const name of ["animated.png","animated.webp"]) assert.equal(inspectImage(await fs.readFile(new URL("./fixtures/"+name,import.meta.url))).animated,true);
});
test("CMYK JPEG protected",async()=>{const bytes=await fs.readFile(new URL("./fixtures/cmyk.jpg",import.meta.url));assert.throws(()=>inspectImage(bytes),/colour/);});
test("truncated PNG refused",()=>assert.throws(()=>inspectImage(png.subarray(0,30))));
test("encoder uses WebP/Worker and validates output savings",async()=>{
  let options; const c=config();c.compression.minInputBytes=0;c.compression.minSavingBytes=1;
  const e=new BicEncoder(async(_f,o)=>{options=o;return new Blob([webp],{type:"image/webp"});},
    origin+"/plugins/p/browser-image-compression.js",new MemoryBudget(32e6),async()=>({width:128,height:128}));
  const r=await e.encode(new Blob([png],{type:"image/png"}),"a.png",c);
  assert.equal(r.kind,"encoded");assert.equal(r.value.file.name,"a.webp");assert.equal(options.useWebWorker,true);assert.equal(options.maxIteration,3);
});
test("encoder refuses fake WebP MIME with PNG bytes",async()=>{
  const c=config();c.compression.minInputBytes=0;
  const e=new BicEncoder(async()=>new Blob([png],{type:"image/webp"}),"local",new MemoryBudget(32e6),async()=>({width:128,height:128}));
  await assert.rejects(e.encode(new Blob([png],{type:"image/png"}),"a.png",c),/signature mismatch/);
});
test("single cleanup refuses document intent before ANY API request",async()=>{
  const finalizer=new SingleOriginalFinalizer({post:async()=>{throw Error("must not call");}},"3.8.9");
  const c=config();c.retention.deleteSingleOriginal=true;
  const r=await finalizer.finish({kind:"document",rootID:root},c,resolveSource("assets/a.png",origin),"assets/a.webp",
    {backend:"native",state:"verified",cleanupEligible:true},async()=>true);
  assert.equal(r.status,"retained");
});
test("SQL cleanup stays disabled despite zero old refs",async()=>{
  const finalizer=new SingleOriginalFinalizer({post:async()=>{throw Error("must not call");}},"3.8.9");
  const c=config();c.retention.deleteSingleOriginal=true;
  const r=await finalizer.finish({kind:"manual-single",rootID:root},c,resolveSource("assets/a.png",origin),"assets/a.webp",
    {backend:"sql",state:"verified",cleanupEligible:false},async()=>true);
  assert.equal(r.status,"retained");
});
test("legacy single upload maps by exact original filename",async()=>{
  const a=new AssetStore({post:async()=>ok({succMap:{"a.webp":"assets/a-x.webp"}})},origin);
  assert.equal(await a.upload(new File(["x"],"a.webp"),root),"assets/a-x.webp");
});
test("wrong upload index is outcome unknown, never guessed",async()=>{
  const a=new AssetStore({post:async()=>ok({succFiles:[{index:2,path:"assets/a.webp"}]})},origin);
  await assert.rejects(a.upload(new File(["x"],"a.webp"),root),e=>e.outcome==="unknown-write");
});
test("recovery rejects a native plan rather than inversing mappings",()=>assert.throws(()=>readRecoveryPatches({backend:"native"})));
test("desktop reader uses read-only file access with explicit consent",async()=>{
  const path=new URL("./fixtures/noise.png",import.meta.url); let asked=0;
  const bridge=createDesktopBridge(createRequire(import.meta.url),async()=>{asked++;return true;});
  const value=await bridge.readFile(path.href,{maxBytes:1e6,timeoutMs:1000,allowedOrigins:new Set()});
  assert.equal(value.blob.size,png.length);assert.equal(asked,1);
});
test("desktop permission denial prevents reading",async()=>{
  const bridge=createDesktopBridge(createRequire(import.meta.url),async()=>false);
  await assert.rejects(bridge.readFile(new URL("./fixtures/noise.png",import.meta.url).href,
    {maxBytes:1e6,timeoutMs:1000,allowedOrigins:new Set()}),/authorised/);
});

async function uploadCase(input, options={}) {
  let listener, promise, complete, archives=0, notified=[];
  const scope=new Scope(), c=config();c.retention.deleteSingleOriginal=options.delete??false;
  const bus={on:(_n,f)=>{listener=f;},off:()=>{}};
  const assets={archive:async()=>{archives++;if(options.archiveFail)throw new Error("archive");return "assets/original.png";}};
  const reader={read:async source=>({blob:new Blob([png]),name:source.name})};
  const encoder={encode:async(_blob,name)=>({kind:"encoded",value:{file:new File([webp],outputName(name),{type:"image/webp"})}})};
  installAutoUpload({bus,scope,config:()=>c,reader,encoder,assets,origin,notice:m=>notified.push(m)});
  listener({detail:{requestId:"r1",target:"editor",source:"drop",protyle:{block:{rootID:root}},
    input,signal:scope.signal,requiredFileCount:input.files.length,allowedInputKinds:["files","local-files"],
    respondWith:p=>{promise=p;},onComplete:f=>{complete=f;}}});
  assert.ok(promise,"respondWith must be called synchronously");
  const result=await promise;
  return {result,archives,complete,notified,scope};
}
test("multi-file upload preserves count/order and archives despite delete flag",async()=>{
  const a=new File([png],"a.png",{type:"image/png"}),txt=new File(["text"],"b.txt");
  const r=await uploadCase({kind:"files",files:[a,txt]},{delete:true});
  assert.equal(r.result.action,"replace");assert.equal(r.result.input.files.length,2);
  assert.equal(r.result.input.files[0].name,"a.webp");assert.equal(r.result.input.files[1],txt);assert.equal(r.archives,1);r.scope.dispose();
});
test("one-file opt-out avoids needless original upload",async()=>{
  const r=await uploadCase({kind:"files",files:[new File([png],"a.png",{type:"image/png"})]},{delete:true});
  assert.equal(r.archives,0);r.scope.dispose();
});
test("local-files materialises ordered Files",async()=>{
  const r=await uploadCase({kind:"local-files",files:[{path:"C:\\a.png",size:png.length},{path:"C:\\b.png",size:png.length}]});
  assert.deepEqual(r.result.input.files.map(f=>f.name),["a.webp","b.webp"]);assert.equal(r.archives,2);r.scope.dispose();
});
test("archive failure restores original File, no nonexistent continue decision",async()=>{
  const original={kind:"files",files:[new File([png],"a.png",{type:"image/png"})]};
  const r=await uploadCase(original,{archiveFail:true});
  assert.equal(r.result.action,"replace");assert.equal(r.result.input,original);r.scope.dispose();
});
test("completion indices refer to acceptedInput, not originalInput",async()=>{
  const a=new File([png],"a.png",{type:"image/png"}),txt=new File(["text"],"b.txt");
  const r=await uploadCase({kind:"files",files:[txt,a]});
  const compressed=r.result.input.files[1];
  r.complete({requestId:"r1",status:"partial",input:r.result.input,acceptedInput:{kind:"files",files:[compressed]},
    succFiles:[{index:0,name:compressed.name,path:"assets/a.webp"}]});
  assert.match(r.notified[0],/confirmed compressed files: 1/);r.scope.dispose();
});

function cleanupFixture(duplicate=false, timeout=false) {
  const calls=[];
  const k={post:async(p,b,m)=>{
    calls.push({p,b,m});
    if(p.endsWith("findAssetReferences"))return ok({items:[{oldPath:"assets/a.png",newPath:"",ok:true,reason:"",references:[],updated:0}],
      references:[],skippedNotebooks:[],dryRun:true,historyPath:"",updated:0});
    if(p.endsWith("getUnusedAssets"))return ok(duplicate
      ? [{item:"assets/a.png"},{item:box+"/assets/a.png"}]:[{item:"assets/a.png"}]);
    if(p.endsWith("removeUnusedAsset")){
      if(timeout)throw new RequestError("timeout","unknown-write");
      return ok({path:"/workspace/data/assets/a.png"});
    }
    throw Error("unexpected request");
  }};
  return {calls,k};
}
test("audited native single-image cleanup uses kernel-issued unused path",async()=>{
  const f=cleanupFixture(),finalizer=new SingleOriginalFinalizer(f.k,"3.8.9");
  const c=config();c.retention.deleteSingleOriginal=true;
  const r=await finalizer.finish({kind:"manual-single",rootID:root},c,resolveSource("assets/a.png",origin),"assets/a.webp",
    {backend:"native",state:"verified",cleanupEligible:true},async()=>true);
  assert.equal(r.status,"removed-from-live-assets");
  assert.deepEqual(f.calls.at(-1).b,{path:"assets/a.png"});
});
test("duplicate physical assets prevent cleanup",async()=>{
  const f=cleanupFixture(true),finalizer=new SingleOriginalFinalizer(f.k,"3.8.9");
  const c=config();c.retention.deleteSingleOriginal=true;
  const r=await finalizer.finish({kind:"manual-single",rootID:root},c,resolveSource("assets/a.png",origin),"assets/a.webp",
    {backend:"native",state:"verified",cleanupEligible:true},async()=>true);
  assert.equal(r.status,"retained");assert.equal(f.calls.length,2);
});
test("cleanup timeout is unknown and never resent",async()=>{
  const f=cleanupFixture(false,true),finalizer=new SingleOriginalFinalizer(f.k,"3.8.9");
  const c=config();c.retention.deleteSingleOriginal=true;
  const r=await finalizer.finish({kind:"manual-single",rootID:root},c,resolveSource("assets/a.png",origin),"assets/a.webp",
    {backend:"native",state:"verified",cleanupEligible:true},async()=>true);
  assert.equal(r.status,"unknown");assert.equal(f.calls.filter(c=>c.p.endsWith("removeUnusedAsset")).length,1);
});

test("legacy identity refuses equal resource names in two directories",async()=>{
  const k={post:async(p,b)=>{
    if(p.endsWith("lsNotebooks"))return ok({notebooks:[{id:box,closed:false}]});
    const lists={
      "/data":[{name:"assets",isDir:true},{name:box,isDir:true}],
      ["/data/"+box]:[{name:"assets",isDir:true}],
      "/data/assets":[{name:"a.png",isDir:false}],
      ["/data/"+box+"/assets"]:[{name:"a.png",isDir:false}],
    };
    return ok(lists[b.path].map(e=>({...e,isSymlink:false})));
  }};
  await assert.rejects(ordinaryAssetLocations(k,["assets/a.png"]),/ambiguous/);
});
test("legacy identity refuses unknown symlink metadata",async()=>{
  const k={post:async p=>p.endsWith("lsNotebooks")?ok({notebooks:[]}):ok([{name:"assets",isDir:true}])};
  await assert.rejects(ordinaryAssetLocations(k,["assets/a.png"]),/entry/);
});
```

## 13.31 `browser-tests.mjs`

已运行的独立 Chromium DOM/SQL mock 测试；不替代思源 Lute 往返与实机测试。

```javascript
import { scanDOM, buildBlockPatch, patchWasApplied } from "./dist/dom.js";
import { ReferenceService } from "./dist/references.js";
import { RequestError } from "./dist/kernel.js";
import { restoreSQLPlan, inspectRecovery } from "./dist/recovery.js";
import { verifyBitmap } from "./dist/image.js";
const O="http://127.0.0.1:6806";
const A="20261112000000-aaaaaaa",B="20261112000001-aaaaaaa",X="20261112000002-aaaaaaa",Y="20261112000003-aaaaaaa",BOX="20261112000004-aaaaaaa";
const results=[];
const eq=(a,b)=>{if(JSON.stringify(a)!==JSON.stringify(b))throw Error(JSON.stringify({actual:a,expected:b}));};
const yes=x=>{if(!x)throw Error("assertion failed");};
const throws=f=>{let thrown=false;try{f();}catch{thrown=true;}yes(thrown);};
const block=(id,inner)=>`<div data-node-id="${id}" data-type="NodeParagraph"><div contenteditable="true">${inner}</div></div>`;
const mapping={key:"asset:assets/a.png",oldPath:"assets/a.png",newPath:"assets/a.webp"};
async function t(name,fn){try{await fn();results.push({name,ok:true});}catch(e){results.push({name,ok:false,error:String(e)});}}
await t("custom-src is not src",()=>{
  eq(scanDOM(block(X,'<img custom-src="assets/a.png">'),O).length,0);
});
await t("preserves unrelated thumbnail while updating data-src",()=>{
  const patch=buildBlockPatch(block(X,'<img data-src="assets/a.png" src="assets/thumb.png" alt="图示">'),X,A,BOX,[mapping],O);
  yes(patch.after.includes('data-src="assets/a.webp"'));yes(patch.after.includes('src="assets/thumb.png"'));
});
await t("same source src and data-src are both updated",()=>{
  const patch=buildBlockPatch(block(X,'<img data-src="assets/a.png" src="/assets/a.png">'),X,A,BOX,[mapping],O);
  yes(patch.after.includes('data-src="assets/a.webp" src="assets/a.webp"'));
});
await t("Unicode, HTML entities, alt/title/style survive",()=>{
  const patch=buildBlockPatch(block(X,'😀<img src="assets/a.png" alt="A &amp; B" title="注释" style="width: 50%;">'),X,A,BOX,[mapping],O);
  for(const text of ["😀","A &amp; B",'title="注释"',"width: 50%"])yes(patch.after.includes(text));
});
await t("code blocks ignored",()=>{
  eq(scanDOM(`<div data-node-id="${X}" data-type="NodeCodeBlock"><img src="assets/a.png"></div>`,O).length,0);
});
await t("nearest owner avoids counting parent image twice",()=>{
  const list=scanDOM(`<div data-node-id="${A}">${block(X,'<img src="assets/a.png">')}</div>`,O);
  eq(list.map(x=>x.blockID),[X]);
});
await t("parent container rewriting rejected",()=>{
  throws(()=>buildBlockPatch(`<div data-node-id="${A}">${block(X,'<img src="assets/a.png">')}</div>`,A,A,BOX,[mapping],O));
});
await t("image plus ordinary link are rewritten once per occurrence",()=>{
  const p=buildBlockPatch(block(X,'<img src="assets/a.png"><span data-type="a" data-href="assets/a.png">链接</span>'),X,A,BOX,[mapping],O);
  eq(p.changes,2);yes(patchWasApplied(p.after,p,O));
});
await t("explicit selected image indices do not update link or other images",()=>{
  const p=buildBlockPatch(block(X,'<img src="assets/a.png"><img src="assets/a.png"><a href="assets/a.png">x</a>'),X,A,BOX,
    [{...mapping,selection:{blockID:X,expectedCount:2,imageIndices:[0]}}],O);
  eq(p.changes,1);yes(patchWasApplied(p.after,p,O));eq(scanDOM(p.after,O).filter(r=>r.key===mapping.key).length,2);
});
await t("selected occurrence count conflict refused",()=>{
  throws(()=>buildBlockPatch(block(X,'<img src="assets/a.png">'),X,A,BOX,
    [{...mapping,selection:{blockID:X,expectedCount:2,imageIndices:[1]}}],O));
});
await t("raw remote URL query preserved in source identity",()=>{
  const refs=scanDOM(block(X,'<img src="https://example.org/image?x=1&amp;y=2">'),O);
  eq(refs[0].key,"remote:https://example.org/image?x=1&y=2");
});
await t("untrusted inline markup remains inert",()=>{
  window.__badImage=0;
  scanDOM(block(X,'<img src="assets/a.png" onerror="window.__badImage++"><script>window.__badImage++</script>'),O);
  eq(window.__badImage,0);
});
function fixture() {
  const data=new Map([[X,block(X,'<img src="assets/a.png"><a href="assets/a.png">shared</a>')],
    [Y,block(Y,'<img src="assets/a.png">')]]);
  const docs=[{id:A,root_id:A,box:BOX},{id:B,root_id:B,box:BOX}];
  const calls=[];
  const k={post:async(path,body,mode)=>{
    calls.push({path,body,mode});
    if(path==="/api/asset/findAssetReferences")throw new RequestError("missing","read-failed",404);
    if(path==="/api/notebook/lsNotebooks")return {code:0,msg:"",data:{notebooks:[{id:BOX,closed:false}]}};
    if(path==="/api/file/readDir"){
      const entries=body.path==="/data"?[{name:"assets",isDir:true},{name:BOX,isDir:true}]
        :body.path==="/data/assets"?[{name:"a.png",isDir:false},{name:"a.webp",isDir:false}]:[];
      return {code:0,msg:"",data:entries.map(e=>({...e,isSymlink:false}))};
    }
    if(path==="/api/query/sql"){
      const cursor=/id > '([^']*)'/.exec(body.stmt)?.[1]??"";
      return {code:0,msg:"",data:docs.filter(d=>d.id>cursor).slice(0,1)};
    }
    if(path==="/api/block/getBlockDOM"){
      let dom=data.get(body.id);
      if(body.id===A)dom=`<div data-node-id="${A}" data-type="NodeDocument">${data.get(X)}</div>`;
      if(body.id===B)dom=`<div data-node-id="${B}" data-type="NodeDocument">${data.get(Y)}</div>`;
      return {code:0,msg:"",data:{id:body.id,dom}};
    }
    if(path==="/api/block/updateBlock"){data.set(body.id,body.data);return {code:0,msg:"",data:[]};}
    throw Error("Unexpected API "+path);
  }};
  const journal={beforeCommit:async()=>{},blockState:async()=>{}};
  return {k,data,docs,calls,journal};
}
await t("404 -> SQL scans both documents and updates shared refs",async()=>{
  const f=fixture(), s=new ReferenceService(f.k,O);
  const plan=await s.plan([mapping],f.docs[0],10);
  eq(plan.backend,"sql");eq(plan.patches.length,2);
  const result=await s.commit(plan,f.journal);
  eq(result.state,"verified");eq(result.referencesChanged,3);eq(result.cleanupEligible,false);
  eq(f.calls.filter(c=>c.path==="/api/block/updateBlock").length,2);
  yes(f.calls.filter(c=>c.path==="/api/query/sql").every(c=>c.body.mode==="readonly"));
});
await t("SQL conflict doesn't overwrite user edit",async()=>{
  const f=fixture(),s=new ReferenceService(f.k,O),plan=await s.plan([mapping],f.docs[0],10);
  const edited=block(X,'user added text <img src="assets/a.png">');f.data.set(X,edited);
  const result=await s.commit(plan,f.journal);eq(result.state,"partial");eq(f.data.get(X),edited);
  eq(result.conflictBlocks,[X]);
});
await t("SQL write timeout is not retried",async()=>{
  const f=fixture();let writes=0;
  const original=f.k.post;f.k.post=async(p,b,m)=>{
    if(p==="/api/block/updateBlock"){writes++;throw new RequestError("timeout","unknown-write");}
    return original(p,b,m);
  };
  const s=new ReferenceService(f.k,O),plan=await s.plan([mapping],f.docs[0],10),r=await s.commit(plan,f.journal);
  eq(r.state,"unknown");eq(writes,1);
});
await t("403 native scan cannot silently downgrade",async()=>{
  let sql=0;
  const s=new ReferenceService({post:async p=>{if(p==="/api/query/sql")sql++;throw new RequestError("denied","read-failed",403);}},O);
  let failed=false;try{await s.plan([mapping],{id:A,root_id:A,box:BOX},10);}catch{failed=true;}
  yes(failed);eq(sql,0);
});
function nativeData(m,dryRun,lookup=false) {
  const ref={type:"image",rootID:A,blockID:X,relinkable:true,reason:"",reference:"assets/a.png",replacement:"assets/a.webp"};
  return {items:[{oldPath:m.oldPath,newPath:lookup?"":m.newPath,ok:true,reason:"",references:[ref],updated:dryRun?0:1}],
    references:[ref],skippedNotebooks:[],unavailableAttributeViews:[],dryRun,historyPath:"",updated:dryRun?0:1};
}
await t("native write 404 does not initiate SQL fallback",async()=>{
  let sql=0,writes=0;
  const k={post:async(p,b,m)=>{
    if(p==="/api/query/sql"){sql++;throw Error("bad");}
    if(p==="/api/asset/findAssetReferences")return {code:0,msg:"",data:nativeData(mapping,true,true)};
    if(b.dryRun)return {code:0,msg:"",data:nativeData(mapping,true)};
    writes++;throw new RequestError("HTTP404","unknown-write",404);
  }};
  const s=new ReferenceService(k,O),plan=await s.plan([mapping],{id:A,root_id:A,box:BOX},10);
  const r=await s.commit(plan,{beforeCommit:async()=>{},blockState:async()=>{}});
  eq(r.state,"unknown");eq(sql,0);eq(writes,1);
});
await t("conditional SQL recovery refuses changed block and restores unchanged after image",async()=>{
  const f=fixture(),s=new ReferenceService(f.k,O),plan=await s.plan([mapping],f.docs[0],10);
  await s.commit(plan,f.journal);f.data.set(Y,block(Y,'new user content<img src="assets/a.webp">'));
  const check=await inspectRecovery(f.k,plan);eq(check.find(r=>r.id===Y).state,"conflict");
  const result=await restoreSQLPlan(f.k,s,plan,async()=>true,async()=>{});
  eq(result[X],"restored");eq(result[Y],"conflict");eq(f.data.get(X),plan.patches[0].before);
});
await t("real browser decoder validates generated WebP fixture",async()=>{
  const blob=await (await fetch("./fixtures/noise.webp")).blob();
  eq(await verifyBitmap(blob),{width:128,height:128});
});
window.__testResults=results;
console.log(JSON.stringify(results));
```

## 13.32 `run-browser-tests.py`



```python
"""Run isolated browser tests in memory; no network or SiYuan instance is required.
Requires Python playwright plus an installed Chromium (CHROMIUM env can override).
First run:
  tsc -p tsconfig.json --module commonjs --moduleResolution node --outDir browser-dist
"""
from pathlib import Path
from playwright.sync_api import sync_playwright
import json
import os
import re

root = Path(__file__).resolve().parent
modules = {p.name: p.read_text() for p in (root / "browser-dist").glob("*.js")}
if not modules:
    raise SystemExit("Compile browser-dist first")
tests = (root / "browser-tests.mjs").read_text()
tests = re.sub(r'import \{(.*?)\} from "\./dist/(.*?)";', r'const {\1}=req("\2");', tests)
tests = tests.replace('const blob=await (await fetch("./fixtures/noise.webp")).blob();',
    'const blob=new Blob([new Uint8Array(__webpBytes)],{type:"image/webp"});')
runner = r"""async ({modules, bytes, tests}) => {
  const cache={};
  const req=(id)=>{
    id=id.replace(/^.*\//,"");
    if(cache[id]) return cache[id].exports;
    const mod={exports:{}}; cache[id]=mod;
    new Function("require","exports","module",modules[id])(req,mod.exports,mod);
    return mod.exports;
  };
  await new Function("req","__webpBytes","return (async()=>{"+tests+"})()")(req,bytes);
  return window.__testResults;
}"""
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM", "/usr/bin/chromium"),
        headless=True, args=["--no-sandbox"])
    page = browser.new_page()
    page.set_content('<!doctype html><meta charset="utf-8"><body></body>')
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    results = page.evaluate(runner, {"modules": modules,
        "bytes": list((root / "fixtures/noise.webp").read_bytes()), "tests": tests})
    report = {"passed": sum(r["ok"] for r in results), "total": len(results),
        "pageErrors": errors, "results": results}
    (root / "browser-tests.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    browser.close()
    if report["passed"] != report["total"] or errors:
        raise SystemExit(1)
```

# 14. 固定版本证据索引

版本和源码行为以这里的固定标签/SHA为依据；库的维护快照来自上一版同日调研，本轮未把 Star 当作性能证据。代码是本报告新写的参考实现，不是直接复制宿主内核代码。

- **O01** — [OmniKit 固定 SHA：local-files 跳过逻辑](https://github.com/Forgo7ten/siyuan-plugin-omnikit/blob/f178de06b9233e1e2968b8f18bd224d4d5939266/src/features/image-compressor/AutoUploadHandler.ts)
- **O02** — [OmniKit 固定 SHA：旧资源路径入口](https://github.com/Forgo7ten/siyuan-plugin-omnikit/blob/f178de06b9233e1e2968b8f18bd224d4d5939266/src/features/image-compressor/OriginalAssetURL.ts)
- **O03** — [OmniKit 固定 SHA：现有编码调用](https://github.com/Forgo7ten/siyuan-plugin-omnikit/blob/f178de06b9233e1e2968b8f18bd224d4d5939266/src/features/image-compressor/ImageCompressorService.ts)
- **H01** — [SiYuan v3.8.3 资源路由：无引用查找/重链接路由](https://github.com/siyuan-note/siyuan/blob/v3.8.3/kernel/api/router.go#L360-L401)
- **H02** — [SiYuan v3.8.4：数组查引用/重链接、dryRun 和部分错误结果](https://github.com/siyuan-note/siyuan/blob/v3.8.4/kernel/api/asset_relink.go)
- **H03** — [SiYuan v3.8.9：引用响应结构](https://github.com/siyuan-note/siyuan/blob/v3.8.9/kernel/apicontract/asset_relink.go)
- **H04** — [SiYuan v3.8.9：预检、按文件备份、计数及条件写入](https://github.com/siyuan-note/siyuan/blob/v3.8.9/kernel/model/asset_relink_batch.go)
- **H05** — [SiYuan v3.8.9：资源清理、未引用判定与历史](https://github.com/siyuan-note/siyuan/blob/v3.8.9/kernel/model/assets.go)
- **H06** — [SiYuan v3.8.9：清理锁、引用源摘要和恢复](https://github.com/siyuan-note/siyuan/blob/v3.8.9/kernel/model/assets_cleanup.go)
- **H07** — [petal 固定 SHA：上传输入、决策、acceptedInput 与 succFiles](https://github.com/siyuan-note/petal/blob/7fb419fb94923618c71c93a15fd0a5321db27839/types/index.d.ts)
- **H08** — [SiYuan v3.8.0：readonly SQL 与搜索数量限制](https://github.com/siyuan-note/siyuan/blob/v3.8.0/kernel/api/sql.go)
- **H09** — [SiYuan v3.8.0：readDir 的路径边界和条目结构](https://github.com/siyuan-note/siyuan/blob/v3.8.0/kernel/api/file.go#L560-L644)
- **H10** — [SiYuan v3.8.9：custom-data-assets 前缀的引用扫描](https://github.com/siyuan-note/siyuan/blob/v3.8.9/kernel/model/assets.go)
- **H11** — [SiYuan v3.8.9：新资源 ID 命名与按名称去重规则](https://github.com/siyuan-note/siyuan/blob/v3.8.9/kernel/model/upload.go)
- **H12** — [SiYuan v3.8.9：更新块协议与 lockType](https://github.com/siyuan-note/siyuan/blob/v3.8.9/docs/API.zh-CN.md)
- **H13** — [petal 固定 SHA：上传前事件、完成回调不代表正文提交](https://github.com/siyuan-note/petal/blob/7fb419fb94923618c71c93a15fd0a5321db27839/siyuan.d.ts)
- **L01** — [BIC v2.0.2：初始质量、尺寸与迭代算法](https://github.com/Donaldcwl/browser-image-compression/blob/v2.0.2/lib/image-compression.js)
- **L02** — [BIC v2.0.2：PNG 量化与 Canvas 导出分支](https://github.com/Donaldcwl/browser-image-compression/blob/v2.0.2/lib/utils.js#L250-L294)
- **L03** — [Compressor.js v1.4.0：Image/DOM 运行模型](https://github.com/fengyuanchen/compressorjs/blob/v1.4.0/src/index.js)
- **L04** — [Compressor.js v1.4.0：选项、strict 例外、EXIF 和 abort](https://github.com/fengyuanchen/compressorjs/blob/v1.4.0/README.md)
- **L05** — [Compressor.js v1.4.0 发布记录](https://github.com/fengyuanchen/compressorjs/releases/tag/v1.4.0)
- **L06** — [jSquash 官方项目：浏览器/Worker codec](https://github.com/jamsinclair/jSquash)
- **L07** — [sharp 官方安装与运行环境](https://sharp.pixelplumbing.com/install/)

[O01]: https://github.com/Forgo7ten/siyuan-plugin-omnikit/blob/f178de06b9233e1e2968b8f18bd224d4d5939266/src/features/image-compressor/AutoUploadHandler.ts
[O02]: https://github.com/Forgo7ten/siyuan-plugin-omnikit/blob/f178de06b9233e1e2968b8f18bd224d4d5939266/src/features/image-compressor/OriginalAssetURL.ts
[O03]: https://github.com/Forgo7ten/siyuan-plugin-omnikit/blob/f178de06b9233e1e2968b8f18bd224d4d5939266/src/features/image-compressor/ImageCompressorService.ts
[H01]: https://github.com/siyuan-note/siyuan/blob/v3.8.3/kernel/api/router.go#L360-L401
[H02]: https://github.com/siyuan-note/siyuan/blob/v3.8.4/kernel/api/asset_relink.go
[H03]: https://github.com/siyuan-note/siyuan/blob/v3.8.9/kernel/apicontract/asset_relink.go
[H04]: https://github.com/siyuan-note/siyuan/blob/v3.8.9/kernel/model/asset_relink_batch.go
[H05]: https://github.com/siyuan-note/siyuan/blob/v3.8.9/kernel/model/assets.go
[H06]: https://github.com/siyuan-note/siyuan/blob/v3.8.9/kernel/model/assets_cleanup.go
[H07]: https://github.com/siyuan-note/petal/blob/7fb419fb94923618c71c93a15fd0a5321db27839/types/index.d.ts
[H08]: https://github.com/siyuan-note/siyuan/blob/v3.8.0/kernel/api/sql.go
[H09]: https://github.com/siyuan-note/siyuan/blob/v3.8.0/kernel/api/file.go#L560-L644
[H10]: https://github.com/siyuan-note/siyuan/blob/v3.8.9/kernel/model/assets.go
[H11]: https://github.com/siyuan-note/siyuan/blob/v3.8.9/kernel/model/upload.go
[H12]: https://github.com/siyuan-note/siyuan/blob/v3.8.9/docs/API.zh-CN.md
[H13]: https://github.com/siyuan-note/petal/blob/7fb419fb94923618c71c93a15fd0a5321db27839/siyuan.d.ts
[L01]: https://github.com/Donaldcwl/browser-image-compression/blob/v2.0.2/lib/image-compression.js
[L02]: https://github.com/Donaldcwl/browser-image-compression/blob/v2.0.2/lib/utils.js#L250-L294
[L03]: https://github.com/fengyuanchen/compressorjs/blob/v1.4.0/src/index.js
[L04]: https://github.com/fengyuanchen/compressorjs/blob/v1.4.0/README.md
[L05]: https://github.com/fengyuanchen/compressorjs/releases/tag/v1.4.0
[L06]: https://github.com/jamsinclair/jSquash
[L07]: https://sharp.pixelplumbing.com/install/

---

**给实施 Agent 的最后要求**：先完成旧版 SQL 与输入来源的可运行闭环，再接 UI；任何删图能力都必须晚于引用完整性与结果校验。保持批量禁删、不兼容图片 v1、不盲重试未知写入这三条不可变约束。报告已验证的部分和实机未验证部分必须继续分开记录。
