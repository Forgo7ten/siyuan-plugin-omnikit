# OmniKit Plugin Core · 平台产品需求与架构规范 (CORE-PRD)

> **版本**：v1.0（正式发布稿）  
> **状态**：已冻结（Approved & Frozen）  
> **适用范围**：OmniKit 微内核平台层（`src/core/` 及 `src/ui/` 通用基础设施）  
> **上游契约**：遵循 [AGENTS.md](../AGENTS.md) 最高开发准则与思源笔记官方插件模型

---

## 1. 平台定位与设计哲学

OmniKit 是专为思源笔记（SiYuan Note）打造的多合一工具箱扩展平台。OmniKit Core 提供统一的基础设施与容器服务，确立以下核心架构设计原则：

1. **模块化微内核 (Modular Microkernel)**：Core 仅提供基础容器服务（生命周期、配置存储、UI 宿主容器、内核网络代理、日志与安全边界），不承载任何具体业务逻辑。所有业务能力均以独立 Feature 插件化接入。
2. **宿主集成克制 (Host Restraint)**：
   - **单槽位宿主占用**：OmniKit 在思源侧边栏（Dock）中仅占用 1 个统一入口图标，内部通过 Tab 标签路由各功能视图。
   - **统一入口聚合**：全局提供单页滚动的 iPad 风格统一设置面板与 TopBar 快速入口，实现界面入口的集中管理与统一呈现。
   - **统一动作标识与分流前缀**：注入思源外部上下文菜单的动作由 `MenuRegistry` 统一自动补齐 `[OmniKit] ` 前缀以标识功能归属；顶栏自有下拉菜单彻底移除前缀，保持界面清爽克制。禁止 Feature 层硬编码前缀。
3. **安全优先 (Safety First)**：
   - 遵循零工作区临时文件、零主动文件删除、块级精准改写与持久化前置校验等安全规范。
   - 内核块更新执行写前读回比对与并发队列管理，避免并发编辑导致的数据冲突。
4. **系统解耦 (Decoupling Architecture)**：
   - Feature 之间保持相互隔离；各 Feature 仅面向 Core 提供的抽象基类与上下文契约进行开发，禁止跨 Feature 直接产生代码依赖。

---

## 2. 插件宿主集成与生命周期

OmniKit 继承自思源官方 `Plugin` 类，遵循思源官方生命周期规范，并针对多窗口（独立设置窗口）实施运行环境隔离。

### 2.1 宿主生命周期契约

```mermaid
stateDiagram-v2
    [*] --> Onload: 思源加载插件
    Onload --> WindowTypeCheck: 环境与窗口判定
    WindowTypeCheck --> SettingsWindowMode: body--settings (独立设置窗口)
    WindowTypeCheck --> MainWindowMode: 主工作区窗口
    
    SettingsWindowMode --> SettingsMounted: 仅挂载 Store 与设置组件
    SettingsMounted --> [*]: 关闭或退出
    
    MainWindowMode --> Initializing: 初始化 Core 服务
    Initializing --> CatalogLoaded: 加载 FeatureCatalog
    CatalogLoaded --> FeaturesEnabling: 依据配置串行启动 Features
    FeaturesEnabling --> Ready: onLayoutReady (界面就绪)
    
    Ready --> DataChanged: onDataChanged (跨窗口配置同步)
    DataChanged --> Ready: 动态刷新配置与启停
    
    Ready --> Onunload: 禁用插件 / 退出思源
    Onunload --> FeaturesDisabling: 广播 AbortSignal 并串行注销
    FeaturesDisabling --> CoreCleaned: 销毁 Dock / Menu / TopBar
    CoreCleaned --> [*]
```

- **`onload(): Promise<void>`**：
  - 判定当前窗口运行环境；
  - 初始化平台环境适配器 `Platform` 与日志管理器 `Logger`；
  - 初始化核心配置存储 `SettingsManager` 并加载 `omnikit-core.json`；
  - 注册 Feature 元数据到 `FeatureCatalog`；
  - 启动默认启用且配置声明开启的 Feature；
  - 注册 Unified Dock、TopBar 入口及全局设置窗口实例。
