# OmniKit · 系统架构与技术实现设计文档 (ARCHITECTURE)

> **版本**：v1.0（正式发布稿）  
> **状态**：正式发布（Approved）  
> **设计基准**：严格遵循 [AGENTS.md](../AGENTS.md)、[CORE-PRD.md](CORE-PRD.md)、[image-compressor](features/image-compressor/PRD.md) 及 [titled-link](features/titled-link/PRD.md)（各特性严格维护独立的 `PRD.md` 与 `DESIGN.md`）  
> **源码基线**：`Forgo7ten/siyuan-plugin-omnikit` (`feat-image-compressor`)

---

## 1. 架构概览与技术栈

OmniKit 是基于现代前端与思源笔记插件生态构建的高效、高可靠多合一工具箱扩展平台。

### 1.1 技术栈选型
- **编程语言**：TypeScript 5.x（启用 `strict: true`、严格类型检查与安全泛型约束）
- **构建工具**：Vite 5.x（多输出配置：主入口打包为 `index.js`、样式整合为 `index.css`、资源静态复制）
- **UI 组件框架**：Svelte 5（基于 Runes 响应式体系，通过 `mount` 与 `unmount` 精确控制生命周期）
- **样式体系**：SCSS（模块化样式组织，继承思源原生 CSS 变量自适应浅色/深色主题）
- **宿主环境**：思源笔记核心（Protyle 编辑器引擎、REST Kernel API、EventBus、Protyle Upload 流程）

### 1.2 核心设计哲学
1. **微内核与单向依赖**：Core 平台层不感知具体 Feature 的内部实现，所有功能通过元数据驱动注入；
2. **多实例与环境防护**：针对思源独立设置窗口（`body--settings`）进行无副作用纯渲染隔离；
3. **确定性存储体系**：单文件 Promise 串行队列、内存缓存指纹跳写、思源原生 loadData/saveData 与配置/数据物理隔离；
4. **防御性块级改写**：写前基于 `OccurrenceTarget` 进行精确节点读回核验、采用进程内写租约（Write Lease）与持久化前置闸门；
5. **可重现与确定性工程体系**：统一工程脚本体系、全自动化质量门禁与多入口幂等发版闭环。

---

## 2. 系统分层架构

OmniKit 划分为清晰的“宿主适配层”、“Core 平台基础设施层”与“Feature 业务特性层”三层架构：

```mermaid
flowchart TD
    subgraph Host["宿主环境 (SiYuan Note)"]
        H_API["Kernel REST API (/api/...)"]
        H_Event["EventBus / Protyle Lifecycle"]
        H_UI["Host Dock / Context Menu / TopBar"]
    end

    subgraph Core["OmniKit Core 平台层 (src/core/ & src/ui/)"]
        PluginEntry["OmniKitPlugin (插件主入口)"]
        Catalog["FeatureCatalog (元数据仓库 & frontends 契约)"]
        Manager["FeatureManager (平台兼容设防与串行状态机)"]
        Scope["FeatureScope (AbortSignal & 资源作用域)"]
        
        subgraph CoreInfra["基础设施与驱动"]
            KernelClient["KernelClient (安全 API 调用门面)"]
            ProtyleAdapter["ProtyleAdapter (宿主数据标准提取器)"]
            SettingsMgr["SettingsManager (多文件配置协调器)"]
            JsonStore["JsonStore (单文件串行队列/指纹跳写/容灾)"]
            Logger["Logger (动态等级日志)"]
            Platform["Platform (环境探测 & IsTargetSupported 判定)"]
        end
        
        subgraph CoreUI["统一宿主 UI 容器"]
            UnifiedDock["UnifiedDock (单槽位 Tab 容器)"]
            SettingsShell["SettingsRoot.svelte (iPad 双栏联动面板)"]
            MenuRouter["MenuRouter & MenuRegistry (通用上下文转换与 Matcher 路由)"]
            FeedbackService["UiFeedback (统一交互/前缀/防抖/静默)"]
            StatusBar["PluginStatusBar (单例底栏状态栏)"]
        end
    end

    subgraph Features["Feature 业务特性层 (src/features/)"]
        subgraph ImgCompressor["image-compressor (图片压缩特性)"]
            FeatImage["ImageCompressorFeature"]
            ImgController["ImageController (业务编排门面)"]
            Classifier["ImageCandidateClassifier (统一准入/视频/Excalidraw)"]
            AutoUpload["AutoUploadHandler (上传完成异步捕获)"]
            RemoteWatcher["RemoteImageWatcher (外链安全本地化)"]
            SafeWriter["SafeBlockWriter (写租约与 Occurrence 节点改写)"]
            WorkerCodec["ImageCodec (WebP 编解码引擎)"]
            SimilarityDomain["similarity/ (5尺度MS-SSIM/自适应搜索/内联Worker)"]
            RecordStore["ImageCompressionRecordStore (Dock 业务数据持久化)"]
            DockView["ImageRecordsDock.svelte (Tab 视图组件)"]
            SettingsView["ImageSettingsPanel.svelte (设置卡片组件)"]
        end

        subgraph TitledLink["titled-link (自动标题链接特性)"]
            FeatTitledLink["TitledLinkFeature"]
            TitledLinkController["TitledLinkController (业务编排门面)"]
            DualNetwork["DualTrackNetwork (桌面 fetch / 移动 forwardProxy)"]
            StreamParser["StreamParser (32~64KB 流式截断 & 编码嗅探)"]
            SafeTransactionWriter["SafeTransactionWriter (写前核验与事务提交)"]
            TitledLinkCache["TitledLinkCache (短期内存 LRU 缓存)"]
            TitledLinkSettingsView["TitledLinkSettingsPanel.svelte (设置组件)"]
        end
        
        subgraph FutureFeatures["未来扩展特性..."]
            FeatX["Feature X (独立业务逻辑与数据)"]
        end
    end

    %% 依赖与交互调用链
    Host <--> PluginEntry
    PluginEntry --> Catalog
    PluginEntry --> Manager
    PluginEntry --> SettingsMgr
    PluginEntry --> UnifiedDock
    PluginEntry --> MenuRouter
    PluginEntry --> StatusBar

    Manager --> Scope
    Manager --> FeatImage
    Manager --> FeatTitledLink
    Manager --> FeatX

    FeatImage --> ImgController
    ImgController --> Classifier
    ImgController --> AutoUpload
    ImgController --> RemoteWatcher
    ImgController --> SafeWriter
    ImgController --> WorkerCodec
    ImgController --> SimilarityDomain
    ImgController --> RecordStore
    ImgController --> FeedbackService
    ImgController --> StatusBar

    FeatTitledLink --> TitledLinkController
    TitledLinkController --> DualNetwork
    TitledLinkController --> StreamParser
    TitledLinkController --> SafeTransactionWriter
    TitledLinkController --> TitledLinkCache
    DualNetwork --> KernelClient
    SafeTransactionWriter --> KernelClient
    
    SafeWriter --> KernelClient
    AutoUpload --> KernelClient
    RemoteWatcher --> KernelClient
    KernelClient --> H_API

    RecordStore --> JsonStore
    SettingsMgr --> JsonStore
    JsonStore --> H_API

    UnifiedDock -.-> DockView
    SettingsShell -.-> SettingsView
    SettingsShell -.-> TitledLinkSettingsView
    MenuRouter --> H_UI
```

---

## 3. Core 平台核心设计与类职责

### 3.1 `OmniKitPlugin` (宿主集成与多窗口守卫)
- **文件位置**：`src/core/OmniKitPlugin.ts`
- **主要职责**：
  - 继承思源官方 `Plugin`，作为思源加载的唯一物理入口；
  - **多窗口隔离识别**：通过 `document.body.classList.contains("body--settings")` 识别独立设置窗口。在设置窗口中仅挂载 Svelte 设置界面与 Store，运行时状态反映为 `runtime.configured`，不启动后台上传监听、MenuRouter 或 Dock；
  - 监听宿主 `onload`、`onunload`、`onLayoutReady` 以及跨窗口配置广播 `onDataChanged`；收到 `onDataChanged` 时调用已注册 Feature 的 `reloadData()` 钩子同步内存状态与视图；
  - **顶栏与下拉菜单装配**：统筹注册 Core Dock 单槽位、TopBar 图标与设置对话框；构建顶栏下拉菜单时严格按分层组织：顶部 Core 平台项（「OmniKit 设置」） + 调用思源原生 `menu.addSeparator({ id: "separator_settings" })` 物理分隔线 + 各 Feature 业务选项（Dock 栏已有常驻入口，顶栏不设立重复且无控的打开 Dock 选项）。

### 3.2 `FeatureCatalog` 与 `FeatureManager` (生命周期与状态机)
- **文件位置**：`src/core/framework/FeatureCatalog.ts`、`src/core/framework/FeatureManager.ts`
- **主要职责**：
  - `FeatureCatalog` 集中持有所有 Feature 的声明式元数据（`FeatureRegistration<T>`），包含 `id`、`defaultEnabled`、支持端声明 `frontends` 以及可选的跨端/外部数据同步钩子 `reloadData?: (plugin: Plugin) => Promise<void>`，对外暴露只读索引与存储文件命名合法性校验；
  - `FeatureManager` 维护每个 Feature 的严格串行化启停队列（Promise Queue），提供跨端安全的生命周期调度；当宿主广播 `onDataChanged` 或发生外部数据文件写同步时，Core 统筹调用已激活 Feature 的 `reloadData` 钩子，由 Feature 自身刷新内存中缓存的业务记录或视图索引；
  - **六状态机模型 (`FeaturePhase`)**：
    - `disabled`：未激活停用状态；
    - `unsupported`：宿主前端平台不兼容状态；
    - `enabling`：正在分配 Scope 与执行异步初始化；
    - `enabled`：已成功激活并正常运行；
    - `disabling`：正在广播中止信号与安全注销资源；
    - `error`：启停或执行遭遇未捕获异常；

```mermaid
stateDiagram-v2
    [*] --> Disabled
    Disabled --> Unsupported: 平台兼容性核验不满足 (Platform.isFrontendSupported)
    Disabled --> Enabling: enable() [进入串行队列 & 平台兼容]
    Enabling --> Enabled: onEnable() 成功完成
    Enabling --> Error: onEnable() 抛出异常
    
    Enabled --> Disabling: disable() [进入串行队列]
    Disabling --> Disabled: onDisable() 成功完成
    Disabling --> Error: onDisable() 抛出异常
    
    Unsupported --> Disabled: 运行环境切换为兼容平台
    Error --> Enabling: 重试启用
    Error --> Disabling: 强制重置
```

  - **平台兼容性设防与云同步偏好保护 (Platform Compatibility Guard)**：
    1. **启动与热重载设防**：在 `initialize()` 与 `reconcileFromLoadedSettings()` 阶段，`FeatureManager` 调用 `Platform.isFrontendSupported(feature.frontends)` 核验当前运行环境。若环境不支持，立即跳过生命周期激活（不调用 `feature.activate()` 与 `onEnable()`，不分配 `FeatureScope`，不占用任何常驻定时器、DOM 节点或事件总线），将运行时状态置为 `"unsupported"`；
    2. **`setEnabled` 安全拦截机制**：当外界或 API 尝试显式调用 `setEnabled(id, true)` 或 `enable(id)` 时，若当前平台不支持该功能，`FeatureManager` 直接拒绝状态变更（返回 `false`），且**绝对不调用 `settings.setFeatureEnabled(id, true)`**；
    3. **跨端同步状态保全**：严格保护底层 `omnikit-core.json` 中用户的期望启用偏好。在多端云同步架构中，轻量端（如移动端）因平台受限进入 `unsupported` 状态绝不反向冲刷用户的开启偏好，确保在主力设备（如桌面端）上始终维持预期的开启状态；
  - 当 Feature 启动失败时，置状态为 `error` 并记录异常，保持用户在 `omnikit-core.json` 中配置的期望偏好不变。

### 3.3 `BaseFeature` 与 `FeatureScope` (资源作用域与中止信号)
- **文件位置**：`src/core/framework/BaseFeature.ts`、`src/core/framework/FeatureScope.ts`
- **主要职责**：
  - 每个业务功能继承 `BaseFeature`，通过 `context` 获得受控的 Core 基础设施；
  - `FeatureScope` 原生封装 `AbortController`：
    - `scope.own(disposer)`：注册所有运行期副作用（Protyle 事件监听器、DOM 钩子、定时器）；统一由 `FeatureScope` 集中托管与自动注销；
    - `scope.signal`：向下传递的只读 `AbortSignal`；
    - `scope.guard(fn)`：包装异步回调，若 Scope 已销毁则直接短路，防止失效的幽灵回调执行；
  - **任务正常中止与静默退出设计 (Normal Abort & Quiet Exit)**：
    - 当用户按 Esc、切换编辑器标签页、功能停用或触发 `signal.abort` 时，异步处理链路与控制器判定为**正常中止并静默退出**，严禁向用户误报“无法定位引用”、“无效文档”或并发冲突；
    - 底层改写执行者（`SafeBlockWriter`）在检测到任务取消或 Abort 信号时必须显式抛出 `AbortError` 或返回取消标识，严禁混淆为 `conflict`；
  - 当 Feature 停用或插件卸载时，`scope.dispose()` **首先广播 `abort` 信号**通知所有在途任务安全终止，再按后进先出（LIFO）顺序释放所有监听器。

