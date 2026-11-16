<div align="center">
  <img src="assets/omnikit-plugin.svg" alt="OmniKit Logo" width="128" height="128" />

  # OmniKit

  <p><b>思源笔记模块化个人工具箱插件</b></p>
  <p><i>A modular personal toolkit for SiYuan Note</i></p>

  <p>
    <a href="https://github.com/Forgo7ten/siyuan-plugin-omnikit/releases"><img src="https://img.shields.io/badge/Release-v0.1.0-blue.svg?style=flat-square" alt="Release" /></a>
    <a href="https://b3log.org/siyuan/"><img src="https://img.shields.io/badge/SiYuan-%E2%89%A53.8.4-6c5ce7.svg?style=flat-square" alt="SiYuan Support" /></a>
  </p>

  <p>
    <a href="#项目描述">项目描述</a> •
    <a href="#安装">安装</a> •
    <a href="#功能介绍">功能介绍</a> •
    <a href="#开发与构建">开发与构建</a>
  </p>
</div>

---

# 项目描述

**OmniKit** 是面向思源笔记（SiYuan Note）的个人多功能工具箱插件。采用模块化设计，各个功能独立运作，用户可根据日常笔记需求自由开启或关闭。点击顶栏 OmniKit 图标选择「OmniKit 设置」即可进入统一设置面板管理各功能。

---

# 安装

- **集市安装（推荐）**：在思源笔记中打开 **设置 -> 集市 -> 插件**，搜索 `OmniKit` 点击下载安装并启用。
- **手动安装**：前往 [Releases 页面](https://github.com/Forgo7ten/siyuan-plugin-omnikit/releases) 下载最新 `package.zip`，解压到思源工作空间的 `data/plugins/siyuan-plugin-omnikit/` 目录下，重启思源即可。

---

# 功能介绍

目前包含以下功能模块：

## 图片压缩 (Image Compressor)

帮助减小笔记附件体积，提供安全、可逆的图片压缩与管理能力：

- **自动无感压缩**：在笔记中粘贴或拖入新图片时，后台自动转为体积更小的 WebP 格式，不卡顿写作。可在插件设置中开启全局自动处理，或仅指定特定文档白名单。
- **单张微调与对比**：在编辑器中右键点击任意图片，选择 `[OmniKit] 压缩此图片` 可直接压缩；选择 `[OmniKit] 压缩…` 可打开对比弹窗，实时调节画质并直观预览前后的效果与体积节省。
- **文档批量压缩**：右键点击文档树上的某篇文档或编辑器标题区，选择 `[OmniKit] 压缩当前文档图片`，一键批量处理整篇文档中的所有图片。
- **外链图片转存**：自动检测并下载文章中的网络外链图片，转存保存到本地附件中。
- **历史记录与一键还原 (Dock)**：点击思源侧边栏（Dock 栏）的 OmniKit 图标打开面板。可查看所有已压缩图片的映射与状态，支持一键跳转高亮目标块、复制资源路径，或一键恢复回原图引用（插件不会主动删除任何原始文件）。

---

# 开发与构建

### 常用命令

```bash
# 安装依赖
pnpm install

# 类型检查与单元测试
pnpm check
pnpm test

# 构建打包
pnpm build
```
