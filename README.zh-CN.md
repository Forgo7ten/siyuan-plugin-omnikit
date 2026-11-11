# OmniKit

<p><img src="assets/omnikit-plugin.svg" alt="OmniKit 图标" width="160"></p>

基于官方 [plugin-sample](https://github.com/siyuan-note/plugin-sample) 开发的思源模块化个人工具箱，采用 **TypeScript + Vite + Svelte 5**。

- 插件 ID：`siyuan-plugin-omnikit`
- 最低思源版本：3.8.0；上传前自动处理需要 3.8.4+
- 全局自动压缩**开启**：所有文档之后上传的图片自动压缩
- 全局自动压缩**关闭**：仅对局部白名单文档之后上传的图片自动压缩
- 图片 Feature 总开关关闭：注销其菜单贡献和事件监听，停止新任务；保留设置和白名单
- 文档树只处理单选文档，不处理多选
- 国际化源码保留在 `src/i18n`，构建产物放到 `dist/i18n`

构建命令：`pnpm install && pnpm check && pnpm test && pnpm build`。

每次构建都会从 `assets/omnikit-plugin.svg` 生成集市图标。要将构建结果安装到本地思源工作空间，运行 `pnpm run install:workspace -- "/path/to/siyuan/workspace"`。

OmniKit 提供模块化 Feature 系统，当前包含图片压缩功能；设置与翻译资源均随插件包发布。
