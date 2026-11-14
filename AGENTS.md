# OmniKit 开发者与 AI Agent 协作最高准则 (AGENTS.md)

> **适用范围**：所有参与 OmniKit 项目开发、维护、重构的 AI Agent（包括各级 Subagent、Swarm Worker）以及人类开发者。  
> **生效状态**：强制生效（Project Constitution）。本文件为 OmniKit 全平台常驻工程宪章与安全底线，任何代码提交与变更必须无条件遵循本文件规定的准则与红线。

---

## 0. 导言与效力说明 (Preamble & Legal Validity)

OmniKit 是面向思源笔记（SiYuan Note）的生产级多合一工具箱插件。为了在长周期的特性演进、多智能体协同开发以及高敏感的笔记数据操作中保障系统的稳定性、纯粹性与数据安全，特制定本准则。

### 0.1 法律效力与层级
- **最高宪法地位**：本准则的法律效力高于任何口头约定或临时提示词。若开发人员或 Agent 发现实现代码与本准则产生冲突，必须以本准则为唯一依据对代码进行修正。
- **全平台常驻约束**：本文件作为常驻系统级约束，定义跨功能通用的核心铁律、架构底线与安全防线，杜绝任何特定业务特性的过渡性假设。

### 0.2 文档分工与权威索引
- **平台架构规范**：平台的全局架构分层、模块交互与核心设计模式详见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)；
- **平台核心 PRD**：核心平台能力、微内核生命周期与通用服务规格详见 [`docs/CORE-PRD.md`](docs/CORE-PRD.md)；
- **特性业务 PRD**：各具体业务特性（如图片压缩、PDF 工具、格式转换等）的产品规格、业务逻辑与时序推演详见 [`docs/features/`](docs/features/) 下对应的特性 PRD 文档。

---

## 1. 核心准则 1：PRD 先行与唯一权威性 (Spec-First / PRD-First)

### 1.1 代码实现永远“追着文档走”
- **文档是唯一的真理之源**：业务代码（`src/` 目录下所有实现）必须且只能是 PRD 与架构规范的物理落地。代码实现绝不能超前于文档，更不允许“先写代码，后补文档”。
- **严禁擅自臆想功能**：严禁脱离 PRD 文档自行增减功能行为、修改交互流程、随意添加用户界面元素（例如未定义的按钮、快捷键或菜单项）、擅自增加设置选项或更改持久化路径。
- **新功能准入流程**：
  1. 在 `docs/features/<feature-name>.md` 编写完整的特性业务与约束 PRD；
  2. 经过评审并完成需求冻结（Spec-Freeze）；
  3. 按照 PRD 规划技术实现架构，并在 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 完成技术设计；
  4. 方可启动 `src/features/<feature-name>/` 下的代码开发与自动化测试。

### 1.2 变更同步要求
- 若在开发或测试过程中发现 PRD 存在设计疏漏或与思源底层行为不符，**必须先停止代码修改**，向用户或主 Agent 提出文档修订申请，经确认并更新相关 PRD 文档后，方可推进对应代码变更。

---

## 2. 核心准则 2：技术依据来源 (Authoritative Technical References)

任何技术选型、API 契约判断、时序设计与代码编写，必须遵循官方与源码级的依据链，严禁根据经验或第三方非官方推测假设思源的行为。