- **`onLayoutReady(): void`**：
  - 思源主界面 DOM 与编辑器完全渲染就绪；
  - 触发已启用 Feature 的 `onLayoutReady` 钩子，执行依赖编辑器 DOM 的初始化检测。
- **`onDataChanged(): void`**：
  - 当外部环境或独立设置窗口修改并持久化了配置文件时触发；
  - 重新从磁盘加载相关 JSON 配置，刷新内存缓存，并触发受影响 Feature 的动态状态切换（热启用/热停用/参数热更新）；重新读取的数据不触发二次写盘操作。
- **`onunload(): void`**：
  - 触发全系统注销流程；
  - 标记 `unloading = true`，不再接收或调度新任务；
  - 依相反顺序停用所有运行中的 Feature；
  - 销毁 Unified Dock、MenuRouter 路由监听与全局事件总线。

### 2.2 独立设置窗口多实例隔离规范

思源自 v3.8.7+ 支持独立的设置窗口（DOM 根节点带有 `body--settings` 类名）。
- **运行规范**：在 `body--settings` 窗口实例中，OmniKit 作为独立的配置表单渲染器运行：
  - 仅加载 `SettingsManager`、Svelte 5 设置面板组件及其依赖的 `JsonStore`；
  - 不初始化 Unified Dock；
  - 不注册思源右键菜单路由（MenuRouter）；
  - 不启动后台业务监听器（如编辑器事件监听、上传捕获、自动观察器等）；
  - 设置保存并写入文件后，思源内核会自动向主窗口广播 `onDataChanged` 事件，由常驻的主窗口实例负责将最新配置应用到运行时。

---

## 3. Feature 容器与生命周期管理

### 3.1 Feature 元数据定义 (`FeatureRegistration<T>`)

每个 Feature 在 `src/features/<feature-name>/registration.ts` 中声明标准元数据，Core 不硬编码具体 Feature 的配置字段。

```typescript
export interface FeatureRegistration<T> {
  /** 唯一功能标识符（小写驼峰或 kebab-case，如 "image-compressor"） */
  readonly id: string;
  
  /** 国际化标题对应的 key（如 "features.imageCompressor.title"） */
  readonly titleKey: string;
  
  /** 国际化简要描述对应的 key */
  readonly descriptionKey: string;
  
  /** 功能首次安装或无历史配置时的默认开关状态（由 Feature 自行声明） */
  readonly defaultEnabled: boolean;
  
  /** 
   * Feature 用户配置文件名，严格遵循命名约束：
   * 格式固定为 `feature-${id}-settings.json`
   */
  readonly file: `feature-${string}-settings.json`;
  
  /** 配置编解码与校验器，定义 defaults() 和 parse(raw) */
  readonly codec: StoreCodec<T>;
  
  /** Feature 运行时实例工厂函数 */
  create(plugin: Plugin, context: FeatureContext): BaseFeature;
  
  /** Feature 归属的 Svelte 5 设置面板组件，在统一设置页中动态挂载 */
  readonly settingsView: Component<{
    store: JsonStore<T>;
    runtimePhase: FeaturePhase;
    t: (key: string, params?: Record<string, unknown>) => string;
  }>;
  
  /** 可选：若该 Feature 提供 Dock 视图，则提供 Svelte 5 Dock 组件 */
  readonly dockView?: Component<{
    context: FeatureContext;
    t: (key: string, params?: Record<string, unknown>) => string;
  }>;
}
```

### 3.2 串行启停状态机与并发防护

每个 Feature 具备明确的运行期状态，状态流转通过队列进行串行化调度，防止快速切换开关引发的并发竞争与重复监听。

```mermaid
stateDiagram-v2
    [*] --> Disabled
    Disabled --> Enabling: enable() [进入串行队列]
    Enabling --> Enabled: onEnable() 成功完成
    Enabling --> Error: onEnable() 抛出异常
    
    Enabled --> Disabling: disable() [进入串行队列]
    Disabling --> Disabled: onDisable() 成功完成
    Disabling --> Error: onDisable() 抛出异常
    
    Error --> Enabling: 重试启用
    Error --> Disabling: 强制重置
```