### 3.4 `SettingsManager` 与 `JsonStore` (确定性存储体系)
- **文件位置**：`src/core/store/SettingsManager.ts`、`src/core/store/JsonStore.ts`
- **核心机制**：
  - **精简存储模型与每文件独占 Promise 队列**：基于单文件 Promise 串行队列调度所有写操作，配合思源原生 `Plugin.loadData` / `saveData` 实现持久化，杜绝写竞争；
  - **内容指纹防抖**：内存维护序列化指纹（`fingerprint`），相同数据重复保存自动跳过实际磁盘 I/O；
  - **安全读取与状态契约**：调用思源内核 `/api/file/getFile`（或安全处理 `/api/file/loadData`）读取配置文件。明确状态契约：HTTP 状态码为 202 且思源 code 为 404 时确认为文件不存在，返回 `defaults()` 并安全初始化；若返回网络错误、服务不可用（如 code 500、503、403）、请求超时（30 秒超时时限）或读写锁异常，必须抛出错误并挂起写队列或进入只读保护模式（`readOnly: true`），严禁静默使用空对象或默认值覆盖用户的现有持久化文件；
  - **异常损坏隔离**：解析非空 JSON 失败时不使用默认值覆盖。将损坏文件隔离备份为 `.backup` 并提示用户显式确认修复。

### 3.5 `KernelClient` (安全内核 API 封装)
- **文件位置**：`src/core/host/KernelClient.ts`
- **主要职责**：
  - 封装对思源内核 `/api/...` 的网络交互；
  - 支持调用方传入 `AbortSignal` 与自定义超时；超时的定时器不仅拒绝当前 Promise，同时显式调用底层 `fetch` 的 `AbortController.abort()` 及时终止并释放网络套接字连接；
  - 自动归一化处理思源错误码（`code !== 0`），统一包装为结构化 `KernelError`；
  - 避免对可能改变工作区状态的非幂等修改请求进行静默重试。

### 3.6 统一 UI 扩展系统
- **统一 Dock 容器** (`src/ui/dock/`)：
  - 仅占用思源侧边栏 **1 个图标位置**；
  - 内部实现 Svelte 5 驱动的 Tab 路由管理器：当多个 Feature 启用 Dock 视图时展示 Tab 头；仅单个 Feature 启用时独占主视图；全停用时呈现空状态指引；
  - **视图渲染缓存与状态保全**：维护 `renderedKey` 标识当前挂载的 Tab 视图；当切换回相同活跃视图时复用已有挂载，避免不必要的组件销毁与二次重建；
  - **视图与 Dock 组件生命周期 Abort 机制**：Dock 视图组件持有专用的 `AbortController`；当组件卸载、Dock 折叠或 Tab 切换销毁时，立即广播中断信号，取消在途的后台引用检索与状态核验；
  - **平台兼容性排除**：Dock 动态视图提取函数（`views()`）严格筛选 `this.manager?.isRunning(id)` 的 Feature。处于 `unsupported` 状态的功能不被视作运行中，自动排除在 Dock Tab 之外，不产生多余标签页与空 DOM 挂载；
  - **Dock 顶部视觉与防遮挡规范 (Brand Hero Card)**：
    - 在 Dock 视图顶部常驻渲染约 52px~56px 高度的品牌展示区，包含 OmniKit 图标、粗体大标题（如「OmniKit / 图片记录」）与轻量模式徽章，背景采用思源原生主题微渐变浅背景（`var(--b3-theme-primary)` 8% 透明度）；
    - **几何防遮挡下移 (50px+)**：使下方操作栏（刷新记录、搜索筛选等按钮）整体平滑下移 50px 以上，彻底避开思源桌面端（Windows）及网页端右上角 32px 浮动 Snackbar 消息层（`#message` / `.b3-snackbars`）与 Tooltip 浮层的绝对遮挡，保障交互区域无遮挡点击；
    - **静默刷新防覆盖铁律 (Anti-Overwriting Guard)**：Dock 在改写操作后执行的后续静默刷新（`post_action`）若遇异常或返回空结果，绝对禁止冲刷或覆盖本次操作产生的成功统计文案；当待处理项降为 0 时必须干净收起抽屉并保留成功统计，杜绝悬挂假性“未找到引用”；
  - 依托 Svelte 5 `mount` / `unmount` 精准控制各 Feature 视图的装载与卸载。
- **局域网 HTTP 环境与无 WebCrypto 兼容规范**：
  - 在局域网非 HTTPS（`window.isSecureContext === false`）环境下，剪贴板 API 与 `crypto.subtle` 受限；
  - 统一交互层在调用 `navigator.clipboard.writeText` 失败或未受支持时，安全回退为弹出包含可复制文本框的模态提示，确保全网络环境可用；唯一标识生成采用时间戳与安全随机字符组合。
- **统一设置面板 (`SettingsRoot.svelte`)** (`src/ui/settings/`)：
  - 采用 iPad 风格双栏联动布局（左侧导航分组 + 右侧单页平滑滚动卡片）；
  - **平台兼容性设防架构 (方案 A：卡片保持展示，总开关置灰禁用，专属设置可预先调整)**：
    - 针对 `runtime.status === "unsupported"` 的 Feature，设置卡片在右侧正常排布渲染，左侧导航正常提供平滑定位，维持全端 UI 结构与视觉一致性；
    - **总开关置灰禁用（Disabled Guard）**：卡片头部总开关设置 `disabled` 属性置灰禁用，不可点击切换，彻底阻止非法生命周期触发；
    - **状态 Badge 与平台说明**：卡片顶部 Badge 渲染 `runtime.unsupported`（「当前平台暂不支持」），并展示友好的支持平台列表说明（如“仅支持：桌面端、桌面窗口”）；
    - **专属设置项允许预调**：卡片主体内的专属设置组件（`settingsView`）保持挂载并允许交互调整，满足跨端云同步场景下提前配置参数的诉求；修改保存仅局限于其专属配置文件 `feature-{id}-settings.json`，绝对不触碰 `omnikit-core.json`；
- **统一菜单路由器 (`MenuRouter` / `MenuRegistry`)** (`src/core/feedback/MenuRouter.ts` / `src/core/feedback/MenuRegistry.ts`)：
  - **通用上下文转换与业务解耦架构**：
    - `MenuRouter` 作为通用的宿主事件到上下文转换层，集中监听思源 EventBus 上下文菜单事件（`click-blockicon`、`open-menu-doctree`、`open-menu-link` 等）；
    - **通用上下文提取**：`MenuRouter` 仅负责从原生 detail 中提取标准通用上下文（例如 `selectedDocumentIDs: string[]`、`selectedDocumentCount: number`、`protyle?: IProtyle`、`targetElement?: HTMLElement` 等），Core 平台层彻底移除硬编码的业务分支（如针对图片的直接判断、针对 2 篇文档的硬编码业务判定等）；
    - **Feature 自主注册 Matcher**：具体的业务匹配规则与菜单项由各 Feature 在自身模块内自主注册的 Matcher 判定。Matcher 接收标准通用上下文，自主决定是否激活菜单项、动态生成文案与绑定点击动作；
  - 严格校验菜单所属 Feature 的运行态（`phase === "enabled"`）；
  - **平台兼容性排除**：处于 `unsupported` 状态的功能未被激活且无 `FeatureScope`，不向 `MenuRegistry` 注入任何菜单动作项；`isFeatureRunning` 核验天然拦截，外部宿主上下文菜单与顶栏快捷菜单自动跳过渲染，无冗余开销；
  - **顶栏菜单与分隔线规范**：
    - OmniKit 顶栏下拉菜单顶部为 Core 平台项：包含「OmniKit 设置」（Dock 栏已有常驻图标，顶栏不设立重复的 Dock 菜单项）；
    - Core 平台项与下方各 Feature 贡献的选项之间，**必须使用视觉分隔线 (`separator`) 进行物理隔离**；
    - **思源原生 SDK 契约对齐**：必须在「OmniKit 设置」之后显式调用思源原生 SDK 契约 `menu.addSeparator({ id: "separator_settings" })`，生成思源原生标准的 `<button data-id="separator_settings" class="b3-menu__separator"></button>` 分隔线（与思源官方 `openTopBarMenu.ts` 实现完全对齐），物理隔离 Core 平台设置与下方各 Feature 业务选项；
  - **前缀分流权威收口规范 (Context-Aware Prefix via MenuRegistry)**：
    - 由 `MenuRegistry` 作为菜单项注册与派发的唯一权威分流收口，禁止 Feature 层硬编码前缀；
    - 顶栏自有菜单 (`location === "topbar"`)：彻底移除 `[OmniKit]` 前缀，保持清爽克制；
    - 外部宿主上下文菜单 (`location === "doc-tree" | "doc-title" | "image" | "link" | "blockicon"`)：由 `MenuRegistry` 自动保留并统一补齐 `[OmniKit] ` 前缀，确保明确的插件归属标识；
  - 若触发时对应功能处于停用状态，调用轻量通知 `showMessage` 提示功能未启用，不弹出模态对话框。

### 3.7 `UiFeedback` (统一通知与交互反馈门面)
- **文件位置**：`src/core/feedback/UiFeedback.ts`
- **主要职责**：
  - 注入 `FeatureContext.feedback`，为所有 Feature 提供平台统筹的用户交互与反馈服务；
  - **前缀自动补齐**：统一对外弹窗追加 `[OmniKit] ` 前缀，Feature 调用时仅传入纯语义内容；
  - **生命周期守卫**：检测 `scope.active`，当对应 Feature 处于停用状态或插件正在卸载时，静默丢弃未决的弹窗，杜绝幽灵通知；
  - **`AbortError` / 取消信号自动吞咽**：捕获任务因用户 Esc、切页、关闭面板或 `signal.abort` 产生的中止信号与 `AbortError`，自动拦截并静默处理，严禁向用户弹报错气泡；
  - **防抖抑制**：在 300ms 时间窗口内抑制相同文本的高频重复弹出；
  - **通用能力**：提供标准的 `notify(message, type, options)` 及 `copyable(text, label)`。

### 3.8 `PluginStatusBar` (宿主底栏状态栏管理)
- **文件位置**：`src/core/feedback/PluginStatusBar.ts`
- **主要职责**：
  - 注入 `FeatureContext.statusBar`，作为主工作区底部轻量单行任务进度的单例入口；
  - **生命周期挂载**：在主窗口 `onLayoutReady()` 中由 Core 统一调用思源官方原生 `plugin.addStatusBar({ element, position: "left" })` 挂载；插件注销 `onunload()` 时调用 `dispose()` 清理；
  - **通用样式规范**：容器类名固定为通用的 `.omnikit-status-bar`，严禁硬编码 feature 名称；单行布局（`max-width: 260px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 12px;`）；
  - **多任务字典调度**：内部维护 `tasks: Map<string, string>`，支持 `update(taskID, text)` 与 `clear(taskID)`；无活跃任务时自动添加 `.fn__none` 完全隐藏；
  - **跨端兼容短路**：在移动端原生 App（`addStatusBar` 返回 `undefined`）与独立设置窗口中自动短路（`mounted = false`），不进行无意义的 DOM 操作。

### 3.9 `ProtyleAdapter` (宿主数据标准提取器)
- **文件位置**：`src/core/host/ProtyleAdapter.ts`
- **主要职责**：
  - 统一抹平思源不同事件触发源的数据结构差异，提供确定性的 Protyle 上下文提取；
  - **标准属性直接提取**：直接从原生事件上下文提取 `detail.protyle.block.rootID` 与 `detail.protyle.element` 等标准对象，杜绝多层冗余的兜底空值回退链，保障适配层的高效与简洁；
  - **无副作用与只读守卫**：纯函数式上下文提取与类型守卫，不产生任何 DOM 侵入或状态副作用。

---

## 4. 存储架构与持久化规范

```
SiYuan 工作区目录：data/storage/petal/siyuan-plugin-omnikit/
├── omnikit-core.json                      <-- Core 平台配置
├── feature-image-compressor-settings.json <-- Feature A 用户设置 (受重置管控)
├── feature-image-compressor-records.json  <-- Feature A 业务数据 (不受设置重置影响)
└── feature-titled-link-settings.json      <-- Feature B 用户设置 (受重置管控)
```

### 4.1 文件划分与生命周期

| 存储分类 | 文件路径规则 | 包含内容 | 重置操作影响边界 |
|---|---|---|---|
| **Core 平台配置** | `omnikit-core.json` | `schemaVersion: 1`<br/>`general: { debugLog, userAgent }`<br/>`featureStates: { [id]: { enabled } }` | **全局重置时重置**（恢复 debugLog 为 false，userAgent 为空串） |
| **Feature 设置** | `feature-{id}-settings.json` | 用户在各 Feature 设置页手动调整的业务参数（质量、白名单、截断长度等偏好） | **单功能重置**及**全局重置**时恢复默认值 |
| **Feature 业务数据** | `feature-{id}-{dataname}.json` | Feature 核心业务数据（如原图/WebP映射） | **不受设置重置影响**，仅支持在“数据管理专区”由用户显式操作清空 |

### 4.2 设置重置与数据管理专区机制
1. **重置隔离规范**：`SettingsManager.resetFeature(id)` 与 `resetAll()` 仅针对 `omnikit-core.json` 与各 `feature-*-settings.json` 调用 `store.save(codec.defaults())`。底层存储注册表中数据文件（`feature-*-{dataname}.json`）使用独立的存储句柄，重置逻辑不持有数据文件的写入权限。
2. **数据管理专区**：在统一设置面板底部提供独立的“数据管理”视图，展示每个数据文件的物理大小与记录总数，提供经二次确认的“清空数据”操作。