### 2.1 技术依据层级链 (Hierarchy of Truth)
1. **第一级（最高权威）：SiYuan 官方源代码**
   - 官方仓库：[`siyuan-note/siyuan`](https://github.com/siyuan-note/siyuan)
   - 本地源码基准：本地克隆的思源官方源码（如 `~/ghq/github.com/siyuan-note/`，在制定技术方案与分析契约时直接参考本地该目录）
   - 前端 Protyle 编辑器事件管道与上传实现：`app/src/protyle/`、`app/src/protyle/upload/`；
   - 后端内核 API 契约与操作处理：`kernel/api/`、`kernel/model/`、`kernel/apicontract/`；
   - 官方类型定义：`app/src/types/`。
2. **第二级：SiYuan Plugin 官方插件开发规范与 SDK**
   - 官方插件架构范式、生命周期约束、国际化规范与多端适配规则。
3. **第三级：SiYuan 官方 API 文档**
   - 官方公开的 REST API 契约、块属性规范、SQL 查询规范与资源操作手册。

### 2.2 契约防误判规范
- **禁止假设原子 CAS**：思源内核块更新 API（`/api/block/updateBlock`）不提供原子比较并交换（Compare-And-Swap）机制。不得假定系统具备悲观行锁，必须在插件层实现“写前读回比对（Read-Before-Write Verification）”与进程内串行写租约（Write Lease）进行安全防范。
- **禁止混淆事件与持久化**：思源前端事件触发（例如上传完成、输入完成、UI 渲染）不等于内核块已落盘持久化。必须显式通过内核接口获取或核验已落盘的真实数据。

---

## 3. 核心准则 3：Core 与 Feature 绝对解耦 (Strict Core-Feature Decoupling)

OmniKit 采用严格的微内核（Microkernel）插件化架构，核心平台（Core）与业务功能（Feature）界限分明。平台整体架构与通信契约详见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

```
┌────────────────────────────────────────────────────────┐
│                      Host (SiYuan)                     │
└───────────────────────────▲────────────────────────────┘
                            │
┌───────────────────────────┴────────────────────────────┐
│                  OmniKit Plugin Core                   │
│   (KernelClient / JsonStore / MenuRouter / Dock / UI)  │
└───────────▲───────────────────────────────▲────────────┘
            │ 严格单向契约依赖              │ 严格单向契约依赖
┌───────────┴──────────┐        ┌───────────┴──────────┐
│      Feature A       │        │      Feature B       │
│ (独立业务逻辑/独立数据)│ ◄─禁止─►│ (独立业务逻辑/独立数据)│
└──────────────────────┘ 相互依赖 └──────────────────────┘
```

### 3.1 跨 Feature 强隔离
- **禁止跨 Feature 依赖**：Feature 之间彼此绝对独立、互不知晓。严禁在 `src/features/<feature-a>` 中直接 import 或调用 `src/features/<feature-b>` 的任何类、函数、常量、状态或类型定义。
- **Feature 零感知**：Core 在装配 Feature 时仅通过标准元数据契约（`FeatureRegistration<T>`）交互。Core 核心代码中严禁出现针对具体 Feature ID 的硬编码业务分支或特殊处理逻辑。

### 3.2 通用能力下沉至 Core
- 所有跨功能的共性机制必须且只能沉淀在 `src/core/` 或 `src/ui/`，包括但不限于：
  - 思源内核网络调用与错误处理：`KernelClient`
  - 结构化 JSON 持久化与防写冲突：`JsonStore`
  - 统一日志与调试开关：`Logger`
  - 环境识别与平台判断：`Platform`
  - 统一侧边栏容器与 Tab 调度：Unified Dock
  - 统一菜单路由与安全校验：`MenuRouter`、`MenuRegistry`
  - 统一设置面板外壳：响应式多端联动设置组件
- Feature 仅作为业务实现者，通过 `BaseFeature` 与 `FeatureScope` 面向 Core 提供的标准契约编程。

---

## 4. 核心准则 4：存储命名与重置边界规范 (Storage Naming & Reset Boundaries)

OmniKit 的持久化文件严格划分为 **Core 平台配置**、**Feature 用户设置（Settings）** 和 **Feature 业务数据（Data Records）** 三大类别，遵循明确的文件命名法则与完全隔离的重置生命周期。各特性的存储结构定义详见对应的业务 PRD。

### 4.1 文件命名法则
| 存储类别 | 规范化文件名格式 | 示例 | 职责范围 |
|---|---|---|---|
| **Core 平台配置** | `omnikit-core.json` | `omnikit-core.json` | 插件全局通用配置、调试日志级别、各 Feature 的启用/禁用首选项状态等 |
| **Feature 用户设置** | `feature-{featureid}-settings.json` | `feature-image-compressor-settings.json`<br>`feature-pdf-tools-settings.json` | 用户在设置面板可配置的 Feature 行为参数（如质量阈值、白名单、转换格式等偏好） |
| **Feature 业务数据** | `feature-{featureid}-{dataname}.json` | `feature-image-compressor-records.json`<br>`feature-ocr-records.json` | 功能在运行过程中沉淀的核心业务数据（如输入与产物映射记录、索引表、操作历史等） |

### 4.2 重置边界防线
- **规则 1：设置重置绝对严禁触碰数据文件 (Reset Settings Scope Guard)**  
  无论是单个 Feature 的“重置设置”，还是插件全局的“恢复默认设置”，**操作作用域严格限定为 `omnikit-core.json` 与 `feature-*-settings.json`**。任何设置重置逻辑在代码层面绝对禁止读取、覆盖或删除任何 `feature-*-{dataname}.json` 业务数据文件！
- **规则 2：业务数据必须独立管理与确认 (Isolated Data Management)**  
  业务数据记录的清理必须且只能在插件总设置中专门开辟的**“数据管理 (Data Management)”专区**中进行。系统必须向用户清晰列出数据文件名、记录条数、占用体积，并在用户二次确认后方可显式清空或归档。

---

## 5. 核心准则 5：数据与安全底线 (Data & Safety Bottom Lines)

涉及思源笔记内容修改与附件处理的操作，必须坚守以下五条铁律安全红线。各特性具体的处理时序与算法细节详见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) 与各特性 PRD。

### 5.1 零工作区垃圾文件 (Zero Workspace Pollution)
- 严禁向思源工作区（包括 `data/`、`data/storage/`、`data/assets/` 等目录）写入临时日志文件、任务排队日志、调试 dump 文件或 `.tmp` 缓存。
- 崩溃与容灾依托思源原生强大的文档历史版本（Doc History）、块历史版本（Block History）以及数据仓库快照。插件层保持无状态运行与最小数据持久化，彻底避免污染用户的多端云同步环境。