- **状态定义 (`FeaturePhase`)**：
  - `disabled`：功能已停用，不占用任何常驻定时器、DOM 节点或事件总线。
  - `enabling`：初始化与启用中，正在创建 Scope、加载数据与挂载监听。
  - `enabled`：正常运行状态。
  - `disabling`：正在安全停止业务、触发 AbortSignal、注销菜单与释放资源。
  - `error`：启停过程中遭遇未捕获异常。错误信息记录至日志并在设置面板展示告警，系统保留用户在 `omnikit-core.json` 中配置的期望启用状态不变。

### 3.3 `FeatureScope` 与任务安全中止机制

每个处于 `enabled` 状态的 Feature 拥有一个独立的 `FeatureScope` 实例：
1. **统一副作用所有权 (`scope.own`)**：所有事件监听（Protyle 监听、总线事件）、DOM 事件、定时器、Svelte 挂载句柄必须通过 `scope.own(disposer)` 托管。
2. **原生集成 `AbortSignal`**：
   - `FeatureScope` 内置 `AbortController`；
   - Feature 启动的任何长时间异步任务（下载、图片编码、批量更新）必须在调用链中向下传递 `scope.signal`；
3. **销毁时序与非回滚保障**：
   - 当 Feature 被停用或插件卸载时，`scope.dispose()` 被调用；
   - **第一步**：立即触发 `controller.abort("Feature disabled")`，通知所有运行中的异步任务感知取消；
   - **第二步**：倒序执行所有注册的 `disposers`，注销菜单与监听器；
   - **状态保留原则**：异步任务感知到 `signal.aborted` 时，立即中止未开始的后续步骤并退出。系统保留已完成上传或已持久化的文件与块内容，不执行事务性逆向回滚。
4. **任务正常中止与状态判定规范 (Normal Abort & Quiet Exit)**：
   - **静默退出原则**：在单图操作、批量压缩与任务控制器中，用户按 Esc、切换编辑器标签页、功能停用或触发 `signal.abort` 均判定为**正常中止**，系统必须静默退出，严禁向用户误报为“无法定位引用”、“无效文档”或“并发冲突”；
   - **精准错误类型边界**：底层写回组件（如 `SafeBlockWriter`）在检测到任务取消或 Abort 信号时，必须显式抛出标准的 `AbortError` 或返回专用的取消状态枚举，严禁将中止与由于内容修改引发的并发编辑冲突（`conflict`）混为一谈。

---

## 4. 持久化存储体系

### 4.1 存储命名与分层规范

OmniKit 采用“平台配置、用户设置、业务数据”三层物理分离的文件存储架构：

```
SiYuan/data/storage/petal/siyuan-plugin-omnikit/
├── omnikit-core.json                      [平台级全局配置]
├── feature-image-compressor-settings.json [Feature A 用户设置]
├── feature-image-compressor-records.json  [Feature A 核心业务数据]
├── feature-titled-link-settings.json      [Feature B 用户设置]
└── feature-{id}-settings.json             [Feature N 用户设置]
```

| 文件类别 | 命名规范 | 读写权限与时机 | 重置敏感度 |
|---|---|---|---|
| **Core 平台配置** | `omnikit-core.json` | 仅由 `SettingsManager` 维护，包含 `general.debugLog`、`general.userAgent` 及 Feature 启用偏好表 | 受“全局重置”管控 |
| **Feature 设置** | `feature-{id}-settings.json` | 用户在各 Feature 设置页手动调整的业务参数（质量、白名单、截断长度等偏好） | 受“单功能重置”和“全局重置”管控 |
| **Feature 业务数据** | `feature-{id}-{dataname}.json` | Feature 在运行过程中沉淀的核心业务资产映射（如 `records`） | **不受设置重置操作影响** |

#### Core 平台配置模型 (`omnikit-core.json`)