---

## 5. 图片压缩功能技术实现设计

### 5.1 上传后异步全流程时序

```mermaid
sequenceDiagram
    autonumber
    participant Editor as 思源 Protyle 编辑器
    participant Host as 思源内核 (Kernel)
    participant Classifier as ImageCandidateClassifier
    participant Handler as AutoUploadHandler
    participant Controller as ImageController
    participant Resolver as ImageOccurrenceResolver
    participant Similarity as similarity/ (Worker)
    participant RecordStore as ImageCompressionRecordStore
    participant SafeWriter as SafeBlockWriter
    participant Feedback as Core UiFeedback
    participant StatusBar as Core PluginStatusBar

    rect rgb(245, 245, 255)
    Note over Editor,Handler: 步骤零：上传前纯同步授权与候选预筛选
    Editor->>Handler: before-upload-assets 事件 (detail.input)
    Handler->>Handler: 同步核验 scope.active 与文档授权
    Handler->>Classifier: 路径与扩展名预筛选 (排除视频/矢量/绘图)
    alt 未授权或无候选图片
        Handler-->>Editor: 零开销直接退出 (不挂载 MutationObserver)
    else 授权且存在候选图片
        Handler->>Editor: 挂载轻量 DOM 观察器并同步注册 onComplete
    end
    end

    Editor->>Host: 原生上传原始图片 (PNG/JPEG)
    Host-->>Editor: 返回原生资源路径并插入新块
    
    rect rgb(240, 248, 255)
    Note over Handler,Resolver: 步骤一：线索捕获与精确块定位
    Editor-->>Handler: 捕获上传完成事件线索
    Handler->>Resolver: 等待块落盘，锁定精确图片位置 (OccurrenceTarget)
    Resolver->>Host: POST /api/block/getBlockDOM (读取快照)
    Host-->>Resolver: 返回块 DOM 与元数据
    Resolver-->>Handler: 定位成功 (rootID, notebook, blockID, ordinal, oldPath)
    end

    rect rgb(255, 250, 240)
    Note over Handler,Similarity: 步骤二：异步读取与两阶段智能质量搜索
    Handler->>Host: 读取原图二进制内容
    Host-->>Handler: 原图数据 (ArrayBuffer / Blob)
    Handler->>Similarity: 两阶段 Worker 评估 (initOriginal 预计算金字塔)
    Similarity->>Similarity: 5 尺度 MS-SSIM 与割线+二分搜索 (桌面端≤7轮, 移动端≤5轮)
    Similarity-->>Handler: 最优达标 WebP Blob 与质量指标 (>=0.99)
    Handler->>Handler: 核验三大收益门槛 (>=100KiB, >=4KiB, >=5%)
    end

    rect rgb(240, 255, 240)
    Note over Handler,RecordStore: 步骤三：内核上传与持久化前置闸门
    Handler->>Host: POST /api/asset/upload (上传 WebP 文件)
    Host-->>Handler: 内核响应确认 (succFiles[0].index === 0 且 failedFiles.length === 0)
    Handler->>RecordStore: 记录原图与压缩图映射 (originalPath -> compressedPath)
    RecordStore->>RecordStore: JsonStore 持久化写入 feature-image-compressor-records.json
    RecordStore-->>Handler: 持久化成功确认 (Persistence Gate Passed)
    end

    rect rgb(255, 240, 245)
    Note over Handler,SafeWriter: 步骤四：写租约排队与精确节点写回
    Handler->>SafeWriter: 提交块引用改写请求 (OccurrenceTarget, newWebpPath)
    SafeWriter->>SafeWriter: 获取进程内排队写租约 (withBlockWriteLease)
    SafeWriter->>Host: POST /api/block/getBlockDOM (写前重新读回)
    Host-->>SafeWriter: 返回当前最新 currentBlockDOM
    SafeWriter->>SafeWriter: 精确核验: 块归属未变、序号节点存在且引用仍为 oldPath
    
    alt 核验一致 (无并发编辑冲突)
        SafeWriter->>Host: POST /api/block/updateBlock (更新指定单处图片节点引用)
        Host-->>SafeWriter: 内核返回 code: 0 (落盘确认)
        SafeWriter->>SafeWriter: 信任内核写入确认，完成改写
    else 发生冲突 (图片已被用户删除或修改)
        SafeWriter-->>Handler: 安全放弃写回 (Conflict Skipped)
    end
    SafeWriter->>SafeWriter: 释放写租约
    end

    rect rgb(245, 255, 250)
    Note over Controller,StatusBar: 步骤五：Controller 统筹反馈与状态同步
    Handler-->>Controller: 返回纯数据结构化结果 (AutoUploadNotice / ImageActionOutcome)
    Controller->>Feedback: 解释领域语义并派发规范化通知 ([OmniKit] 前缀与生命周期守卫)
    Controller->>StatusBar: 更新/清除底栏轻量任务文本
    end
```

### 5.2 子模块职责与设计契约

#### 1. 架构分工与去重规范 (Feature-Controller-Action Separation)

为了消除多层重复判断、避免职责混乱引发假性报错或多重提示，系统确立严格的单向职责划分与所有权模型：

```
┌────────────────────────────────────────────────────────────────────────┐
│ Feature 层 (ImageCompressorFeature.ts)                                  │
│ - 负责思源宿主事件与菜单监听注册 (Protyle 事件 / 文档右键 / 图片右键)    │
│ - 负责提取宿主上下文 (Protyle 实例、blockID、rootID 等) 并派发给 Controller │
│ - 所有副作用与监听句柄统一由 FeatureScope (scope.own) 集中托管与注销   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 派发事件上下文
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Controller 门面层 (ImageController.ts)                                 │
│ - 唯一业务编排门面，负责前置准入判定 (全局自动开关 / 白名单校验)        │
│ - 负责生命周期与状态调度 (TaskPanel 进度模态框装配与销毁、Abort 信号传递)│
│ - 唯一负责领域结果解释：将 Action 返回的结构化纯数据解释为语义文案与通知 │
│ - 对接 Core UiFeedback 派发结果提示，对接 Core PluginStatusBar 刷新状态 │
│ - 严格识别正常中止 (Esc / 切页 / abort)，杜绝下游假性报错冒泡          │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 调度纯领域执行 (无 UI 副作用)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Action 纯领域层 (SingleImageAction / DocumentBatchAction / ...)         │
│ - 纯领域逻辑执行者，专注扫描、节点定位、编码评估与块安全改写           │
│ - 严禁在 Action 内部直接调用 showMessage 发送全局通知气泡 (防重复弹窗)   │
│ - 遇异常、冲突或取消时返回纯数据结构化结果，由 Controller 统筹呈现     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ 调用独立算法与编解码模块
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 独立算法域 (similarity/ & ImageCodec)                                  │
│ - 纯函数 MS-SSIM 计算、自适应搜索、内联 Worker 线程 Session 管理        │
│ - 零宿主 API / DOM 依赖，支持独立单元测试与算力平台分流                │
└────────────────────────────────────────────────────────────────────────┘
```

#### 2. 子模块技术职责表

| 子模块文件 | 核心类 / 单元 | 职责与技术边界 |
|---|---|---|
| `ImageCompressorFeature.ts` | `ImageCompressorFeature` | Feature 入口；注册菜单、事件监听；提取 Protyle 与 blockID 上下文后直接委托 `ImageController`；所有监听句柄由 `FeatureScope` 集中托管与注销 |
| `ImageController.ts` | `ImageController` | 业务编排唯一门面；负责全局开关与白名单准入校验；调度 Action 与 `ImageTaskPanel` 进度模态框；接入 Core `UiFeedback` 发送统一通知，接入 Core `PluginStatusBar` 维护底栏轻量任务文本；统筹当前文件进度与正常中止静默；针对空任务批次与扫描无符合项提供明确提示 |
| `ImageCandidateClassifier.ts` | `classifyImageCandidate` | 纯路径与扩展名前置准入分类器；统一过滤常见视频扩展名、动态图（GIF/APNG）、矢量图（SVG）与 Excalidraw 及绘图专用目录（精确限定为 `drawings/` 与 `drawing/` 目录路径，保护 `drawing-xxx.png` 等普通文件名）；在扫描、上传前置、外链与读取前统一设防 |
| `AutoUploadHandler.ts` | `AutoUploadHandler` | 监听 Protyle 编辑器上传事件；**上传前纯同步授权与候选预筛选**：在 `before-upload-assets` 中纯同步判断授权和候选图片预筛选，未授权或无图片时不创建 MutationObserver，零开销退出；授权且存在候选图片时挂载观察器并同步注册 `onComplete`；捕获上传完成事件后等待块落盘锁定图片位置，无退避轮询与死锁状态；仅返回纯数据结构 `AutoUploadNotice` |
| `RemoteImageWatcher.ts` | `RemoteImageWatcher` | 监听新插入 HTTP/HTTPS 外链图片；**未授权低开销设防**：在入口及 `sweep()` 扫描入口设防，未授权文档中严禁向内核发起 `blockDOM` 网络请求与全量 DOM 解析；支持黑白名单配置热重载（通过 Store 订阅同步更新），联动 `getActiveEditor()` 获取当前激活 Protyle 实例；在 Protyle 销毁（`destroy-protyle`）时注销观察器与定时器；授权文档中外链资源桌面端走 `/api/network/forwardProxy` 转发代理挂载全局 User-Agent，移动端/Web 端遵循端侧安全策略 |
| `ImageOccurrenceResolver.ts` | `ImageOccurrenceResolver` | 在 DOM 树中建立 `OccurrenceTarget` 精确定位（`rootID` + `notebook` + `blockID` + `imageOrdinal` + `oldPath`） |
| `src/features/image-compressor/similarity/` | 智能压缩独立子模块 | 划分独立的相似度算法域：包含 `SimilarityEvaluator`、`computeMSSSIM`、`adaptiveQualitySearch`、`SimilarityWorkerSession` 与内联 Worker；负责多尺度相似度评估与质量搜索 |
| `image.ts` / `BicEncoder.ts` | `BicEncoder` | 封装基于 WebP 编码器的物理生成引擎；严格执行保尺寸校验、EXIF 探测、整数网格对齐与输出字节完整性核验 |
| `ImageProcessingServices.ts` | `ImageProcessingServices` | 聚合读取、本地化、编码、上传与写回步骤的编排服务层；统一执行分类器与持久化前置闸门；以思源内核 `/api/asset/upload` 响应（`succFiles[0].index === 0` 且 `failedFiles.length === 0`）为落盘确认依据 |
| `ImageCompressionRecordStore.ts` | `ImageCompressionRecordStore` | 专职管理 `feature-image-compressor-records.json` 磁盘持久化，实现持久化前置闸门 |
| `SafeBlockWriter.ts` | `SafeBlockWriter` | 进程内单写租约控制器（`withBlockWriteLease`），写前读回节点核验，调用 `/api/block/updateBlock` 并直接信任内核成功响应（`code === 0`），无需后置读回复核；中止时显式抛出 `AbortError` 或返回专用取消结果（如 `"aborted"`），严禁混淆为 `conflict` |
| `ImageRecordsDock.svelte` | Svelte 5 组件 | 嵌入 Core 统一 Dock 的 Tab 视图，提供顶部 Hero 品牌卡片区（52px~56px，避开右上角 32px 浮动 Snackbar）、记录浏览、初始 present 状态与挂载自动异步核验、状态 Badge 纯主题 CSS 变量渲染（严禁硬编码 Hex，保证深浅模式对比度）、对称双向引用管理（查找原图引用/恢复原图引用，直接执行无需二次弹窗；严格区分主动查找与操作静默刷新；防覆盖铁律；全部处理完毕后自动收起展开区并保留成功统计）、记录持久化纯手动管理与零自动淘汰（`statAsset` 失败仅在 UI 标记为 `unknown` 状态，绝对严禁自动调用 `removeRecord`）、持有组件专属 `AbortController` 并在卸载时取消在途检索与核验、`findAssetReferences` 遇到加密或未索引笔记本返回 `skippedNotebooks` 时展示不完整提示 |
| `SingleImageAction.ts` | `SingleImageAction` | 纯领域单图处理，涵盖图片右键“压缩此图片”（直接执行）与“压缩…”（预览对话框）业务动作，作用域严格限定为仅替换当前选中的单处引用（最小副作用原则）；对话框生命周期内持有原图 Blob 缓存，重新调整参数时不重复向内核发起下载；在 `replace: false` 预览模式下仅生成 WebP 资产并写入业务记录供用户复制，严格执行零文档写回（`updateBlock` 调用次数为 0）；不调用 `showMessage`，统一向 Controller 返回纯数据结构 `ImageActionOutcome` |
| `DocumentBatchAction.ts` | `DocumentBatchAction` | 纯领域文档批量处理；通过 `activeDocuments: Set<string>` 维护当前正在处理的文档集合防止并发重复拉起；**只读 SQL 批量查询加速**：扫描当前文档图片块采用思源只读 SQL（`/api/query/sql`，如 `SELECT id, markdown FROM blocks WHERE root_id = ? AND markdown LIKE '%assets/%'`）在 1 次请求中批量获取所有图片块；同源图片合并编码；执行桌面端 2 / 移动端 1 有界并发准备；字节数统计直接复用 `OccurrenceCompressionResult`，不重复读取磁盘；进度明确划分 `preparing`（包含 `uploaded` 统计）与 `applying`（`completed / total`）；逐位置独立执行 OccurrenceTarget 节点核验与改写；向 Controller 返回纯数据结构 `CompressionBatchSummary` |
| `ImageSettingsPanel.svelte` | Svelte 5 组件 | 设置卡片组件，调用思源内核原生 `/api/filetree/getFullHPathByID` 解析并展示包含笔记本全名的白名单完整层级路径；支持智能压缩总开关与目标相似度配置 |

