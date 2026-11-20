# OmniKit 开发约束 (AGENTS.md)

## 1. 思源官方源码核实

- 制定技术方案、调用宿主 API 或判断思源底层行为时，必须对照本地官方源码 `$(ghq root)/github.com/siyuan-note/siyuan`（及 `$(ghq root)/github.com/siyuan-note/petal`、`node_modules/siyuan` 类型声明）进行核实，重点覆盖前端 `app/src/protyle/` 与后端 `kernel/api/`、`kernel/model/`、`kernel/apicontract/`。
- 讨论方案或编写代码时，必须严格区分源码已确认事实（附路径与行号）与拟议草案，严禁将未落地的示例符号当作现成 API 使用。
- 思源前端事件触发（如上传 `onComplete`、粘贴或 DOM 变更）可能早于编辑器 `/api/transactions` 提交与内核落盘；涉及写回的位置核验与基线获取必须以内核读接口返回为准，不以事件触发或前端 DOM 推断持久化完成。

## 2. 文档体系与 Spec-First 约束

- **文档分工与定位**：
  - [`docs/CORE-PRD.md`](docs/CORE-PRD.md)：平台微内核与通用服务产品需求；
  - [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：全局微内核架构、分层边界、跨端适配与构建契约；
  - `docs/features/<name>/PRD.md`：特性产品规格（只写功能范围、交互行为、业务规则与验收边界，不写内部类名、私有函数或实现细节）；
  - `docs/features/<name>/DESIGN.md`：特性技术设计（只写模块拆分、接口时序、数据结构、状态流转与容错细节）。
- **先对齐文档再实现代码**：新增需求或变更既有行为时，必须先读取并更新相关 `docs/` 文档（按需覆盖 `CORE-PRD.md`、`ARCHITECTURE.md` 及目标特性的 `PRD.md`、`DESIGN.md`），确认跨文档无口径冲突后，方可修改 `src/` 与 `tests/`；严禁未经文档定义擅自增减界面控件（按钮、菜单、快捷键）、设置选项或持久化文件。
- **终态客观陈述**：`docs/` 下所有文档必须客观陈述当前现行终态实现，严禁写入“不再/改为/废弃旧逻辑”等演进对比与过渡性措辞（历史差异仅保留在提交记录或独立审查报告中）。

## 3. 通用架构与宿主安全底线

- Feature 之间禁止相互 `import`，跨特性通用能力统一沉淀至 `src/core/` 或 `src/ui/`，Core 代码中不得出现针对具体 Feature ID 的硬编码分支。
- 严禁直接修改 `.sy` 文档、SQLite 数据库或绕过内核直接扫描、读写、删除工作区 `assets/`；严禁向工作区写入临时日志或 `.tmp` 缓存文件；`/api/query/sql` 仅限只读辅助查询。
- 思源内核写接口（`/api/block/updateBlock`）不提供原子 CAS，写前须经内核读接口核验目标内容未变化、冲突即放弃，响应状态未知的写操作严禁盲目自动重试；具体持久化契约与资产管理规则以对应 `docs/` 规范为准。

## 4. 交付与验证门禁

- 界面文案变动必须同步保持 `src/i18n/zh-CN.json` 与 `src/i18n/en.json` 键名一致。
- 变更交付前须真实执行并通过 `pnpm check`、`pnpm test`、`pnpm build`（涉及发布脚本或产物清单时补充 `pnpm package:verify`），只按实际运行结果如实汇报检查状态与验证范围。