```json
{
  "schemaVersion": 1,
  "general": {
    "debugLog": false,
    "userAgent": ""
  },
  "featureStates": {
    "image-compressor": { "enabled": false },
    "titled-link": { "enabled": true }
  }
}
```

- **`general.debugLog`**：全局调试日志开关，默认 `false`；
- **`general.userAgent`**：全局网络请求 User-Agent 伪装配置（默认空字符串 `""`）：
  - 当为空时，Core 与下游特性默认回退使用内置的现代 Chrome 浏览器 User-Agent（例如 `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36`）；
  - **跨特性复用机制**：由 Core 平台统一集中维护并提供访问能力，供下游需要外网访问的特性（如 `titled-link` 标题抓取伪装、`image-compressor` 远程外链图片防盗链下载等）共同复用，避免在各个 Feature 设置中重复配置与碎片化管理；
- **`featureStates`**：各 Feature 在平台中的期望启用偏好状态，由 Core 统一管理与持久化。

### 4.2 底层存储引擎 `JsonStore<T>`

所有 JSON 文件统一通过 `JsonStore<T>` 进行读写，提供以下可靠性与容灾机制：
1. **每文件独占异步队列**：单个文件的写入严格串行化（Promise Queue），相同内容（Fingerprint 比对）直接跳过写盘。
2. **30 秒超时保护与确定性状态机**：
   - 调用宿主 `Plugin.saveData` 时启动 30 秒超时定时器；
   - 若超时未响应，将内部状态标记为 `writeUncertain = true`，后续写入立即拦截并抛出错误，避免在未确定状态下继续写盘。
3. **损坏保护与备份隔离**：
   - 首次缺失配置文件时直接返回内存默认值，不创建空文件；
   - 若文件损坏或存在 JSON 语法错误，系统不使用默认值静默覆盖。存储引擎锁定为只读状态，将损坏文件重命名为 `.backup` 备份文件，并提示用户显式确认修复。

### 4.3 重置边界与“数据管理”专区

1. **设置重置作用域边界**：
   - 单功能重置（Reset Feature Settings）：仅将对应的 `feature-{id}-settings.json` 重置为默认值。
   - 全局设置重置（Reset All Settings）：仅重置 `omnikit-core.json` 与所有已注册的 `feature-*-settings.json`。
   - 设置重置操作的作用域严格限定于设置文件，底层存储引擎在重置过程中不读取、修改或删除任何 `feature-*-{dataname}.json` 业务数据文件。
2. **“数据管理 (Data Management)”专区**：
   - 在 OmniKit 统一总设置底部提供独立的“数据管理专区”；
   - 扫描并展示当前已持久化的业务数据文件列表、条目数量及磁盘占用；
   - 提供二次确认对话框的“清空数据”操作，支持用户自主选择清除特定 Feature 的业务数据（如清空图片压缩历史记录）。

---

## 5. 统一 UI 扩展模型

为了保持思源工作区界面的整洁纯粹，OmniKit 严格规范 UI 扩展入口。

### 5.1 统一 Dock 容器 (Tab 容器化)

整个 OmniKit 插件在思源侧边栏（Dock）仅注册一个统一的图标与面板容器。

```
┌────────────────────────────────────────────────────────┐
│ [OmniKit] 统一侧边栏容器                                │
├────────────────────────────────────────────────────────┤
│ [ Tab: 图片压缩记录 ] [ Tab: 功能B... ] [ Tab: 功能C... ]│
├────────────────────────────────────────────────────────┤
│                                                        │
│  当前激活 Tab 对应的 Svelte 5 Feature Dock 主视图       │
│                                                        │
│                                                        │
├────────────────────────────────────────────────────────┤
│ [ ⚙ 打开 OmniKit 设置 ]                                 │
└────────────────────────────────────────────────────────┘
```