#### 3. 智能压缩质量计算模块解耦与性能契约

智能压缩通过客观图像质量指标（MS-SSIM）自适应探索最佳编码质量，设计遵循以下解耦与性能契约：

1. **子模块独立解耦**：
   - 算法域完全收敛在 `src/features/image-compressor/similarity/` 独立目录；
   - 包含算法纯函数（`ms-ssim.ts`）、自适应搜索逻辑（`adaptive-quality-search.ts`）、Worker 会话驱动（`SimilarityWorkerSession.ts`）与内联 Worker 脚本（`similarity.worker.ts`）；
   - 该模块不直接依赖思源内核 REST API、Protyle 编辑器 DOM 或文件存储体系，可独立进行纯数学与像素级单元测试。
2. **全平台标准 5 尺度 MS-SSIM 评估体系**：
   - 全平台统一采用标准的 **5 尺度 MS-SSIM** 评估体系，不降低尺度数量以保证质量指标的客观一致性与跨端准确性；
   - 尺度标准权重分配：`[0.0448, 0.2856, 0.3001, 0.2363, 0.1333]`；
   - 卷积核配置：$11 \times 11$ 局部高斯平滑窗口，标准差 $\sigma = 1.5$；
   - 通道加权与合成：RGB 三通道分别计算局部亮度（Luminance）、对比度（Contrast）与结构项（Structure），依据标准亮度加权系数合并；
   - **Alpha 通道与预乘优化 (Alpha-Premultiply)**：对含透明通道图片执行 Alpha 预乘，像素色值严格按公式 $\text{RGB} \times (\alpha / 255)$ 缩放计算，将全透明像素（$\alpha = 0$）的 RGB 色值归零，消除透明背景下因杂色数据导致的假性结构差异；同时当存在半透明像素时将 Alpha 相似度独立加权合并。
3. **平台算力分流与搜索预算**：
   - 通过调用思源官方 `getFrontend()` 区分平台算力预算：
     - **桌面端（`desktop` / `desktop-window` / `browser-desktop`）**：单张图片最多允许 7 轮编码与评估搜索；
     - **移动端（`mobile` / `browser-mobile`）**：单张图片最多允许 5 轮编码与评估搜索；
   - **像素尺度归一化**：原图与候选图比较时，基准边长统一限制在不超过 512px（长边等比缩放至 512px，宽高比差异 $\le 0.005$），在保证高频纹理评估准确度的同时严格控制计算耗时。
4. **自包含内联 Worker 与两阶段通信协议**：
   - **Vite 内联打包机制**：Worker 脚本通过 Vite 原生 `import SimilarityWorker from "./similarity.worker.ts?worker&inline"` 打包为内联自包含 Blob Worker，彻底消除 CommonJS 打包产物与 `window.eval` 运行环境下的跨端路径解析与权限异常；
   - **两阶段通信协议（直接节省 50% 以上计算量）**：
     - **阶段一：原图预计算 (`initOriginal`)**：在单张图片质量搜索开始时，主线程向 Worker 传递原图 Blob。Worker 仅执行一次原图解码、Alpha 预乘、5 尺度降采样高斯金字塔构建，并常驻缓存原图各层的均值与方差统计量；
     - **阶段二：候选图轻量评估 (`evaluate`)**：后续质量探索轮次中，主线程仅向 Worker 传递当前轮次的候选 WebP Blob。Worker 仅对候选图进行单向解码与金字塔生成，直接与缓存的原图金字塔与统计量执行 MS-SSIM 卷积计算；单次搜索复用同一 Worker 实例，完成或中止时立即销毁释放。
5. **带区间保护的割线法 + 二分法混合搜索**：
   - 基于初始质量点探测；
   - 未达标时以最大质量为合格端点，已达标时以最小质量为不合格端点建立确定性收敛区间；
   - 当割线预测点位于安全边界内部（距端点留有 10% 裕度）时采用割线加速收敛；当预测越界、斜率分母过小或检测到非单调扰动时，安全回退为二分折半法；
   - 质量探索范围严格限制在 $[0.10, 1.00]$，质量区间收敛容差为 0.01；探索过程实时展示当前探索进度与指标，国际化文案由语言包动态解析。
6. **早停收敛与收益门槛铁律**：
   - **达标早停条件**：仅在“已达到目标相似度（默认 $\ge 0.99$）且候选 WebP 体积满足黄金收益门槛（原图 $\ge 100\text{ KiB}$，比原图节省 $\ge 4\text{ KiB}$ 且节省比例 $\ge 5\%$）”时，允许提前安全终止搜索；
   - **不可达判定红线**：若最高质量仍无法达到目标相似度，算法坚决判定为 `unreachable` 并返回未达标状态。系统绝对禁止将未达标的图片当作合格产物进行自动替换，保持原图引用不变。
7. **图片尺寸精确对齐与 EXIF 预处理 (EXIF Pre-decoding & Pixel Alignment)**：
   - 在尺寸缩放与评估前，先读取解析原图 EXIF 旋转标记（Orientation 1~8），计算真实的有效呈现宽高；
   - 缩放目标尺寸计算采用 `Math.floor` 向下取整，与底层 Canvas 位图整数网格保持严格一致，杜绝 1 像素舍入偏差导致的尺寸校验误判。
8. **智能压缩前置过滤与轻量绕过 (Pre-check Skip Gate)**：
   - 在拉起 Worker 线程前执行前置门槛评估（原图体积是否达 100KiB、图片格式是否支持等）；
   - 若未达压缩门槛，直接返回结构化的 `{ status: "skipped", reason: "below_threshold" }` 正常结果，不创建 Worker 线程，不产生额外计算开销与业务异常。

#### 4. 批量处理性能与体验契约

1. **已知字节数复用与上传落盘确认 (Zero Redundant I/O & Upload Contract)**：
   - 准备阶段（`prepareImage`）完成原图读取与 WebP 编码后，`OccurrenceCompressionResult` 明确返回已知元数据：`originalBytes`、`compressedBytes`、`quality`、`similarity`；
   - `DocumentBatchAction` 在处理完成后，直接基于返回结果累计统计信息，不进行二次读盘 I/O；
   - 资产落盘确认以思源内核 `/api/asset/upload` 响应契约（`response.code === 0`，`succFiles[0].index === 0`，`failedFiles.length === 0` 以及返回的资产路径有效性）作为唯一确认凭证。
2. **有界并发调度 (Bounded Concurrency)**：
   - 依据平台前端类型实施严格的并发控制：桌面端最大并发度为 2，移动端最大并发度为 1；
   - **阶段隔离并发原则**：并发仅应用于耗时的资源准备阶段（原图读取、智能质量搜索、WebP 上传与 Dock 记录持久化）；
   - **写回串行保障**：笔记引用的最终替换必须严格按确定顺序逐项提交给 `SafeBlockWriter`，继续受进程内块级写租约与写前节点读回比对保护，杜绝多任务并发改写破坏块结构。
3. **批量当前进度与底栏轻量反馈**：
   - `DocumentBatchAction` 在每处理完成一个引用位置后，通过 `onProgress` 回调广播当前进度（`completed` / `total`）以及当前处理的文件名 `currentFile`；
   - `ImageController` 将 `currentFile` 传入 `ImageTaskState`，驱动居中的 `ImageTaskPanel` 模态框实时展示当前正在处理的图片文件名与完成数；
   - 同时，Controller 联动调用 Core `PluginStatusBar`，在支持的桌面客户端主窗口呈现单行轻量文本（如 `图片压缩 5/18 · photo.png`）；
   - 移动端自动短路不操作状态栏；
   - 当任务正常完成、被用户中止（按 Esc / 切换标签页）或所属 Feature 停用时，Controller 统筹销毁模态框并彻底清除状态栏任务，不残留失效进度。
4. **文档批量扫描与并发去重契约 (Batch Query & Concurrency Deduplication)**：
   - **只读 SQL 批量查询加速**：文档内图片扫描采用思源只读 SQL（`/api/query/sql`，如 `SELECT id, markdown FROM blocks WHERE root_id = ? AND markdown LIKE '%assets/%'`）在 1 次请求中批量获取所有图片块，避免逐块发起网络往返；
   - 批处理控制器维护 `activeDocuments: Set<string>` 注册集合，防止针对同一文档重复并发拉起批处理任务；
   - 任务进度状态机明确区分两个执行阶段：准备与上传阶段（`phase: "preparing"`，展示 `uploaded` 进度）与节点替换阶段（`phase: "applying"`，展示 `completed / total` 进度）；
   - 扫描无符合项或全部跳过时，联动销毁模态框并由 Controller 向用户派发中性客观提示。

### 5.3 核心技术安全机制

#### 1. 进程内单写租约 (`withBlockWriteLease`) 与正常中止状态判定
思源内核块更新 API 不提供原子乐观锁或事务版本号（Revision/CAS）机制。为避免并发任务同时改写同一块导致数据冲突，系统在内存中维护按块隔离的全局写租约队列：
```typescript
const blockTails = new Map<string, Promise<void>>();

/** 针对持久化块的单写租约控制器，避免并发写冲突且不残留空闲键 */
export function withBlockWriteLease<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = blockTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => hold);
  blockTails.set(key, tail);
  return previous.catch(() => undefined).then(operation).finally(() => {
    release();
    if (blockTails.get(key) === tail) blockTails.delete(key);
  });
}
```
- **中止状态边界原则与契约 (SafeBlockWriter Abort & Cancellation Contract)**：
  - 在 `SafeBlockWriter` 获取租约排队期间或执行写入过程中，若检测到任务取消、超时或 `signal?.aborted`，或者思源内核请求因取消抛出 `AbortError`；
  - **必须显式抛出标准 `AbortError` 或返回专用的取消状态（如 `"aborted"`）**；
  - **绝对严禁将其归类、隐式吞咽或混淆为内容修改引发的并发编辑冲突（`"conflict"`）**；
  - 混淆为 `"conflict"` 会导致上层调用者向用户误报“目标图片已被修改或移动，已放弃替换当前引用”并错误计入冲突数。上层调用者捕获中止信号后静默退出，不计入冲突统计，不派发误报提示。

#### 2. Occurrence 精确匹配与放弃原则
在获得写租约后，改写流程遵循以下严谨步骤：
1. 调用 `/api/block/getBlockDOM` 获取内核当前落盘的真实 DOM；
2. 解析 DOM，定位索引为 `target.imageOrdinal` 的图片节点；
3. **基于 OccurrenceTarget 的精确节点核验**：
   - 采用块内目标 Occurrence 节点及其上下文精确比对，而非整块 HTML 字符串硬等比对，杜绝因用户并发编辑块内非目标文字导致的误报冲突，同时消除 Protyle 运行时自动刷新 `updated` 时间戳或光标属性对改写比对的干扰；
   - **大小写敏感与加密资产路径规范**：资产路径唯一标识在底层严格保持大小写敏感（区分 Linux 及大小写敏感文件系统），并完整解析与支持携带 `?box=` 参数的加密笔记本资产 URL 规范；
   - 严格核验节点三要素：
     1. 块归属未变（`blockID` 归属于目标 `rootID`）；
     2. 块内第 `imageOrdinal` 个图片节点依然存在；
     3. 该图片节点的当前资源引用路径仍精确等于 `target.oldPath`；
4. 若核验通过，仅改写该目标图片节点的引用属性并提交 `/api/block/updateBlock`；根据思源 Go 内核契约，内核返回 `code: 0` 即意味着事务落盘并广播了 WebSocket，直接信任返回值，无后置读回复核；
5. 若后台处理期间目标图片被删除、替换或序号改变，任一要素核验失败时系统安全放弃本次单处写回操作；提示文案客观反馈：`[OmniKit] 目标图片已被修改或移动，已放弃替换当前引用，WebP 已保存至记录`。

#### 3. 单图右键压缩最小副作用与零写回预览原则
- 编辑器图片右键触发的单图压缩动作（快捷压缩或弹窗微调），作用域严格限定为“仅替换当前选中的单处引用”；
- 即使同一文档中存在多处相同原图的引用，单图操作亦不触碰其他引用位置，确保操作行为完全可预期；
- 在单图微调对话框的 `replace: false` 预览/仅保存模式下，仅生成衍生 WebP 资产并写入持久化业务记录供用户复制引用路径，严格执行零文档写回（`updateBlock` 调用次数为 0）；
- 对话框在前端内存中持有原图 Blob 缓存，用户重新切换压缩参数时复用已下载原图，不重复向内核发起网络下载。

