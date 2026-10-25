# MIX 投稿

这里放两种 MIX 投稿（C-011）。最省事的做法是在网站的[制作 MIX](https://cheerbook.kozueginko.com/editor/mix/) 页面填写，检查通过后一键打开 GitHub 投稿；下面是文件格式，供手写或写工具时参考。两种文件都由 `node tools/check.js` 与 Pull Request 的“检查”自动检查，规则的实现在 [`lib/mixes.js`](../lib/mixes.js)。

| 种类 | 位置 | 合并后 |
| --- | --- | --- |
| 通用 MIX 提议 | `mix/proposals/<编号>.mix.json` | 并入内置 MIX 库 `spec/mix-library.json`，提议文件随即删除 |
| 艺人专属 MIX | `mix/artists/<艺人>/<编号>.mix.json` | 留在这里，网站上可浏览、下载，制作这位艺人的歌时编辑器提供并推荐 |

文件用 UTF-8（不带 BOM），不超过 64 KB，同一个字段不能写两次，不能有下面没列出的字段。

## 通用 MIX 提议

偶像现场通用的口号：不含特定成员、组合、公演名或专属梗（成员名字用 `{name}` 空位），名称公认、在多个相互独立的公开页面上形式基本相同。某个组合自己的口号请投“艺人专属 MIX”。

```json
{
  "format": "cheerbook-mix-proposal",
  "version": 1,
  "id": "example-mix",
  "name": "例子MIX",
  "kind": "mix",
  "text": "タイガー！{name}！",
  "romaji": "Taigā! {name}!",
  "bars": [2, 4],
  "positions": ["intro", "interlude"],
  "note": "可选：用法说明",
  "readings": {
    "kana": ["たいがー", "{name}"],
    "romaji": ["Taigā", "{name}"]
  },
  "sources": ["https://example.org/page-1", "https://example.net/page-2"],
  "retrieved": "2026-10-26"
}
```

| 字段 | 规则 |
| --- | --- |
| `id` | 1–54 个小写英文字母、数字或 `. _ -`，以字母或数字开头；与文件名相同，不能与内置库已有的编号相同。并入后事件用 `mixRef: "tradition:<id>"` 引用 |
| `name` | 名称，1–32 字 |
| `kind` | `mix` 或 `call` |
| `text` | 日文原文，`{name}` 为成员空位；MIX 最多 120 字、call 最多 60 字；不能与内置库已有的口号相同 |
| `romaji` | 整句罗马音 |
| `bars` | `[最少, 最多]` 小节数，1 ≤ 最少 ≤ 最多 ≤ 64 |
| `positions` | 常见位置：`intro`（前奏）、`afterMix`（接在 MIX 后）、`interlude`（间奏）、`chorusLead`（副歌前）、`outro`（尾奏）、`verse`（有人唱时）；空数组表示不参与推荐 |
| `note`、`readingNote` | 可选，用法说明与无词典可查的读音说明，各 1–200 字 |
| `readings` | 逐词的平假名 `kana` 与罗马音 `romaji`，个数与口号的词数相同（按“！”拆词，见 `spec/README.md` §5.2） |
| `sources` | 2–10 个能看到这条口号的公开网页链接，不重复 |
| `retrieved` | 看这些页面的日期 `YYYY-MM-DD` |

并入内置库时，已经被库引用过的页面沿用原来的来源代码，新页面得到下一个空闲代码；条目记下自己的 `retrieved`。

## 艺人专属 MIX

某个组合或某首歌自己的口号。只收自己创作、有明确开放许可或原作者同意转载的；只是公开可见的不收。

```json
{
  "format": "cheerbook-artist-mix",
  "version": 1,
  "artist": "例子组合",
  "songs": ["例子曲目"],
  "id": "example-call",
  "name": "例子口号",
  "kind": "call",
  "text": "例子！最高！",
  "bars": [1, 2],
  "positions": ["chorusLead"],
  "credits": {
    "authors": [{ "name": "投稿人" }],
    "permission": "original"
  }
}
```

| 字段 | 规则 |
| --- | --- |
| `artist` | 艺人，1–200 字；文件夹名由它生成（与 `cheers/` 的规则相同） |
| `songs` | 可选：只用于这些歌（1–50 个歌名）；不写表示用于这位艺人的所有歌 |
| `id`、`name`、`kind`、`text`、`bars`、`positions`、`note` | 同上；`id` 与文件名相同 |
| `romaji`、`readings` | 可选；写了就要与口号的词数对得上（可以只写 `kana` 或只写 `romaji`） |
| `credits` | 与应援文件相同（`spec/README.md` §3.5）：`authors` 1–16 位；`permission` 只能是 `original`、`open-license`、`consented`；自己创作的不写 `license` 时按 CC BY 4.0，也可选 CC0-1.0 或 CC-BY-SA-4.0；开放许可要写明 `license`；原作者同意的请在 Pull Request 里附上同意的说明 |

编辑器插入专属 MIX 时，把口号、读音和名称（`name`）写进应援文件，映场和其他播放器不认识这份 MIX 文件也能照常显示。

## 修改与撤回

投稿合并后，投稿用的 GitHub 账号记为这份文件的作者。作者之后发起的 Pull Request 只修改或删除自己投稿的文件、检查通过时自动合并；其他修改等维护者审核。网站上每条专属 MIX 都有“在网页中编辑”，改好后“提交修改”会打开 GitHub 上原文件的编辑页面。