- **容器交互规则**：
  1. **多视图切换**：当有 2 个及以上已启用的 Feature 注册了 `dockView` 时，容器顶部渲染轻量 Tab 切换栏；
  2. **单视图独占**：当仅有 1 个启用的 Feature 注册了 `dockView` 时，自动隐藏 Tab 栏，该 Feature 独占整个 Dock 主视图；
  3. **空状态引导**：当所有 Feature 被禁用或没有启用的 Feature 提供 `dockView` 时，Dock 渲染“空状态”引导页，展示各 Feature 概览并提供“进入设置开启功能”的跳转按钮。
- **Dock 顶部视觉与防遮挡规范 (Brand Hero Card)**：
  - **Hero 品牌卡片区**：在 Dock 视图顶部常驻渲染约 52px~56px 高度的品牌展示区，包含 OmniKit 图标、粗体大标题（如「OmniKit / 图片记录」）与轻量模式徽章，背景采用思源原生主题微渐变浅背景（`var(--b3-theme-primary)` 8% 透明度）；
  - **几何空间防遮挡下移 (50px+)**：通过 Hero 卡片使下方操作栏（刷新记录、搜索筛选等按钮）整体平滑下移 50px 以上，彻底避开思源桌面端（Windows）及网页端右上角 32px 浮动 Snackbar 消息层（`#message` / `.b3-snackbars`）与 Tooltip 浮层的绝对遮挡，保障交互区域无遮挡点击；
  - **静默刷新防覆盖铁律 (Anti-Overwriting Invariant)**：Dock 在改写操作后执行的后续静默刷新（`post_action`）若遇异常或返回空结果，绝对禁止冲刷或覆盖原有操作产生的成功统计文案；当待处理项降为 0 时必须干净收起抽屉并保留成功统计，杜绝悬挂假性“未找到引用”。
- **生命周期挂载**：Dock 内部组件基于 Svelte 5 的 `mount` / `unmount` 管理，在 Tab 切换或宿主 Dock 折叠时安全清理。

### 5.2 统一设置面板 (Unified Settings Panel)

- **iPad 风格双栏联动**：
  - **左侧导航栏**：列出“全局设置（General）”、所有已注册的 Feature 项以及底部的“数据管理（Data Management）”；
  - **左侧导航分组与国际化规范**：左侧导航按“全局设置”、“功能模块（Features）”分组以及底部的“数据管理”规范化分区编排；功能模块分组标题必须规范化使用国际化键 `nav.features`（中文：“功能模块”，英文：“Features”），统一通过 `t("nav.features")` 进行多语言文本解析，**绝对杜绝任何硬编码字符串或在模板/逻辑中编写三元表达式（如 `{t("status") ? "功能模块" : "Features"}`）**；
  - **右侧单页滚动区**：所有选项以卡片分区形式在右侧连续排布；点击左侧导航平滑滚动到指定卡片，右侧滚动时根据视口可见性实时高亮左侧导航对应项；
  - 采用本地缓冲编辑与显式保存机制，支持实时输入校验；检测到外部 `onDataChanged` 时提示用户重新载入。
- **特性重置文案规范**：
  - 各 Feature 设置卡片头部的重置操作按钮文案统一为**“重置为默认设置”**；
  - 点击后仅将该 Feature 的当前配置重置为声明的初始默认值，不影响任何业务数据文件。

### 5.3 统一菜单系统 (Unified Menu System)

- **前缀分流权威收口规范 (Context-Aware Prefix via MenuRegistry)**：
  - 由 `MenuRegistry` 作为菜单项注册与派发的唯一权威分流收口，**严禁 Feature 层在菜单标题中硬编码 `[OmniKit]` 前缀**；
  - **顶栏自有菜单 (`location === "topbar"`)**：**彻底移除 `[OmniKit]` 前缀**（例如呈现为 `压缩当前文档图片`、`开启当前文档图片自动压缩`），与顶栏环境深度融合，保持清爽克制；
  - **外部宿主上下文菜单 (`location === "doc-tree" | "doc-title" | "image" | "link" | "blockicon"`)**：由 `MenuRegistry` **自动统一补齐 `[OmniKit] ` 前缀**（例如 `[OmniKit] 压缩此图片`、`[OmniKit] 提取链接标题`、`[OmniKit] 批量提取链接标题 (共 N 个)`），帮助用户清晰区分思源原生菜单与其他第三方插件菜单。