### 5.2 严禁主动删除用户资源与生成资产 (Zero Active Deletion)
- 插件在任何运行阶段（包括处理成功后、完成引用替换后、用户移除业务记录或重置设置时），**绝对严禁主动调用思源 API 或底层文件系统接口去删除用户的原始附件或已生成的产物资产**。
- 附件资产的生命周期与清理完全交还给用户及思源原生自带的“清理未引用资源”功能。插件绝不充当资源文件的物理删除者。

### 5.3 块级精确改写 (Occurrence-Level Precision)
- **禁止全局资源级盲目重链接**：严禁调用思源 `/api/asset/relinkAsset` 进行跨文档、跨数据库的全局盲目重链接。
- **唯一位置比对改写**：任何对笔记内容或资源引用的修改，必须精确锁定目标位置契约（`OccurrenceTarget`：包含 `rootID`、`blockID`、目标元素在块内的有序序号 `ordinal`、修改前特征 `oldValue/oldPath` 等），杜绝模糊匹配与范围扩散。
- **写前校验与冲突放弃 (Read-Before-Write Verification)**：调用内核 `/api/block/updateBlock` 前，必须重读块真实数据，严格校验目标位置与内容未发生并发篡改或外部编辑覆盖；若发生变更，必须安全放弃当前位置改写并记录告警，绝不强行覆盖。
- **严禁 SQL 写入**：思源 SQL API（`/api/query/sql`）仅允许作为只读索引辅助查询，严禁执行任何 `UPDATE`、`DELETE`、`INSERT` 语句。

### 5.4 持久化前置闸门 (Persistence-First Gate)
- 当异步流水线生成了新的衍生资产（如处理后的衍生文件、生成内容、新附件）后，**必须先将业务记录（如原始输入→生成产物的映射记录与元数据）成功持久化写入磁盘 JSON 文件并收到写入确认，才允许发起对笔记中内容或引用的自动替换**。
- 若持久化发生异常、写入失败或超时，后续的自动替换流程必须立即无条件阻断，保留已生成的资源并向用户提示可供复制的资源路径，绝不允许产生“笔记已改写但插件无法追踪记录”的游离状态。

### 5.5 无主动取消与生命周期安全中断 (No Manual Cancel & Safe Abort)
- **不设用户主动取消机制**：后台异步任务执行过程中不提供用户可操作的“取消任务”按钮、菜单项或公开取消接口，避免人为中断导致状态半持久化或引用半改写。
- **系统生命周期安全中止**：当所属 Feature 被动态禁用、插件卸载或宿主退出时，通过 `FeatureScope.signal`（AbortSignal）广播中断信号。异步任务感知信号后，**仅安全停止未执行的后续步骤，严格保留已确认上传和已持久化的产物与记录，严禁任何形式的事务回滚**。应用重启后不自动恢复在途任务，保持无状态。

### 5.6 零绝对路径与隐私安全底线 (Zero Absolute Path & Privacy Protection)
- **严禁写入本机绝对路径与用户名**：项目内部所有 Markdown 文档、注释、配置文件及源码中，**严禁硬编码任何包含本地操作系统用户名（如 `/home/<user>/`、`C:\Users\<user>\`）或 `file:///` 协议的绝对路径**。
- **文档链接必须使用相对路径**：所有仓库内文档之间的跳转与引用，必须且只能使用标准的相对路径（如 `[AGENTS.md](../AGENTS.md)`），违者视为严重安全隐患阻断提交。

---

## 6. 开发与代码审查自查清单 (Review Checklist)

在提交任何代码前，AI Agent 与人类开发者必须逐项核对以下清单：

- [ ] **PRD 依从性**：新增或修改的代码是否严格符合对应的 [`docs/CORE-PRD.md`](docs/CORE-PRD.md) 或 [`docs/features/*.md`](docs/features/)？是否有私自增加的 UI 按钮、未定义的设置项或未记录的副作用？
- [ ] **解耦性**：新增的 Feature 代码是否完全自包含在自己的目录中？是否存在对其他 Feature 的直接 import？
- [ ] **存储合规**：新引入的持久化文件是否严格符合 `feature-{featureid}-settings.json` 或 `feature-{featureid}-{dataname}.json` 的命名规范？重置设置时是否绝对不会影响数据文件？
- [ ] **资源安全性**：代码中是否不存在任何主动删除用户文件或资产产物的行为？是否存在向思源工作区写入非必要临时文件的行为？
- [ ] **改写安全性**：块修改是否采用 `OccurrenceTarget` 精确比对？是否在写入前重新读取了块进行二次校验？
- [ ] **持久化闸门**：写回笔记引用前是否已确认业务记录写入磁盘？
- [ ] **中断友好**：长时间异步循环是否检查了 `scope.signal.aborted`？
- [ ] **隐私合规**：代码与文档中是否不存在任何本机绝对路径、用户家目录路径或隐私凭据？
