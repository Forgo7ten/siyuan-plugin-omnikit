<div align="center">
  <img src="assets/omnikit-plugin.svg" alt="OmniKit Logo" width="128" height="128" />

  # OmniKit

  <p><b>A modular personal toolkit for SiYuan Note</b></p>
  <p><i>思源笔记模块化个人工具箱插件</i></p>

  <p>
    <a href="https://github.com/Forgo7ten/siyuan-plugin-omnikit/releases"><img src="https://img.shields.io/badge/Release-v0.1.0-blue.svg?style=flat-square" alt="Release" /></a>
    <a href="https://b3log.org/siyuan/"><img src="https://img.shields.io/badge/SiYuan-%E2%89%A53.8.4-6c5ce7.svg?style=flat-square" alt="SiYuan Support" /></a>
  </p>

  <p>
    <a href="#about">About</a> •
    <a href="#installation">Installation</a> •
    <a href="#features">Features</a> •
    <a href="#development">Development</a>
  </p>
</div>

---

# About

**OmniKit** is a modular personal toolkit plugin for [SiYuan Note](https://b3log.org/siyuan/). Designed with a microkernel architecture, each feature operates independently and can be toggled on or off based on your everyday note-taking workflow. Click the OmniKit icon in the top bar and select "OmniKit Settings" to manage features in the unified settings panel.

---

# Installation

- **Marketplace Installation (Recommended)**: In SiYuan Note, open **Settings -> Marketplace -> Plugins**, search for `OmniKit`, click download and enable it.
- **Manual Installation**: Go to the [Releases page](https://github.com/Forgo7ten/siyuan-plugin-omnikit/releases), download the latest `package.zip`, extract it into your SiYuan workspace plugin directory (`data/plugins/siyuan-plugin-omnikit/`), and restart SiYuan.

---

# Features

Currently, OmniKit includes the following feature module:

## Image Compressor

Helps reduce notebook asset sizes with safe, reversible WebP image compression:

- **Silent & Automatic Compression**: Automatically converts new pasted or dropped images into smaller WebP format in the background without interrupting your typing. Can be enabled globally or restricted to an allowlist of specific documents in settings.
- **Single Image Actions & Fine-Tuning**: Right-click any image in the editor and choose `[OmniKit] Compress Image` for instant conversion, or `[OmniKit] Compress...` to open a preview dialog where you can adjust quality and compare original vs. compressed images with size savings badges.
- **Document Batch Compression**: Right-click a document in the file tree or the editor title bar and choose `[OmniKit] Compress Images in Document` to process all eligible images in the current document in one go.
- **Remote Image Localization**: Automatically detects and downloads external HTTP/HTTPS images into local notebook assets.
- **Records & One-Click Restore (Dock)**: Click the OmniKit icon in the sidebar (Dock) to open the Image Records panel. Inspect mappings and status of all compressed images, jump and highlight source blocks, copy asset paths, or restore compressed references back to original images with one click (the plugin never deletes original files).

---

# Development

### Common Commands

```bash
# Install dependencies
pnpm install

# Type-check and unit tests
pnpm check
pnpm test

# Build production bundle
pnpm build
```