#### 4. 持久化前置闸门 (Persistence Gate)
在 `ImageProcessingServices` 中，上传与写回之间设置坚固前置闸门：
```typescript
// 1. 内核上传确认 WebP 成功 (code === 0 且 succFiles[0].index === 0 且 failedFiles.length === 0)
const uploadedPath = await this.uploadWebp(blob, filename);

// 2. 闸门：先持久化 Dock 记录至磁盘
const recordSaved = await this.recordStore.upsertRecord({
  originalPath,
  compressedPath: uploadedPath,
  updatedAt: Date.now(),
  lastOperation: mode === "replace" ? "replaced" : "saved-only"
});

if (!recordSaved) {
  // 闸门阻断：持久化失败，阻断笔记引用修改
  this.logger.error("Dock 记录持久化失败，阻断引用自动改写");
  return { status: "saved-unlinked", uploadedPath };
}

// 3. 闸门放行：仅在持久化写入确认后，才允许提交引用替换
await this.safeWriter.replaceOccurrence(target, uploadedPath);
```

#### 5. 白名单完整路径展示技术方案 (Full Hierarchical Path Resolution)
- **内核接口调用**：白名单展示明确调用思源内核原生 `/api/filetree/getFullHPathByID` 接口；
- **展示层级**：解析并展示包含笔记本全名的完整层级路径（格式：`笔记本名/父文档/文档名`），作为列表条目的加粗主标题；
- **缓存与防级联解析**：维护 `pathLookupsStarted: Set<string>` 集合，同一文档在异步解析期间不重复向内核发起请求；
- **副标题排查**：副标题展示文档精确 `rootID`，满足高级排查与一致性验证；
- **容灾回退**：若内核返回为空或文档被删除，主标题回退展示 `rootID`。

#### 6. Dock 双向引用管理与状态机制 (Bidirectional Reference Management & Lifecycle)
- **初始状态策略与挂载核验**：
  - 新建或刚压缩生成的记录，初始状态直接标记为 `present`（存在）；
  - 当外部数据加载挂载（插件启动、切换激活 Dock Tab 面板或用户点击“手动刷新”）时，系统自动执行后台异步核验，通过思源内核 `/api/asset/statAsset` 探测原图与压缩图的物理存在性，无需用户初次手动触发刷新；
- **状态 Badge 原生主题变量呈现与深浅模式自适应 (Theme-Aware Badges)**：
  - 原图与压缩图状态 Badge（`present`、`missing`、`checking`、`unknown`）样式必须严格采用思源原生主题 CSS 变量（`var(--b3-theme-primary)` / `var(--b3-theme-error)` / `var(--b3-theme-secondary)` / `var(--b3-theme-on-surface)`）与半透明派生背景（使用 `color-mix(in srgb, var(...) 15%, transparent)` 或标准透明度）；
  - **绝对严禁硬编码 Hex 颜色**（如 `#388e3c`、`#d32f2f`、`#1976d2` 等）或非自适应 RGBA 颜色，确保在深色模式（Dark Mode）与浅色模式（Light Mode）下均具备优秀的对比度与文字可读性；
- **记录持久化纯手动管理与零自动淘汰 (Manual Record Management & Zero Auto-Pruning)**：
  - 业务记录（`feature-image-compressor-records.json`）生命周期完全由用户显式触发管理（支持在 Dock 面板手动单条移除记录，或在总设置“数据管理”专区手动清空）；
  - 当内核返回资源不存在或不可达（`/api/asset/statAsset` 返回 `code !== 0`）时，系统仅在 UI 界面将该项标记为警告状态（`unknown`），系统绝对严禁自动调用 `removeRecord` 删除或修剪业务记录；
- **组件生命周期 Abort 机制**：
  - Dock 视图组件实例化专属的 `AbortController`；当组件卸载、Dock 折叠或 Tab 切换销毁时，立即触发中断信号，安全取消正在执行的后台引用检索与状态核验；
- **对称的双向引用管理交互**：
  - **【查找原图引用】**：展开展示引用原图（`originalPath`）的位置列表。区域标题为“当前原图引用”，辅助描述为“点击可跳转对应位置，替换后使用压缩 WebP”。支持点击文本调用 `openTab` 跳转定位并高亮对应块。单项提供“替换此处”按钮，列表底部提供“替换所有处”按钮。直接执行，无需弹窗二次确认；若思源内核 `findAssetReferences` 返回 `skippedNotebooks`，Dock 界面展示引用可能不完整的中性提示；
  - **【恢复原图引用】**：仅在原图状态为 `present` 时可用。展开展示引用压缩图（`compressedPath`）的位置列表。区域标题为“当前压缩图引用”，辅助描述为“点击可跳转对应位置，恢复后将改回原图”。支持点击文本调用 `openTab` 跳转定位并高亮对应块。单项提供“恢复此处”按钮，列表底部提供“恢复所有处”按钮。直接执行，无需弹窗二次确认；恢复操作不删除压缩图附件；
- **路径直接复制交互**：点击原图或压缩图路径文本直接复制至剪贴板，弹出轻量 Toast 提示“已复制路径”；局域网 HTTP 部署且不支持原生剪贴板时，安全回退展示带可复制文本框的模态提示。
- **场景区分与反馈状态机 (Decoupled Lookup & Feedback State Machine)**：
  系统严格隔离“主动查找意图”与“执行写回后的静默刷新”：
  1. **用户主动展开查询（用户意图：查找引用）**：
     - 用户点击“查找原图引用”或“恢复原图引用”，触发定位；
     - 若结果集为空（`occurrences.length === 0`），Dock 顶部 Banner 按模式渲染中性提示：查找原图为空提示“当前笔记中未找到原图引用”；恢复原图为空提示“当前笔记中未找到压缩图引用”；
     - 若当前无满足条件的引用，提示明确的中性语境文案（如“当前笔记中未找到压缩图引用”），禁止展示混淆性的报错文案；
  2. **执行替换/恢复后的静默刷新与防覆盖机制 (Post-Operation Silent Refresh & Anti-Overwriting Guard)**：
     - 用户点击“替换此处”、“恢复此处”、“替换所有处”或“恢复所有处”执行改写；
     - 写回完成后，首先生成操作统计文案（如 `已替换 ${replaced} 处为压缩图；跳过或冲突 ${conflicts} 处` 或 `已恢复 ${restored} 处为原图；跳过或冲突 ${conflicts} 处`），并写入顶部 Banner 与全局轻量提示（`showMessage`）；
     - 随后调用的重新定位属于后续静默刷新，**严禁使用静默刷新的空结果冲刷或覆盖已展示的成功统计文案**；
  3. **全部处理完成后的自动收起机制 (Auto-Collapse on Completion)**：
     - 若静默刷新返回剩余列表长度为 0（即全部引用均已处理完毕），系统自动重置展开状态（`expanded = null`，`occurrences = []`），抽屉自动折叠收起，界面恢复整洁的记录卡片列表；
     - 收起的同时，顶部 Banner 与轻量通知持续驻留展示本次操作的成功统计结果，形成明确无歧义的闭环反馈。

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户
    participant Dock as ImageRecordsDock.svelte
    participant Ref as ReferenceService
    participant Writer as SafeBlockWriter
    participant Host as 思源内核

    rect rgb(240, 248, 255)
    Note over User,Dock: 场景 1：用户主动查找/恢复引用 (主动意图)
    User->>Dock: 点击【查找原图引用】或【恢复原图引用】
    Dock->>Ref: locateOccurrences(record, mode)
    Ref->>Host: POST /api/asset/findAssetReferences
    Host-->>Ref: 返回匹配块与引用列表
    alt 检索到引用位置 (count > 0)
        Dock->>Dock: expanded = { path, mode }, 展开显示引用列表
    else 无匹配引用 (count == 0)
        Dock->>Dock: 展示中性客观提示：<br/>"当前笔记中未找到原图引用" 或 "当前笔记中未找到压缩图引用"
    end
    end

    rect rgb(255, 250, 240)
    Note over User,Dock: 场景 2：执行替换/恢复与自动收起
    User->>Dock: 点击【替换/恢复此处】或【替换/恢复所有处】
    Dock->>Writer: 提交改写并执行节点读回核验
    Writer->>Host: POST /api/block/updateBlock
    Host-->>Writer: 更新确认
    Dock->>Dock: 计算统计结果并锁定 Banner: <br/>"已替换/恢复 N 处；跳过或冲突 M 处"
    Dock->>Ref: 静默刷新剩余引用 (locateOccurrences, silent=true)
    Ref-->>Dock: 返回最新剩余引用列表 (remaining)
    alt remaining.length > 0 (仍有剩余位置)
        Dock->>Dock: occurrences = remaining (保留展开列表，展示剩余条目)
    else remaining.length == 0 (全部处理完毕)
        Dock->>Dock: expanded = null (自动收起展开区，恢复整洁列表)
        Note over Dock: 严禁覆盖 Banner！持续展示本次操作成功的统计文案
    end
    end
```

#### 7. 零工作区临时文件 (Zero Workspace Temporary Files)
- 任务执行状态、队列排队与临时缓存全部保存在宿主进程内存中；
- 不向思源工作区 `data/` 或 `assets/` 写入形如 `.log`、`.journal`、`.tmp`、`.queue` 等临时文件；
- 容灾依托思源内核原生文档历史版本（Doc History）和工作区备份机制，避免污染工作区与云端同步目录。

#### 8. 空状态与边界场景防护 (Empty States & Edge Guarding)
- **批量压缩 0 张可处理图片联动销毁**：
  - 当扫描当前文档发现合规可压缩图片数为 0 时，Controller 若向用户弹出提示气泡（如“当前文档未发现可压缩图片”），**必须同时联动自动关闭/销毁居中的 `ImageTaskPanel` 进度模态框**，杜绝模态框悬挂堆叠在屏幕中央打扰用户；
- **Dock 静默刷新防覆盖铁律 (Post-Operation Anti-Overwriting Guard)**：
  - 用户在 Dock 执行单项或全部替换/恢复操作后，触发的后续引用重新定位属于辅助静默刷新；
  - 遇到网络异常或返回剩余 0 处引用时，**绝对不得冲刷覆盖本次操作产生的成功统计文案**；
  - 剩余引用数为 0 时干净收起抽屉列表，持续保留操作成功统计，杜绝向用户悬挂假性“未找到引用”或负面报错。

---

## 6. 自动标题链接功能技术实现设计

### 6.1 异步处理与原生受控事务写回全流程时序

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户
    participant Protyle as 活动 Protyle 编辑器
    participant Feature as TitledLinkFeature
    participant Controller as TitledLinkController
    participant Parser as stream-parser & dual-track
    participant SafeWriter as SafeTransactionWriter
    participant Host as 思源内核 (Kernel)

    rect rgb(240, 248, 255)
    Note over User,Feature: 步骤一：事件触发与前置准入判定
    alt 独立粘贴 URL (满足单 URL/无选区/空白修整)
        User->>Protyle: 粘贴纯 URL (原生粘贴毫秒级插入链接)
        Protyle->>Feature: 捕获输入/粘贴事件
        Feature->>Controller: 委托判定 (延迟 100~300ms 检查节点)
    else 右键菜单触发 (单链或块级批量)
        User->>Feature: 触发上下文菜单动作
        Feature->>Controller: 提取链接与块上下文并派发
    end
    end

    rect rgb(255, 250, 240)
    Note over Controller,Parser: 步骤二：文件免抓取判定与双轨流式解析
    alt 命中非网页扩展名 (.zip/.pdf/.exe/.mp4/图片等)
        Controller->>Controller: 直接提取并解码路径末尾文件名作为标题 (零网络)
    else 网页超链接
        Controller->>Parser: 发起双轨网络请求 (携带 Core 统一 UA)
        alt 桌面端 (desktop)
            Parser->>Host: 原生 fetch 流式分块读取 (Chunk Stream)
            Parser->>Parser: 嗅探编码并检测 </head> 或 </title> 闭合标签
            Parser->>Parser: 触发 64KB 熔断或闭合截断，主动取消底层网络流 (节省 95% 流量)
        else 移动端 (mobile)
            Parser->>Host: POST /api/network/forwardProxy (代理转发)
            Host-->>Parser: 返回 Base64 数据
            Parser->>Parser: 截取前 64KB 二进制流送入解码与万国码嗅探
        end
        Parser->>Controller: 返回净化与截断后的标准标题
    end
    end

    rect rgb(240, 255, 240)
    Note over Controller,SafeWriter: 步骤三：内存真理核验与原生受控事务提交
    Controller->>SafeWriter: 提交标题写回请求
    alt 当前为活动 Protyle 编辑器 (Live State 优先)
        SafeWriter->>SafeWriter: 写前核验: 目标 linkElement 存在且锚文本未被用户手动修改
        SafeWriter->>Protyle: 内存 DOM 更新 linkElement.textContent
        SafeWriter->>Protyle: 调用 protyle.updateTransactionElement(blockElement, oldHTML)
        Note over Protyle: 原生受控事务: 100% 支持 Ctrl+Z 撤销/重做并自动落盘
    else 非活动编辑器或后台更新
        SafeWriter->>Host: POST /api/block/updateBlock (dataType: "dom")
        Host-->>SafeWriter: 内核返回 code: 0 (落盘确认)
        SafeWriter->>SafeWriter: 信任内核写入确认，完成改写
    end
    end
```

### 6.2 模块职责与大网页流式保护

