# CheerBook 应援本

网站：<https://cheerbook.kozueginko.com>

CheerBook 是偶像歌曲应援 / MIX 时间轴的社区库：什么时候喊 MIX、喊 call、哪位成员在唱、什么时候举灯，按秒记在一个 `.cheer.json` 文件里，大家投稿、维护者审核，任何人都可以下载使用。

- **只有时间轴，不含歌词**：文件里只有时间、口号、成员与署名，唱词由播放端从自己的歌词来源显示。
- **不需要账号和服务器**：投稿走 GitHub 的 Pull Request，自动检查格式，维护者人工审核后合并。
- **格式公开**：`.cheer.json` 的格式说明、JSON Schema 与对照样例在 [`spec/`](./spec/)，以 CC0 公开，任何播放器或工具都可以实现。

CheerBook 与 [映场 Liveglow](https://github.com/alexpsz/liveglow)（Apple 芯片 Mac 上的音乐与视觉播放器）由同一位维护者发起，映场可以读取和制作这种文件；CheerBook 本身是独立项目，不隶属于任何偶像组合、事务所或音乐平台。

## 使用应援文件

1. 在[网站](https://cheerbook.kozueginko.com)或 [`cheers/`](./cheers/) 里按艺人、歌名找到文件，下载 `.cheer.json`。所有收录文件也列在 [`index.json`](./index.json) 中。
2. 在映场中打开“正在播放”侧栏的“应援”标签，点“导入…”选择文件。

文件按录音匹配（ISRC、Apple Music 编号，或歌名、艺人与时长）。导入时映场会显示它是否与正在播放的歌匹配；不匹配的文件也会保存，播放到匹配的录音时使用。同一首歌的现场版、长度不同的版本可能对不上。

## 在网页上制作

打开[制作应援](https://cheerbook.kozueginko.com/editor/)，不用安装任何软件：

1. **选择本地音频**：歌曲只在你的浏览器里播放，节拍也在浏览器里分析，不会上传。
2. **加载歌词**：粘贴或导入 LRC，或点“在线查找”从 [LRCLIB](https://lrclib.net) 查询（只发送歌名、艺人和时长）。歌词只用来对时间，不会写进应援文件。
3. **边听边点**：按住成员按钮或数字键 1–9 记录演唱段落，M / C / N 记录 MIX、call、提示；右侧的通用 MIX 一点就插入并对齐到拍子；“✦ 推荐”会按歌词空位和节拍推荐 MIX，点了才会采纳。
4. **即时反馈**：每一下都会马上出现在歌词旁边，底部的应援带像播放时一样显示当前和下一条；格式问题和与歌词重合的文字在侧栏实时提示。
5. **保存与投稿**：草稿自动保存在这个浏览器里；“保存到本机”下载 `.cheer.json`，“分享 / 投稿”会打开 GitHub 的新建文件页面，内容已经填好。

网站上每份应援都有“在网页中播放”：选择你自己的音频文件，就能看着应援带跟着唱。

## 隐私

网站不设访问统计，不加载其他网站的资源。网页编辑器里选择的音频只在你的浏览器里播放和分析，不会上传；草稿保存在这个浏览器的本地存储里。只有点“在线查找”时，才会把歌名、艺人和时长发送给 LRCLIB。

## 投稿

先读[投稿指南](./CONTRIBUTING.md)。要点：

- 只收**自己听写打轴**的文件，或来源有明确开放许可、原作者同意转载的文件；从别人的 call 表或视频整理的时间轴不收。
- 文件里**不能有歌词原文**；跟唱的那一句用“跟唱”（`echo`）标记。
- 可以在[网页编辑器](https://cheerbook.kozueginko.com/editor/)里做好后直接投稿，也可以用映场制作。
- 自己听写的投稿默认以 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.zh-hans) 授权，也可以选 CC0 或 CC BY-SA 4.0；转载的文件按来源的许可或原作者同意的条件。

## 下架

如果你是歌曲、编舞或应援法的权利人，或者某个文件是从你的作品转来的，请按[下架规则](./docs/takedown.md)提出，维护者在 7 天内处理，先下架再核实。

## 目录

| 路径 | 内容 |
| --- | --- |
| [`cheers/`](./cheers/) | 社区投稿的应援文件：`cheers/<艺人>/<歌名>/<文件名>.cheer.json` |
| [`index.json`](./index.json) | 全部收录文件的索引（合并后自动生成） |
| [`spec/`](./spec/) | 格式说明、JSON Schema、对照样例与内置 MIX 库 |
| [`lib/`](./lib/)、[`tools/`](./tools/)、[`tests/`](./tests/) | 读取器、自动检查与网站生成（Node.js，无依赖） |
| [`site/`](./site/) | 网站的样式、脚本与图标；[`site/editor/`](./site/editor/) 是网页编辑器 |
| [`docs/`](./docs/) | 审核标准与下架规则 |

在本地运行检查（需要 Node.js 22 或更新版本）：

```sh
npm test          # 读取器对照 spec/ 的样例、社区规则与网站生成的测试
npm run check     # 检查 cheers/ 下的全部文件与 MIX 库
npm run site      # 生成网站到 _site/
```

## 路线

1. **社区库**（现在）：格式说明、投稿与审核、自动检查、索引。
2. **映场接入**（计划中）：在映场里按正在播放的歌浏览、下载社区应援。
3. **网页编辑器**（已上线第一版）：在浏览器里选择本机音频、分析节拍并打轴，不上传音频，让没有 Mac 的人也能制作和投稿。以后加入 Mineradio 舞台作背景。

## 许可

| 内容 | 许可 |
| --- | --- |
| 代码（`lib/`、`tools/`、`tests/` 等） | [GPL-3.0-only](./LICENSE) |
| 格式说明、Schema 与样例（`spec/`） | [CC0 1.0](./spec/LICENSE) |
| 内置 MIX 库（`spec/mix-library.json`） | CC0 1.0，署名“应援圈传统” |
| 社区投稿（`cheers/`） | 每个文件自己的许可：自己听写的默认 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)，转载的按来源许可或原作者同意的条件；见 `index.json` 中的 `license` |

署名要求：使用 CC BY / CC BY-SA 授权的文件时，请保留文件中的作者署名。

---

## English

Website: <https://cheerbook.kozueginko.com>

CheerBook is a community library of cheer timelines for idol songs: when to shout a MIX or a call, which member is singing, when to raise light sticks, kept as `.cheer.json` files. Files carry timing, chants, members and credits only, never lyrics. Contributions arrive as pull requests, are checked automatically and reviewed by a maintainer.

- The file format, its JSON Schema and reference samples are in [`spec/`](./spec/) (CC0, in Chinese).
- Only self-transcribed timelines, or material under an open licence or with the author's consent, are accepted. Self-transcribed contributions default to CC BY 4.0.
- Rights holders can ask for removal under the [takedown rules](./docs/takedown.md); requests are handled within 7 days, removing first and checking afterwards.
- [Liveglow](https://github.com/alexpsz/liveglow), a music player for Apple silicon Macs, reads and makes these files. CheerBook is an independent project and is not affiliated with any idol group, agency or music platform.

Code is GPL-3.0-only; the format and the built-in MIX library are CC0; each contribution carries its own licence (CC BY 4.0 for self-transcribed files unless they say otherwise).
