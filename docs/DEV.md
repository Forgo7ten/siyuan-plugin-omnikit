# OmniKit 开发与动态测试指南

本文档面向插件开发者，说明本地构建安装、隔离测试工作区准备以及思源实机动态测试与浏览器 MCP 自动化环境的通用配置方式。

---

## 1. 本地校验与构建

```bash
# 类型检查与 Svelte 校验
pnpm check

# 运行全部单元测试
pnpm test

# 完整校验、单测并打包至 dist/ 与 package.zip
pnpm build

# 校验打包产物清单
pnpm package:verify
```

---

## 2. 安装构建产物到测试工作区

严禁直接把未验证产物安装到日常使用的笔记工作区。请为调试准备独立的思源测试工作区（需包含 `conf/`、`data/.siyuan/` 与 `data/plugins/`）：

```bash
pnpm install:workspace /path/to/test-siyuan-workspace
```

该脚本由 [scripts/dev/install-workspace.mjs](../scripts/dev/install-workspace.mjs) 执行：按必需产物清单校验 `dist/`，对已有同名插件目录自动生成时间戳备份后原子替换，并在检测到软链接或非本插件目录时拒绝覆盖。

---

## 3. 动态测试

动态测试用于补足纯 Node 单测无法覆盖的宿主真实行为，包括思源 Go 内核 REST API、Lute DOM 序列化、Protyle 编辑器交互以及真实浏览器 CSS 渲染。

### 3.1 启动隔离思源 Docker 实例（Web 端）

使用思源官方容器镜像 `b3log/siyuan` 挂载独立测试工作区（例如 `$HOME/siyuan`）对外暴露 HTTP 服务，避免污染宿主日常笔记数据：

```bash
docker run -d \
  --name siyuan-test \
  -p 6806:6806 \
  -v "$HOME/siyuan:/siyuan/workspace" \
  -e PUID="$(id -u)" \
  -e PGID="$(id -g)" \
  -e SIYUAN_ACCESS_AUTH_CODE_BYPASS=true \
  b3log/siyuan \
  serve --workspace=/siyuan/workspace --port=6806 --ssl=false
```

安装最新构建产物至该测试工作区，并在思源设置中启用与重载插件：

```bash
pnpm install:workspace "$HOME/siyuan"
```

> [!NOTE]
> 容器模式运行在 `browser-desktop` 前端环境，可覆盖设置面板、Dock、`/api/*` 持久化、Protyle DOM 与 `forwardProxy` 分支；涉及桌面客户端 Node `http`/`https` 直连下载与独立设置窗口（`body--settings`）的分支，仍需在思源桌面客户端中验证。

### 3.2 浏览器自动化 MCP（`chrome-devtools-mcp`）与无头 Chrome 配置

若通过通用浏览器 MCP（如 [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp)）配合真实 Chrome 对 `http://localhost:6806` 做动态测试与 DOM/控制台检查，可按以下方式配置环境：

#### 1. 安装与 MCP 启动配置

`chrome-devtools-mcp` 支持两种常用连接模式：

- **自动连接运行中的本地 Chrome（`--autoConnect`）**：适合复用到同一个长期运行、可手动观察或附带调试状态的浏览器实例，对应客户端 MCP 配置示例：

  ```json
  {
    "mcpServers": {
      "chrome_devtools": {
        "command": "npx",
        "args": [
          "-y",
          "chrome-devtools-mcp@latest",
          "--no-usage-statistics",
          "--autoConnect"
        ]
      }
    }
  }
  ```

- **由 MCP 按需拉起独立无头 Chrome**：若不提前手启浏览器进程，也可在参数中直接指定 `--headless` 与 `--executablePath`（或 `--channel stable`）。

#### 2. 启动带 `DevToolsActivePort` 的无头 Chrome（用于 `--autoConnect`）

`chrome-devtools-mcp` 使用 `--autoConnect` 时，会在默认配置目录查找 `$HOME/.config/google-chrome/DevToolsActivePort`（第一行为调试端口，第二行为 `/devtools/browser/...` WebSocket 路径）。

1. 若系统未安装系统级 Chrome，可复用本机已有的 Chrome / Puppeteer 缓存二进制（如 `$HOME/.cache/puppeteer/chrome/.../chrome`）软链接至 `$HOME/.local/bin/google-chrome`：

   ```bash
   ln -sf "$HOME/.cache/puppeteer/chrome/linux-<version>/chrome-linux64/chrome" "$HOME/.local/bin/google-chrome"
   ```

2. 启动无头 Chrome 时**必须传入 `--remote-debugging-port=0`**（配合 `--user-data-dir="$HOME/.config/google-chrome"`），由 Chrome 主动写出 `DevToolsActivePort` 文件；直接指定固定非零端口（如 `9222`）在无头模式下可能只打印 WebSocket 地址而不生成 `DevToolsActivePort`：

   ```bash
   mkdir -p "$HOME/.config/google-chrome"
   google-chrome \
     --headless=new \
     --user-data-dir="$HOME/.config/google-chrome" \
     --remote-debugging-port=0 \
     --no-first-run \
     --no-default-browser-check
   ```

#### 3. 验证环境就绪

1. 查看 `$HOME/.config/google-chrome/DevToolsActivePort` 已存在且包含两行（端口号与 `/devtools/browser/...`）；
2. 通过 `chrome_devtools` MCP 打开 `http://localhost:6806`，确认思源工作区页面加载成功（`document.readyState === "complete"`）且控制台与网络请求无插件异常；
3. 检查 `window.siyuan.ws.app.plugins` 或 `/api/bazaar/getInstalledPlugin` 中已加载 `siyuan-plugin-omnikit`，即可开始全流程动态测试。