| 模块文件 | 核心职责 | 技术契约与边界 |
|---|---|---|
| `TitledLinkFeature.ts` | Feature 入口 | 集中注册上下文菜单（单链/块级批量）与粘贴监听；提取 Protyle 与选区上下文并委托 Controller；由 `FeatureScope` 集中托管与注销 |
| `TitledLinkController.ts` | 业务编排门面 | 负责前置准入校验、剪贴板修整、延迟防抖、非网页文件免抓取、受控并发调度与用户交互反馈收口 |
| `dual-track-fetcher.ts` | 双轨网络驱动 | 桌面端原生 `fetch` 直连分块读取；移动端通过思源内核 `/api/network/forwardProxy` 代理转发；复用 Core 平台 `general.userAgent` |
| `stream-parser.ts` | 流式解析与保护 | 32KB~64KB 流式分块读取、64KB 硬熔断、`</head>` / `</title>` 截断；GBK/Big5/Shift-JIS/UTF-8 字符集嗅探与解码；`window.Lute.UnEscapeHTMLStr` 实体还原；标题归一化与截断 |
| `safe-writer.ts` | 原生受控事务写回 | 内存 DOM 优先核验；活动 Protyle 调用 `updateTransactionElement`；非活动更新调用 `/api/block/updateBlock` 并信任 `code: 0`；块级批量同块聚合写回 |
| `title-cache.ts` | 短期内存缓存 | 100 条 / 5 分钟 TTL 内存 LRU 结构；Generation Ticket 代际保护；零磁盘持久化 |

#### 1. 大网页截断与流式保护机制 (`stream-parser.ts` & `dual-track-fetcher.ts`)
为防范恶意或超大网页（如数十兆的大型 HTML、包含超长内联 Base64 图片或未压缩正文）耗尽主线程内存与带宽，系统实施两级流式截断防护：
1. **桌面端流式分块截断与网络流掐断**：
   - 桌面端直接发起 `window.fetch` 流式请求，以 Chunk Stream 模式仅读取前置 32KB~64KB 数据；
   - 在流式分块读取过程中，正则检测到 `</head>` 或 `</title>` 闭合标签时，立即调用 `ReadableStreamDefaultReader.cancel()` 主动掐断底层 TCP 连接；
   - 该机制使网络连接平均仅读取前数十 KB 即可完成网页标题解析，节省 95% 以上的网络带宽，杜绝大网页在主线程触发高内存占用；
2. **移动端 64KB 二进制硬熔断截取**：
   - 移动端通过思源内核 `/api/network/forwardProxy` 获取网络响应 Base64 字节流；
   - 前端接收后严格仅截取前 64KB 二进制流送入解码与解析器，丢弃后续全部正文数据，杜绝移动设备低内存环境下的崩溃风险；
3. **万国码自动嗅探与解码**：
   - 优先依据响应头 `Content-Type: charset=...` 识别编码；
   - 未声明响应头时在前置 Chunk 中嗅探 `<meta charset="...">` 或 `<meta http-equiv="Content-Type" content="...; charset=...">`；
   - 支持 GBK、GB2312、Big5、Shift-JIS、EUC-JP、UTF-8 等常见编码，调用浏览器原生 `TextDecoder(encoding)` 规范化转码，解决中文网站乱码问题；
   - 解码后调用思源官方内置 `window.Lute.UnEscapeHTMLStr` 接口还原 HTML 实体与 Unicode 实体。

### 6.3 内存 DOM 实时真理与原生受控事务写回

在思源 Protyle 编辑器中，编辑操作以内存 DOM 为核心。系统针对活动编辑器与后台更新确立明确的写回策略：
1. **活动编辑器：内存 DOM 优先与受控事务**：
   - 当目标链接处于当前激活打开的 Protyle 编辑器内时，内存 DOM 呈现用户的实时输入状态；
   - **写前核验**：检查目标 `linkElement` 是否依然存在于当前 DOM 树中，且其内部文本是否未被用户手动修改；
   - **局部 DOM 更新**：核验通过后，直接在内存 DOM 中更新 `linkElement.textContent`（开启 `replaceTitle` 时同步更新 `data-title` 属性），严禁改写 `data-href`；
   - **提交受控事务**：调用思源官方编辑器事务接口：
     ```typescript
     protyle.updateTransactionElement(target.blockElement, oldBlockOuterHTML);
     ```
   - **原生撤销与历史版本**：该事务调用使思源编辑器将本次标题修改纳入原生撤销栈，100% 支持用户使用 `Ctrl+Z` 撤销与 `Ctrl+Y` 重做，并由思源编辑器自动同步触发块落盘与 Doc History 记录；
2. **非活动编辑器或后台更新**：
   - 当目标块不在当前激活的 Protyle 编辑器中时，系统调用思源内核 REST API `/api/block/updateBlock`（`dataType: "dom"`）；
   - 根据思源 Go 内核契约，内核返回 `code: 0` 即意味着落盘并广播了 WebSocket 事务，系统直接信任该返回值完成写回；
3. **块级批量同块聚合写回**：
   - 在块级批量提取模式下，同块内所有链接拉取完成后，在单次 `updateTransactionElement` 事务中将该块内所有已完成的链接一并提交；
   - 消除同块内多次提交引发的撤销历史碎片，用户仅需按一次 `Ctrl+Z` 即可一次性恢复当前块内所有被提取链接的原始状态。

### 6.4 短期内存 LRU 缓存与任务代际保护

1. **短期内存 LRU 结构**：
   - 采用纯内存短期 LRU 缓存，最大容量 100 条，TTL 存活时限为 5 分钟；
   - 自动模式下优先查询缓存，命中且未过期时直接复用，避免在同一文档内重复粘贴相同链接时消耗网络带宽；
   - 手动单链提取模式强制绕过缓存发起真实网络请求，满足用户强制刷新标题的诉求；
2. **任务代际保护 (Generation Ticket)**：
   - 每个缓存条目与任务持有自增代际版本号；手动操作或新任务启动时代际增加，迟到的历史异步请求在完成时比对代际，若已过时则安全丢弃，防止陈旧数据覆盖最新标题；
3. **零工作区污染**：
   - 缓存仅驻留于宿主内存，不向思源工作区 `data/` 目录写入任何缓存或排队文件，功能停用或插件注销时随作用域安全释放。

---

## 7. 新 Feature 扩展开发指南

当团队或 Agent 需要向 OmniKit 增加新的业务特性时，必须严格执行以下开发步骤与契约清单：

### 7.1 开发步骤指南
1. **需求与技术实现严格解耦先行**：在 `docs/features/<feature-name>/` 目录下分别建立 `PRD.md`（纯产品需求文档：功能描述、用户交互、业务规则与验收用例，遇到 BUG 或代码重构时不随意改动产品规范）与 `DESIGN.md`（技术实现设计文档：架构分层、模块协作、算法数据流与底层 API 契约，遇到 BUG 或代码实现调整时独立更新技术设计），完成评审与 Spec-Freeze；
2. **建立特性目录**：在 `src/features/<feature-name>/` 下创建特性包，包括：
   - `settings.ts`：定义配置 TypeScript 类型与默认值；
   - `registration.ts`：定义 `FeatureRegistration<T>` 元数据，声明支持端列表 `frontends`（可选，5+1 取值集合，省略或空数组时默认为全端支持），指定配置文件为 `feature-{id}-settings.json`；
   - `<FeatureName>Feature.ts`：派生自 `BaseFeature`，重写 `onEnable()` 与 `onDisable()`；
   - `<FeatureName>SettingsPanel.svelte`：Svelte 5 实现的专属设置组件；
   - 可选：若有 Dock 需求，提供 Svelte 5 Dock 视图组件。
3. **Core 元数据挂载**：在 `src/core/OmniKitPlugin.ts` 的 `registrations` 数组中添加该 Feature 的注册项；
4. **国际化补充**：在 `src/i18n/zh-CN.json` 和 `src/i18n/en.json` 添加对应的特性标题、描述及业务文案；
5. **保持 Core Schema 独立**：新特性的专属配置项保存在特性独立配置文件中，不写入 `omnikit-core.json`。

### 7.2 Feature 扩展技术契约自查清单 (Feature Checklist)
- [ ] Feature 是否纯粹面向 `BaseFeature` 和 `FeatureContext` 编程？
- [ ] 是否不存在任何跨 Feature 的直接代码引用（`import`）？
- [ ] 是否按需声明了平台兼容性列表 `frontends`（5+1 取值集合，缺失或空数组时默认为全端支持）？在不受支持的环境下是否平稳保持在 `unsupported` 状态，不挂载任何资源与菜单，且不破坏跨端云同步中的启用偏好？
- [ ] 设置文件命名是否严格为 `feature-${id}-settings.json`？
- [ ] 业务数据文件命名是否严格为 `feature-${id}-{dataname}.json`？
- [ ] 业务数据记录是否遵循纯手动管理与零自动淘汰原则，严禁在 `statAsset` 失败时自动删除记录？
- [ ] 长时间异步任务是否传递并感知了 `context.scope.signal`？
- [ ] 菜单动作是否由 `MenuRegistry` 权威收口分流（顶栏自有菜单无前缀，外部宿主上下文菜单自动补齐 `[OmniKit] ` 前缀，禁止 Feature 层硬编码）？
- [ ] 顶栏下拉菜单中 Core 平台项（「OmniKit 设置」）与下方 Feature 选项之间是否使用了 `menu.addSeparator({ id: "separator_settings" })` 原生分隔线？
- [ ] 设置面板左侧导航分组标题是否规范使用国际化键 `nav.features`，杜绝任何硬编码或三元表达式？
- [ ] Dock 顶部是否具备 52px~56px 品牌 Hero 卡片区，操作区下移 50px 以上避开思源右上角 32px 浮动 Snackbar？
- [ ] Dock 状态 Badge 是否严格采用思源原生主题 CSS 变量（无硬编码 Hex 颜色），保证深浅模式对比度？
- [ ] 新图插入在未授权文档中是否彻底静默退出（不弹气泡、不挂载无意义 MutationObserver、不向内核发起 blockDOM 请求）？
- [ ] 用户按 Esc、切换标签页或 `signal.abort` 是否判定为正常中止并静默退出，未误报为无法定位或并发冲突？
- [ ] `SafeBlockWriter` 中止是否显式抛出 `AbortError` 或专用取消状态，严禁混淆为 `conflict`？
- [ ] 批量处理 0 张图片时是否联动销毁了 `ImageTaskPanel` 模态框？
- [ ] Dock 静默刷新是否遵循防覆盖铁律，未冲刷覆盖操作成功统计？
- [ ] 是否遵循 Feature（上下文分发）、Controller（参数校验与统一用户提示）、Action（纯领域执行）的单向职责划分？
- [ ] 是否避免向思源工作区写入任何临时调试或排队文件？
- [ ] 是否未调用任何主动删除原图或压缩图资产的 API？
- [ ] 块改写是否基于 `OccurrenceTarget` 精确节点核验而非整块字符串比对？
- [ ] 单图操作作用域是否严格限定为选中的单处引用？

---

## 8. 工程化脚本体系与构建工具链

OmniKit 的工程化工具链统一人性化收敛在 `scripts/` 目录体系中，各脚本遵循单一职责原则（Single Responsibility Principle）与高可靠防御性设计，支撑从本地开发、静态校验到发布归档的全生命周期。

### 8.1 统一脚本目录架构与分工

项目工程脚本收敛于如下规范化目录拓扑，工程根目录下不设立零散或非标准的辅助工具目录：

```text
scripts/
├── build/
│   └── render-icons.mjs       # 多端与市场高精图标渲染
├── dev/
│   └── install-workspace.mjs  # 开发态向思源工作区安全安装与原子备份恢复
├── release/
│   ├── read-version.sh        # CI 手动发版从 plugin.json 提取版本并校验 X.Y.Z 语义化
│   ├── reconcile-tag.sh       # 处理已有同名 Tag 与 GitHub Release 的状态协调
│   ├── update-version.mjs     # plugin.json 与 package.json 双文件原子同步版本升级工具
│   ├── verify-package.mjs     # 产物包清单、版本强一致与入口静态校验
│   └── release.mjs            # 本地发版准备与校验工作流入口（对应 pnpm release）
└── clean.mjs                  # 产物清理工具（对应 pnpm clean）
```

#### 脚本职责与执行契约

| 脚本路径 | 对应 NPM 指令 | 运行环境与触发时机 | 核心技术职责 |
|---|---|---|---|
| `scripts/build/render-icons.mjs` | `pnpm render:icons` | 本地构建与 CI 构建 (`dev`, `build:app`) 前置 | 基于 `@resvg/resvg-js` 从 `assets/omnikit-plugin.svg` 渲染 $160 \times 160$ 像素 PNG 图标至 `.generated/icon.png`，核验文件体积 $\le 64\text{ KiB}$ |
| `scripts/dev/install-workspace.mjs` | `pnpm install:workspace` | 本地开发调试（需传入工作区路径参数） | 向指定思源工作区 `data/plugins/siyuan-plugin-omnikit` 安全安装插件产物，执行路径逃逸防御、目标清单完整性核验、临时暂存部署与原子备份回滚 |
| `scripts/release/read-version.sh` | CI 内部调用 | GitHub Actions 手动发布（`workflow_dispatch`）前置 | 校验触发分支为默认分支（`main`），使用 `jq` 从 `plugin.json` 提取版本号，严格核验 SemVer `X.Y.Z` 规范，输出 `release_tag=v${version}` 至 `$GITHUB_OUTPUT` |
| `scripts/release/reconcile-tag.sh` | CI 内部调用 | GitHub Actions 手动发布产物构建与检验通过后 | 基于 GitHub REST API 查询目标 Tag 与 Release 状态，递归解析 Annotated Tag，依据状态矩阵执行 Tag 复用、幂等终止或旧提交覆盖清理 |
| `scripts/release/update-version.mjs` | `pnpm version:update <X.Y.Z>` | 本地版本升级维护 | 校验输入版本号符合 `X.Y.Z`，原子化同步读写更新 `plugin.json` 与 `package.json` 中的 `version` 字段，确保两份清单完全一致并符合 JSON 格式 |
| `scripts/release/verify-package.mjs` | `pnpm package:verify` | 本地测试与 CI 门禁构建后 | 静态校验 `dist/` 物理产物清单完整性、集市图标规范、文档引用有效性、双清单版本一致性、`minAppVersion` 字段以及原生解析 `package.zip` Central Directory 校验条目与排除项（严禁包含 `kernel.js` 和 `node_modules/`） |
| `scripts/release/release.mjs` | `pnpm release` | 本地发版准备流水线 | 本地自动化发版入口，闭环执行版本递增确认、类型检查（`pnpm check`）、全量单元测试（`pnpm test`）、生产构建（`pnpm build:app`）、包验证（`pnpm package:verify`）与解包测试，并在完成后输出标准 Git 提交与 Tag 推送指引 |
| `scripts/clean.mjs` | `pnpm clean` | 本地维护与构建重置 | 跨平台递归清理 `dist/`、`.generated/`、`package.zip` 等所有本地构建生成的临时目录与打包产物，使工作区恢复纯净基线 |

