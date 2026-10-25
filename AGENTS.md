# AGENTS.md — CheerBook 仓库运行规则

人与 AI Agent（Claude Code、Codex 等）在本仓库的稳定规则。`CLAUDE.md` 只引用本文件。

## 项目

- CheerBook 是偶像歌曲应援 / MIX 时间轴（`.cheer.json`）的社区库，分三步：①社区库（格式说明、投稿、审核、自动检查、索引）；②映场（Liveglow）接入社区库；③浏览器中的网页编辑器。现在处于第一步。
- `spec/` 是格式的**权威副本**；映场仓库的 `spec/cheer/` 是它的逐字节副本。实现方式是“共享数据与样例、逻辑各自实现”：本仓库的 JavaScript 读取器 `lib/cheer.js` 与映场的 Swift 读取器跑同一组样例，结果必须一致。
- 维护者：alexpsz（起步一人维护）。

## 权威顺序

维护者在 Issue、Pull Request 或对话中的最新明确决定 > `memory-bank/decisions.md` > `memory-bank/progress.md`（唯一当前状态）> 其他文档。

## 授权分级

| 级别 | 范围 | 条件 |
|---|---|---|
| R1 | 文案、测试、无行为变化的修改、本地运行检查 | 任务覆盖即可 |
| R2 | 格式（`spec/`）、社区规则（`CONTRIBUTING.md`、`docs/`、`mix/README.md`、`lib/library.js`、`lib/mixes.js`、`lib/contributors.js` 的规则）、工作流与权限、`contributors.json` | 简短计划 + 维护者批准 |
| R4 | 合并投稿、推送 `main`、处理下架、改仓库设置、发布 | 维护者对具体动作的明确授权 |

授权在范围内跨轮次有效；超出范围或前提变化时停下说明。

## 内容规则

- 不向仓库加入歌词原文、音频，或任何不是由其作者投稿的应援内容。
- 不写入个人信息（邮箱、电话、真实姓名、账号）；测试与示例只用合成数据（编造的曲名、组合、成员，链接用 `example.com`）。唯一的例外是 `contributors.json`：按 C-011，它由合并后的工作流记录每份投稿的投稿者 GitHub 账号（公开的数字编号与用户名），只用于判断作者修改能否自动合并，不手写其他个人信息。
- 下架请求按 `docs/takedown.md`：先下架、再核实，7 天内处理。

## 格式变更

- 第 1 版之内只增加可选字段（`spec/README.md` §11）；改变含义、收紧限制或新增必填项须升版本。
- 改 `spec/` 时同步更新对照样例与 `lib/cheer.js`，并在映场仓库的 `spec/cheer/` 做同样的修改，保持逐字节相同。

## 实现与验证

- `npm test`（读取器对照 `spec/` 全部样例，社区规则测试）与 `npm run check`（`cheers/`、`mix/` 与 MIX 库）必须通过。测试不得依赖仓库当前的 `cheers/` 与 `index.json`，否则投稿会让测试失败。
- CI 从基准分支取检查代码，把 Pull Request 的文件当数据检查；检查输出里来自投稿者的文字一律转义，不能形成工作流命令。
- 不引入依赖；确需引入时先说明原因。只写 Node.js 22 可运行的代码。
- 检查给投稿者看的消息用简体中文、写明文件与改法。
- 网页编辑器（`/editor/`）与 MIX 表单（`/editor/mix/`）的规则都在 `lib/` 的纯模块里（`editor`、`suggest`、`lyrics`、`beat`、`messages`、`paths`、`mixes`、`contributors`，不用 Node API），构建时打成 `/editor/lib.js`；`site/editor/` 只负责把它们接到页面上。编辑与推荐规则与映场 Swift 一致，改动时两边同步（艺人专属 MIX 目前只在网页端）。
- MIX 投稿（C-011）：通用 MIX 提议放 `mix/proposals/`，合并后由“更新索引”工作流运行 `tools/accept-mix-proposals.js` 并入 `spec/mix-library.json`；艺人专属 MIX 放 `mix/artists/`。格式见 `mix/README.md`，规则在 `lib/mixes.js`。内置库的变更要同步到映场仓库的 `spec/cheer/`（随映场下个版本）。
- 网站由 `node tools/build-site.js` 生成到 `_site/`（不入库），Cloudflare Pages 在 `main` 更新后自动构建；页面中来自投稿的文字一律转义，不写内联脚本或样式（`_headers` 的 CSP 禁止）。

## Git

- 只用显式路径 `git add <paths>`；不强制推送、不改写已推送的历史（下架需要清除历史时另行授权）。
- 提交信息写明动机、改动与验证。