- **轻量状态感知与路由防护**：
  - 通过 `MenuRouter` 与 `MenuRegistry` 集中管理菜单派发；
  - 菜单触发时，`MenuRouter` 首先核验对应 Feature 的运行状态（`phase === "enabled"`）；
  - 若在右键菜单打开期间 Feature 处于禁用状态，系统调用思源原生 `showMessage` 提示功能已停用，不展示模态错误弹窗，且不执行失效回调。

### 5.4 统一 TopBar 快捷入口与顶栏下拉菜单

- 在思源顶栏注册统一的 OmniKit 图标入口；
- 单击默认唤出 OmniKit 统一设置窗口；
- **顶栏下拉菜单结构与视觉分隔线规范**：
  - **顶部 Core 平台项**：顶部第一组固定为平台级核心命令**「OmniKit 设置」**（打开统一设置面板）。思源侧边栏（Dock 栏）已有专用的常驻 OmniKit 入口按钮，顶栏下拉菜单不设立重复且无法可靠控制 Dock 的菜单项；
  - **物理分隔线 (`separator`) 隔离**：在 Core 平台「OmniKit 设置」与下方各启用 Feature 贡献的业务选项之间，**必须使用视觉分隔线进行物理隔离**；
  - **思源原生 SDK 契约对齐**：必须显式调用思源原生 SDK 契约 `menu.addSeparator({ id: "separator_settings" })`，生成思源原生标准的 `<button data-id="separator_settings" class="b3-menu__separator"></button>` 分隔线，与思源官方 `openTopBarMenu.ts` 实现完全对齐，物理隔离 Core 平台设置与下方各 Feature 业务选项；
  - **下方 Feature 快捷指令**：分隔线下方动态渲染各已启用 Feature 注册的顶栏快捷操作（如当前文档图片压缩等），统一无 `[OmniKit]` 前缀。

---

## 6. 思源内核适配与基础设施

### 6.1 `KernelClient` 安全调用门面

对思源原生 REST API（`fetchPost`）进行封装与防御性处理：
- **请求超时与中止**：默认设置 30 秒超时，支持透传 `AbortSignal`；
- **响应错误归一化**：自动检查 HTTP 状态码与思源返回体中的 `code !== 0`，提取并包装为标准 `KernelError`；
- **网络异常容灾**：网络断开或内核异常时不针对非幂等修改请求执行自动重试，避免向内核制造重复提交。

### 6.2 `Platform` 运行环境判断

统一导出跨平台环境识别工具：
- 识别桌面端（Windows / macOS / Linux）与移动/平板/Web 前端；
- 为特性提供差异化能力前置检查（例如：仅桌面端支持本地大图 Worker 多线程加速转码等）。

### 6.3 `Logger` 动态日志体系

- 统一日志输出格式：`[OmniKit][{level}][{tag}] {message}`；
- 与 `omnikit-core.json` 中的 `general.debugLog` 开关深度绑定；
- 调试日志（Debug/Trace）在开关关闭时保持静默，生产环境下默认仅输出 Warn 与 Error 级别日志。

---

## 7. 已纳管 Feature 索引

| Feature ID | 中文名称 | 业务规范文档 | 默认状态 | 说明 |
|---|---|---|---|---|
| `image-compressor` | 图片压缩 | [features/image-compressor.md](features/image-compressor.md) | 关闭 (`false`) | 针对思源新插入图片与文档已有图片的无损/高质 WebP 压缩，含统一 Dock 记录与引用回溯 |
| `titled-link` | 自动标题链接 | [features/titled-link.md](features/titled-link.md) | 开启 (`true`) | 针对思源行内超链接异步获取并填充网页标题，支持非网页文件免抓取、单链右键菜单与块级批量提取，具备双轨网络、流式截断、万国码嗅探与并发冲突保护 |

*(后续新增 Feature 需在完成需求规范编写与冻结后，补充更新至本索引表)*