#### NPM 脚本映射契约

在 `package.json` 中，工程命令与底层脚本保持一一对应的确定性契约绑定：

- `pnpm dev`：执行 `pnpm render:icons` 后启动 Vite 监听构建（开发模式）；
- `pnpm check`：执行 `tsc --noEmit -p tsconfig.omnikit.json` 与 `svelte-check --tsconfig ./tsconfig.omnikit.json`；
- `pnpm test`：通过 Node.js 原生 Test Runner（`--experimental-transform-types`）执行 `tests/**/*.test.mjs` 全量单元测试；
- `pnpm build`：串行执行 `pnpm check && pnpm test && pnpm build:app` 完整构建流水线；
- `pnpm build:app`：执行 `pnpm render:icons` 后调用生产级 Vite 构建输出 `dist/` 与 `package.zip`；
- `pnpm render:icons`：调用 `node scripts/build/render-icons.mjs`；
- `pnpm install:workspace`：调用 `pnpm build && node scripts/dev/install-workspace.mjs`；
- `pnpm package:verify`：调用 `node scripts/release/verify-package.mjs`；
- `pnpm release`：调用 `node scripts/release/release.mjs`；
- `pnpm clean`：调用 `node scripts/clean.mjs`。

### 8.2 核心构建与工具链实现契约

#### 1. 多端与市场高精图标渲染规范 (`scripts/build/render-icons.mjs`)
- **渲染引擎与入参**：基于 `@resvg/resvg-js` 高性能 Rust 原生 SVG 渲染引擎，输入源文件为 `assets/omnikit-plugin.svg`；
- **输出隔离**：渲染结果输出至 `.generated/icon.png` 临时构建目录，仓库根目录下不留存或追踪静态 `icon.png`；
- **渲染配置**：
  - `fitTo: { mode: "width", value: 160 }`：生成符合思源笔记集市标准规范的 $160 \times 160$ 像素 PNG 图标；
  - `font: { loadSystemFonts: false }`：禁用系统字体探测，确保在不同 OS 构建环境（Linux CI、macOS、Windows）下的渲染结果具备二进制级别的幂等稳定性；
- **双重断言门禁**：
  - 几何尺寸核验：渲染宽度与高度必须精确等于 160 像素，否则直接抛出异常；
  - 体积门禁：产物大小必须严格 $\le 64\text{ KiB}$，杜绝超大图标阻塞思源集市加载；
- **打包集成**：由 Vite 构建配置通过 `vite-plugin-static-copy` 将 `.generated/icon.png` 复制归档为 `dist/icon.png`。

#### 2. 开发态工作区安全安装与原子备份回滚 (`scripts/dev/install-workspace.mjs`)
- **真实物理路径与防逃逸核验**：
  - 调用 `requireRealDirectory` 严格验证用户传入的思源工作区路径为物理真实目录；
  - 严禁目标路径为软链接（`isSymbolicLink()` 立即拒绝）；
  - 递归核验内部关键子目录：`conf/`、`data/`、`data/.siyuan/` 与 `data/plugins/` 必须真实存在；
  - 解析工作区规范化路径（`realpath`），严格检查相对路径，杜绝向上逃逸出工作区根目录；
- **目标插件目录所有权防御**：
  - 若目标目录 `data/plugins/siyuan-plugin-omnikit` 已存在，必须读取其内部的 `plugin.json`；
  - 严格校验其 `name` 属性必须精确等于 `"siyuan-plugin-omnikit"`；若不匹配，坚决拒绝覆盖并报错退出，防止因路径误配损坏其他第三方插件；
- **待部署构建产物完整性前置核验**：
  - 在执行任何写入前，校验 `dist/` 下必须完整包含：`plugin.json`、`index.js`、`index.css`、`icon.png`、`README.md`、`README.zh-CN.md`、`browser-image-compression.js`、`assets/`、`i18n/`；
- **两阶段暂存部署与原子备份恢复**：
  1. 生成包含高精度时间戳与 UUID 的专属暂存目录 `.${pluginName}.install-${Date.now()}-${uuid}`；
  2. 将产物文件及资源目录完整写入暂存目录；
  3. 若目标目录已存在旧版本，将其重命名为 `${pluginName}.backup-${Date.now()}-${uuid}` 完整保留作为容灾备份；
  4. 将暂存目录原子重命名为正式插件目录名 `${pluginName}`；
  5. **异常容灾保障**：若重命名或文件写入中途遭遇任何异常，捕获错误后立即清理暂存目录，并将备份目录重命名恢复为正式插件目录，确保思源工作区绝不处于半安装、损坏或空目录状态。

#### 3. 双清单版本原子同步规范 (`scripts/release/update-version.mjs`)
- **语义化版本严格核验**：使用正则表达式 `^[0-9]+\.[0-9]+\.[0-9]+$` 校验目标版本号，必须为标准的三段式 `X.Y.Z` 格式，拒绝带有非规范前缀或预发布后缀的输入；
- **原子同步写入**：
  - 同步读取 `plugin.json` 与 `package.json`；
  - 同步更新两份清单中的 `version` 属性；
  - 以标准 2 空格缩进格式化序列化并追加末尾换行符写入磁盘；
  - 写后读回重新解析校验 JSON 语法完整性，确保两份清单始终保持完全一致。

#### 4. 产物包结构静态核验规范 (`scripts/release/verify-package.mjs`)
- **双清单版本强一致校验**：`package.json.version === dist/plugin.json.version`；
- **思源内核最低版本约束**：`dist/plugin.json.minAppVersion === "3.8.4"`；
- **物理产物存在性与非空校验**：
  - 核验必须文件：`dist/index.js`、`dist/index.css`、`dist/plugin.json`、`dist/README.md`、`dist/README.zh-CN.md`、`dist/i18n/en.json`、`dist/i18n/zh-CN.json`、`dist/browser-image-compression.js`、`dist/icon.png`、`dist/assets/omnikit-menu.svg`、`dist/assets/omnikit-plugin.svg` 及 `package.zip` 全部存在且大小 $> 0$；
  - 仓库根目录防御：断言根目录下严禁散落未管理的 `icon.png`；
- **PNG 标头与集市规格深度核验**：
  - 读取 `dist/icon.png` 二进制数据，比对前 8 字节 PNG 魔数标头 `[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]`；
  - 读取 IHDR 块第 16~23 字节，核验宽度与高度均为 160 像素；
  - 核验字节大小 $\le 64\text{ KiB}$；
- **文档静态资源链接完整性**：校验 `README.md` 与 `README.zh-CN.md` 正文中明确引用 `assets/omnikit-plugin.svg`；
- **国际化语法解析校验**：校验 `dist/i18n/en.json` 与 `dist/i18n/zh-CN.json` 能够被合法解析为标准 JSON 对象；
- **零依赖原生 ZIP Central Directory 静态审查**：
  - 避免引入外部依赖，直接从 `package.zip` 尾部定位 End of Central Directory (EOCD) 标头 `0x06054b50`；
  - 解析 Central Directory 偏移与条目总数，逐条遍历 Central Directory Header `0x02014b50` 提取所有分发文件条目路径；
  - 必须包含所有必要分发文件条目：`index.js`、`index.css`、`plugin.json`、`i18n/en.json`、`i18n/zh-CN.json`、`browser-image-compression.js`、`icon.png`、`assets/omnikit-menu.svg`、`assets/omnikit-plugin.svg`；
  - **安全排除红线**：断言 ZIP 包内**绝对严禁包含 `kernel.js`**，**绝对严禁包含 `node_modules/` 下的任何文件**。

#### 5. 本地发版闭环工作流 (`scripts/release/release.mjs`) 与产物清理 (`scripts/clean.mjs`)
- **发版闭环工作流 (`release.mjs`)**：
  - 协调本地完整的发版准备工作；
  - 串行执行全套质量流水线：版本一致性检查、`pnpm check`（类型与 Svelte 检查）、`pnpm test`（全量单元测试）、`pnpm build:app`（生产打包）、`pnpm package:verify`（包静态校验）与 `unzip -t package.zip`（压缩包解压测试）；
  - 全量门禁通过后，向控制台输出标准的 Git 提交与 Tag 推送指引，实现本地发版准备的确定性闭环；
- **产物清理工具 (`clean.mjs`)**：
  - 跨平台安全清理 `dist/`、`.generated/`、`package.zip` 以及测试与构建临时文件，使工作区恢复干净基线。

---

## 9. CI/CD 与多入口自动化发版架构规范

OmniKit 构建并维护高可靠、自动化的 CI/CD 体系，通过 `.github/workflows/ci.yml` 守护日常代码提交质量，通过 `.github/workflows/release.yml` 实现多入口、幂等且具备防递归安全机制的自动化发版。

### 9.1 双触发模型与发布架构拓扑

发版工作流同时支持“本地推送 Tag”与“GitHub Actions 界面手动一键发版”双入口，两套入口共享完全一致的构建与质量门禁流水线：

```mermaid
flowchart TD
    subgraph Trigger["发版触发入口 (Release Triggers)"]
        TagPush["本地推送 Tag<br/>(git push origin vX.Y.Z)"]
        ManualDispatch["GitHub Actions 手动一键发版<br/>(workflow_dispatch / 无输入参数)"]
    end

    subgraph VersionResolution["版本解析与权威源确定"]
        CheckBranch["默认分支核验 (ref_name == default_branch)"]
        ExtractVersion["scripts/release/read-version.sh<br/>读取 plugin.json.version 并校验 X.Y.Z"]
        ResolvedTag["确定 RELEASE_TAG (vX.Y.Z)"]
    end

    subgraph QualityGate["全流程质量防护门禁 (Quality Gate Pipeline)"]
        EnvSetup["Node 24 + pnpm 11.4.0 锁定环境"]
        FrozenInstall["pnpm install --frozen-lockfile"]
        VersionCheck["三方版本一致性强校验<br/>RELEASE_TAG == package.json == plugin.json"]
        TypeCheck["pnpm check (TypeScript & Svelte 5)"]
        UnitTests["pnpm test (全量单元测试)"]
        BuildApp["pnpm build:app (图标渲染与生产打包)"]
        VerifyPkg["pnpm package:verify (清单/图标/ZIP结构静态校验)"]
        ZipTest["unzip -t package.zip (压缩完整性测试)"]
    end

    subgraph ReconcileTag["Tag 与 Release 状态协调 (reconcile-tag.sh)"]
        QueryState["GitHub REST API 查询同名 Tag 与 Release"]
        ResolveCommit["解析 Annotated Tag 获得目标 commit SHA"]
        DecideAction{"状态转移判定"}
        ReuseTag["复用现有 Tag"]
        AbortDup["幂等拦截: 已存在且指向当前提交，终止发布"]
        DeleteOld["删除指向旧提交的旧 Release 与旧 Tag"]
    end

    subgraph PublishStage["正式发布与产物归档 (Publish Stage)"]
        GhRelease["gh release create (使用 GITHUB_TOKEN)<br/>天然防递归二次触发"]
        NcipolloAction["ncipollo/release-action<br/>发布 Release 与 package.zip"]
        Finish["发布完成: OmniKit vX.Y.Z (包含 package.zip)"]
    end

    TagPush -->|push.tags 触发| QualityGate
    ManualDispatch -->|workflow_dispatch 触发| CheckBranch
    CheckBranch --> ExtractVersion
    ExtractVersion --> ResolvedTag
    ResolvedTag --> QualityGate

    QualityGate --> EnvSetup
    EnvSetup --> FrozenInstall
    FrozenInstall --> VersionCheck
    VersionCheck --> TypeCheck
    TypeCheck --> UnitTests
    UnitTests --> BuildApp
    BuildApp --> VerifyPkg
    VerifyPkg --> ZipTest

    ZipTest -->|workflow_dispatch 分支| ReconcileTag
    ZipTest -->|push.tags 分支| NcipolloAction

    ReconcileTag --> QueryState
    QueryState --> ResolveCommit
    ResolveCommit --> DecideAction
    DecideAction -->|未发布且指向当前提交| ReuseTag
    DecideAction -->|已发布且指向当前提交| AbortDup
    DecideAction -->|指向旧提交| DeleteOld
    DecideAction -->|Tag与Release均不存在| GhRelease

    ReuseTag --> GhRelease
    DeleteOld --> GhRelease

    GhRelease --> Finish
    NcipolloAction --> Finish
```

### 9.2 单一版本权威源与默认分支保护

- **单一版本权威源**：
  - 思源笔记生态将 `plugin.json` 作为识别插件元数据与版本的唯一官方契约；
  - 手动一键发版时，工作流不设立任何外部手动输入参数框，统一由 `scripts/release/read-version.sh` 从 `plugin.json` 中的 `version` 提取；
  - 自动生成的发布标签固定为 `v${plugin.json.version}`；
- **默认分支保护原则**：
  - `read-version.sh` 严格校验 `SELECTED_REF === DEFAULT_BRANCH`（通常为 `main`）；
  - 严禁从临时特性分支、开发分支手动触发正式发布流水线，确保发布的代码必然归属于主干分支；
- **语义化版本约束**：
  - 提取的版本号必须严格匹配 `^[0-9]+\.[0-9]+\.[0-9]+$` 格式；
  - 若包含非标准后缀或格式不合规，脚本立即报错并终止流水线。

### 9.3 全流程质量防护门禁 (Quality Gate Pipeline)

无论通过何种入口触发，所有发版任务必须依次通过以下 8 道刚性质量防护门禁，任一步骤失败立即阻断发布：

1. **确定性运行时与包管理器装配**：
   - 锁定 Node.js 运行时版本：Node 24（启用 pnpm 缓存）；
   - 锁定 pnpm 包管理器版本：pnpm 11.4.0；
2. **锁文件冻结安装**：
   - 执行 `pnpm install --frozen-lockfile`，确保依赖树与 `pnpm-lock.yaml` 绝对一致，杜绝依赖漂移；
3. **三方版本一致性强校验**：
   - 校验当前发布目标 Tag 与两份清单中的版本号完全一致：
     ```bash
     RELEASE_TAG="${steps.version.outputs.release_tag || github.ref_name}"
     test "${RELEASE_TAG#v}" = "$(node -p "require('./package.json').version")"
     test "${RELEASE_TAG#v}" = "$(node -p "require('./plugin.json').version")"
     ```
4. **静态类型与模板检查**：
   - 执行 `pnpm check`（包含 TypeScript 严格类型检查 `check:types` 与 Svelte 5 模板类型检查 `check:svelte`）；
5. **全量自动化测试**：
   - 执行 `pnpm test`，运行 Core 平台框架、存储系统、生命周期及所有 Feature 的全量单元测试与契约测试；
6. **生产环境完整构建**：
   - 执行 `pnpm build:app`，包含图标渲染与 Vite 生产打包，输出 `dist/` 目录与 `package.zip` 归档包；
7. **产物包清单与静态结构校验**：
   - 执行 `pnpm package:verify`，全面校验文件清单、双版本一致性、集市图标规范以及 `package.zip` 内置 Central Directory 条目完整性与黑名单（无 `kernel.js`、无 `node_modules/`）；
8. **压缩包完整性解包测试**：
   - 执行 `unzip -t package.zip`，底层校验 ZIP 压缩包的 CRC32 与物理完整性。

### 9.4 Tag 与 Release 状态协调矩阵 (`reconcile-tag.sh`)

在手动发版流程中，`reconcile-tag.sh` **严格位于产物构建与所有质量门禁全部通过之后**执行，确保构建失败时绝不提前对远端 Tag 或 Release 产生破坏性副作用。

脚本通过 GitHub REST API 递归解析 Annotated Tag 至 commit SHA，并依据状态矩阵执行协调处理：

| Git Tag 状态 | GitHub Release 状态 | 处理动作与策略 | 核心设计意图 |
|---|---|---|---|
| 不存在 | 不存在 | 放行后续流程，创建新 Tag 与 Release | 正常首次发版全新版本 |
| 指向当前提交 (`GITHUB_SHA`) | 不存在 | 复用现有 Tag，放行后续创建 Release | Tag 已在本地打好但尚未创建 Release |
| 指向当前提交 (`GITHUB_SHA`) | 已存在 | 终止发布，报错提示已发布 | **幂等设防**：杜绝重复触发导致已发布产物被意外覆盖 |
| 指向历史旧提交 | 已存在 | 调用 `gh release delete "${RELEASE_TAG}" --cleanup-tag --yes` 删除旧 Release 与旧 Tag，重新指向当前提交 | 修正发版提交，确保产物与 Tag 严格绑定当前构建 commit |
| 指向历史旧提交 | 不存在 | 调用 GitHub API `DELETE repos/.../git/refs/tags/${RELEASE_TAG}` 删除旧 Tag，重新指向当前提交 | 清除指向过时提交的孤立 Tag |
| 不存在 | 已存在 | 终止发布，报错提示状态异常 | 异常状态设防拦截 |

### 9.5 防递归死循环机制与并发安全防护

#### 1. `GITHUB_TOKEN` 防递归天然安全原理
- 在手动发版阶段，工作流通过 GitHub CLI 执行发布操作：
  ```bash
  gh release create "${RELEASE_TAG}" package.zip \
    --target "${GITHUB_SHA}" \
    --title "OmniKit ${RELEASE_TAG}" \
    --generate-notes
  ```
- 环境变量注入平台默认安全 Token：`GH_TOKEN: ${{ github.token }}`；
- **防递归原理**：依据 GitHub Actions 核心平台安全契约，**由工作流内置 `GITHUB_TOKEN` 授权产生的 Git 事件（包括通过 API 创建 Tag、创建 Release 或 Push 操作），天然不会触发仓库中配置的后续工作流**；
- 因此，工作流在手动模式下自动创建的 `v*` Tag，绝对不会二次触发 `push.tags` 分支，从根本上隔绝了递归发版死循环；
- 避免引入高权限的 Personal Access Token（PAT）或 Deploy Keys，遵循最小特权原则保障仓库权限隔离与自闭环安全。

#### 2. 发布任务并发互斥控制
- 在 `release.yml` 工作流顶部配置并发组策略：
  ```yaml
  concurrency:
    group: release
    cancel-in-progress: false
  ```
- 确保全局同一时间只能执行单个发版任务，后续触发的任务在队列中等待前序任务执行完成，严禁并发执行导致 Release 覆盖或 Git Tag 竞态损坏。

---

## 10. 自动化依赖安全与监控规范

OmniKit 通过配置 `.github/dependabot.yml` 建立生产级依赖安全与自动化维护体系，保障依赖时效性与构建环境的严格稳定性。

### 10.1 双生态监控架构

Dependabot 实施双生态覆盖体系，统一采用月度监控周期，在依赖安全与开发者审查开销之间取得最佳平衡：

```yaml
version: 2
updates:
  # 1. npm 生态：前端与构建依赖监控
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "monthly"
    versioning-strategy: lockfile-only
    groups:
      dev-dependencies:
        patterns:
          - "*"
    labels:
      - "dependencies"
      - "automated-pr"

  # 2. github-actions 生态：CI/CD 外部动作监控
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "monthly"
    groups:
      actions:
        patterns:
          - "*"
    labels:
      - "dependencies"
      - "automated-pr"
```

### 10.2 `lockfile-only` 依赖锁定保护策略

- **策略约束**：针对 `npm` 生态严格配置 `versioning-strategy: lockfile-only`；
- **保护核心**：Dependabot 仅被允许更新 `pnpm-lock.yaml` 文件中的子依赖解析版本，**绝对禁止自动修改 `package.json` 中声明的主版本号与 SemVer 范围**；
- **稳定性保障**：保全项目显式声明的依赖契约，杜绝依赖版本隐式自动上浮引发构建不一致或破坏生产稳定性。

### 10.3 Actions 核心大版本防御与自动化分组

- **核心 Actions 大版本防御**：
  - 严格锁定受信官方维护的 GitHub Actions：`actions/checkout@v4`、`actions/setup-node@v4`、`pnpm/action-setup@v4` 与 `ncipollo/release-action@v1`；
  - 仅在经过安全审查与本地回归验证后，方可升级 Actions 大版本；
- **自动化依赖分组 (PR Grouping)**：
  - 配置 `groups` 机制，将零散的依赖更新聚合为单一 PR：
    - `dev-dependencies`：将开发工具链相关的更新（如 TypeScript、Vite、Svelte、Sass、Node 类型库等）汇聚为单一 PR；
    - `actions`：将所有 GitHub Actions 依赖更新汇聚为单一 PR；
  - 自动追加 `dependencies` 与 `automated-pr` 标签，大幅提升团队审查与自动化合并效率。

---

## 11. 系统全链路自查与发版验收清单

在执行代码提交、特性上线或正式发版前，开发人员与 AI Agent 必须逐项对照以下清单执行全量核查：

### 11.1 Feature 业务与平台契约核验
- [ ] Feature 是否纯粹面向 `BaseFeature` 和 `FeatureContext` 编程，无跨 Feature 依赖？
- [ ] 是否按需声明了 `frontends` 平台兼容性列表（5+1 取值集合），在不受支持的端平稳处于 `unsupported` 且不破坏云同步偏好？
- [ ] 存储文件命名是否严格遵循 `feature-${id}-settings.json` 与 `feature-${id}-{dataname}.json`，重置设置时绝对不影响数据文件？
- [ ] 业务数据记录生命周期是否完全由用户显式触发管理，无任何自动淘汰或静默清理逻辑？
- [ ] 菜单动作是否由 `MenuRegistry` 权威收口分流（顶栏自有菜单无前缀，外部上下文菜单自动补齐 `[OmniKit] ` 前缀，禁止 Feature 层硬编码）？
- [ ] 顶栏下拉菜单中「OmniKit 设置」与下方 Feature 选项之间是否使用了 `menu.addSeparator({ id: "separator_settings" })` 原生分隔线？
- [ ] 设置面板左侧导航分组标题是否使用国际化键 `nav.features`？
- [ ] Dock 顶部是否具备 52px~56px 品牌 Hero 卡片区，操作区下移 50px 以上避开思源右上角 32px 浮动 Snackbar？
- [ ] Dock 状态 Badge 是否严格采用思源原生主题 CSS 变量（无硬编码 Hex 颜色），保证深浅模式对比度？
- [ ] 异步任务在遭遇用户按 Esc、切换标签页或 `signal.abort` 时是否判定为正常中止并静默退出？
- [ ] `SafeBlockWriter` 中止是否显式抛出 `AbortError` 或专用取消状态，严禁混淆为 `conflict`？
- [ ] 批量处理 0 项时是否联动销毁了任务进度模态框？
- [ ] Dock 改写后的静默刷新是否遵循防覆盖铁律，保留操作成功统计？

### 11.2 工程脚本与工具链核验
- [ ] 所有工程脚本是否收敛于 `scripts/` 目录体系，根目录下无非标准的 `tools/` 目录？
- [ ] `scripts/build/render-icons.mjs` 是否正确生成 $160 \times 160$ 像素且 $\le 64\text{ KiB}$ 的图标至 `.generated/icon.png`？
- [ ] `scripts/dev/install-workspace.mjs` 是否实施了软链接拒绝、路径逃逸防御、目标身份校验与原子备份回滚？
- [ ] `scripts/release/read-version.sh` 是否验证默认分支、正确读取 `plugin.json.version` 并严格校验 `X.Y.Z` 语义化格式？
- [ ] `scripts/release/reconcile-tag.sh` 是否在门禁通过后执行，并根据状态矩阵正确处理 Tag 复用、幂等终止与旧提交覆盖？
- [ ] `scripts/release/update-version.mjs` 是否原子化同步更新 `plugin.json` 与 `package.json` 的版本号？
- [ ] `scripts/release/verify-package.mjs` 是否严格核验物理清单、PNG 标头、文档引用、版本一致性与 ZIP Central Directory 条目（严禁包含 `kernel.js` 和 `node_modules/`）？
- [ ] `scripts/clean.mjs` 是否正常清理 `dist/`、`.generated/` 与 `package.zip`？

### 11.3 CI/CD 与发版工作流核验
- [ ] `.github/workflows/release.yml` 是否同时支持 `push.tags: ["v*"]` 与 `workflow_dispatch` 双入口？
- [ ] 手动发版是否免参数输入，单一以 `plugin.json.version` 为发版权威源？
- [ ] 发版流水线是否完整对齐 8 道质量门禁（依赖冻结安装、版本一致性、`pnpm check`、`pnpm test`、`pnpm build:app`、`pnpm package:verify`、`unzip -t`）？
- [ ] 手动发版是否采用默认 `GITHUB_TOKEN`，天然阻断 `push.tags` 递归死循环？
- [ ] 工作流是否声明了 `concurrency: { group: "release", cancel-in-progress: false }` 避免并发冲突？

### 11.4 依赖安全与规范核验
- [ ] `.github/dependabot.yml` 是否覆盖 `npm` 与 `github-actions` 双生态月度监控？
- [ ] `npm` 监控策略是否严格配置为 `lockfile-only`，保全 `package.json` 声明范围？
- [ ] Actions 依赖是否锁定官方核心大版本，并配置分组 PR？
- [ ] 仓库内部文档与代码中是否存在本机绝对路径、用户家目录路径或凭据泄漏（严格遵守准则 5.6）？
- [ ] 所有文档描述是否保持客观终态陈述，无任何中间态与过渡性措辞（严格遵守准则 1.3）？
