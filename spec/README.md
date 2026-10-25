# 应援文件格式 `.cheer.json`（liveglow-cheer 第 1 版）

本目录是映场（Liveglow）与 CheerBook 共用的应援 / MIX 文件公开规格：格式说明（本文）、JSON Schema、合成样例与期望结果、内置 MIX 库。映场、CheerBook 和其他读取方都以这里为准。权威副本是 [CheerBook 仓库](https://github.com/alexpsz/cheerbook)的 `spec/`；映场仓库的 `spec/cheer/` 是它的逐字节副本，格式变更先改 CheerBook，再同步到映场。

- 许可：本目录全部文件为 CC0 1.0（见 [LICENSE](./LICENSE)）；读取它们的代码（映场、CheerBook）仍是 GPL-3.0-only。
- 实现：映场（Swift，[`CheerChart.swift`](https://github.com/alexpsz/liveglow/blob/main/native/MiraNative/Sources/MiraStageHost/CheerChart.swift) 中的 `CheerChart.parse`，为参考实现）与 CheerBook（JavaScript，[`lib/cheer.js`](https://github.com/alexpsz/cheerbook/blob/main/lib/cheer.js)）。实现与本文不一致时以本文与样例为准提出修正，不悄悄改任何一方。
- 第 1 版的格式语义已经固定（§11）；边界情况按 §14统一。

| 文件 | 内容 |
| --- | --- |
| `README.md` | 本说明 |
| `cheer.schema.json` | JSON Schema（2020-12），描述结构与能用 Schema 表达的规则 |
| `samples/valid/*.cheer.json` | 应当读取成功的合成样例 |
| `samples/invalid/*.cheer.json` | 应当被拒绝的合成样例 |
| `samples/expected.json` | 每个样例的期望结果（§12） |
| `samples/match-cases.json` | 歌曲匹配的期望结果（§8） |
| `mix-library.json` | 内置 MIX 库（§13） |
| `LICENSE` | CC0 1.0 |

## 1. 这是什么

一个 `.cheer.json` 文件描述**一首歌**的应援时间轴：什么时候喊 MIX、喊 call、哪位成员在唱、什么时候举灯，以及谁做的、来源和授权。文件**不含歌词**：唱词永远来自播放端自己的歌词来源，分享出去的文件只有时间、口号、成员与署名。

## 2. 文件

- UTF-8 编码的 JSON 对象；整个文件不超过 **512 KiB（524 288 字节）**。写文件时不加 BOM；读取时先去掉开头的 UTF-8 BOM（EF BB BF）。
- 扩展名 `.cheer.json`。
- 同一对象里**不得有重复的键**；读到重复键的文件无效（§6、§14）。
- 时间单位一律为**秒**（JSON 数字，可带小数）。
- 本文说的“字数”指 **Unicode 码位**个数：“é”写成一个码位（U+00E9）算 1，写成“e”加组合符（U+0301）算 2；一个组合表情按它包含的码位计。
- “空白”指以下集合（Unicode White_Space 属性的字符，加 U+200B 零宽空格与 U+FEFF）：U+0009–U+000D、U+0020、U+0085、U+00A0、U+1680、U+2000–U+200A、U+2028、U+2029、U+202F、U+205F、U+3000、U+200B、U+FEFF。所有首尾修剪都用这一个集合；“非空”指去掉首尾空白后还剩内容。
- “换行”指 U+000A–U+000D、U+0085、U+2028、U+2029。

最小的有效文件：

```json
{
  "format": "liveglow-cheer",
  "version": 1,
  "song": { "title": "合成曲目", "artist": "合成组合", "duration": 180 },
  "events": [],
  "credits": { "authors": [{ "name": "合成作者" }], "permission": "original" }
}
```

完整示例见 `samples/valid/full-fields.cheer.json`。

## 3. 字段

可选字段可以不写，也可以写 `null`，两者**完全相同**（必填字段不能写 `null`）。字数按 §2 计。

### 3.1 顶层

| 字段 | 类型 | 必填 | 规则 |
| --- | --- | --- | --- |
| `format` | 字符串 | 是 | 固定 `"liveglow-cheer"` |
| `version` | 整数 | 是 | 固定 `1`（写成 `1.0` 也可）；更高版本拒绝并提示更新（§11） |
| `song` | 对象 | 是 | §3.2 |
| `offset` | 数字 | 否 | 制作者对整条时间轴的校正，−10 ≤ offset ≤ 10，缺省 0；正值让事件提前（与歌词偏移同义） |
| `members` | 数组 | 否 | 成员表，最多 64 位，§3.3；缺省为空 |
| `events` | 数组 | 是 | 事件，§3.4；最多 2000 条（含不认识的种类） |
| `credits` | 对象 | 是 | 署名、来源与授权，§3.5 |
| `generator` | 字符串 | 否 | 制作工具名称，最多 64 字 |

### 3.2 `song`：时间轴对应的录音

只存识别歌曲所需的元数据，不存歌词。

| 字段 | 类型 | 必填 | 规则 |
| --- | --- | --- | --- |
| `title` | 字符串 | 是 | 非空，最多 200 字 |
| `artist` | 字符串 | 是 | 非空，最多 200 字 |
| `duration` | 数字 | 是 | 打轴时那份录音的时长，0 < duration ≤ 7200 |
| `album` | 字符串 | 否 | 不校验 |
| `isrc` | 字符串 | 否 | 读取时去掉所有 `-` 与空白（§2 的集合），再把 ASCII 字母转大写；结果须为 2 个字母 + 3 个字母或数字 + 7 个数字（共 12 位，全部 ASCII），出现任何其他非 ASCII 字符即无效；读入后保存归一化的值 |
| `appleMusicID` | 字符串 | 否 | Apple Music 目录 ID，1–20 位数字 |

### 3.3 `members[]`：成员

| 字段 | 类型 | 必填 | 规则 |
| --- | --- | --- | --- |
| `id` | 字符串 | 是 | 1–32 位 `A–Z a–z 0–9 _ -`，文件内不重复 |
| `name` | 字符串 | 是 | 非空，最多 32 字 |
| `color` | 字符串 | 是 | `#RRGGBB`（十六进制，大小写均可） |

### 3.4 `events[]`：事件

| 字段 | 类型 | 必填 | 规则 |
| --- | --- | --- | --- |
| `start` | 数字 | 是 | ≥ 0 |
| `end` | 数字 | 是 | `end − start ≥ 0.05`（允许 1e-9 的舍入误差）；`end ≤ song.duration + 5` |
| `kind` | 字符串 | 是 | `mix`、`call`、`part`、`note`；其他值见 §4.5 |
| `text` | 字符串 | 视种类 | 口号或提示文字，可含名字空位（§5.1） |
| `members` | 字符串数组 | 视种类 | 成员 `id`，每个都必须在 `members` 表中 |
| `echo` | 布尔 | 否 | `true` 表示“跟唱这一句”（只用于 `call`） |
| `mixRef` | 字符串 | 否 | 只用于 `mix`：引用内置 MIX，`^[a-z0-9][a-z0-9:._-]{0,63}$`，如 `tradition:standard`；读取方不认识时照常显示 `text` |
| `steps` | 数字数组 | 否 | 只用于有文字的 `mix` / `call`：每个词从事件开始后第几秒喊起（§5.3） |
| `readings` | 对象 | 否 | 只用于有文字的 `mix` / `call`：每个词的读音（§5.4） |
| `tapped` | 布尔 | 否 | `true` 表示起点与逐词时间是边听边“逐词跟拍”得到的；只影响编辑器“对齐到歌词间隙”时是否移动起点。`false` 与不写相同 |
| `name` | 字符串 | 否 | 只用于 `mix` / `call`：制作者给这条起的名称，非空、最多 32 字、不含换行 |

事件可以重叠（成员段落和 call 常同时出现），顺序任意；读入后按 `start`、再按 `end`、再按原顺序排序。

### 3.5 `credits`：署名、来源与授权

| 字段 | 类型 | 必填 | 规则 |
| --- | --- | --- | --- |
| `authors` | 数组 | 是 | 每项 `{ "name": 字符串, "url"?: 字符串 }`；`name` 非空、最多 64 字；`url` 见下。**分享出去的文件至少一位作者**（只存在本机的副本可以为空，见 §6） |
| `sources` | 数组 | 否 | 每项 `{ "kind", "title"?, "url"?, "retrieved"? }`；`kind` 为 `self`（自己听写打轴）、`call-sheet`（粉丝 call 表）、`video`（视频）、`official`（官方应援法）、`other`；`title` 最多 120 字；`retrieved` 为日历上存在的日期 `YYYY-MM-DD` |
| `permission` | 字符串 | 是 | 授权状态，§9 |
| `license` | 字符串 | 视情况 | `permission` 为 `open-license` 时必填且非空，如 `CC-BY-4.0` |
| `note` | 字符串 | 否 | 说明，最多 200 字 |

链接（`authors[].url`、`sources[].url`）必须以 `http://` 或 `https://` 开头（大小写不限），并能解析为 URL（§14 第 4 条）。

## 4. 事件种类

| 种类 | 含义 | `text` | `members` |
| --- | --- | --- | --- |
| `mix` | MIX 口号 | 必填，非空，最多 120 字 | 可选 |
| `call` | call | 二选一：文字（必填、非空、最多 60 字），或 `echo: true` 且不写文字 | 可选 |
| `part` | 成员演唱段落 | **不许有** | 必填，至少一位 |
| `note` | 提示（举灯、跳、换色等） | 必填，非空，最多 60 字 | 可选 |

### 4.1 跟唱 `echo`

`echo: true` 只能用于 `call`，且不能同时写 `text`：跟唱的那一句由播放端从自己的歌词来源显示，文件里不写原文。`echo: false` 与不写相同，任何种类都可以写。

### 4.2 成员段落 `part`

唱词来自播放端的歌词，所以 `part` 不带文字；播放端用 `part` 给歌词行标出演唱成员（与歌词行重叠最长的段落）。

### 4.3 MIX 与 call 的名称

倒计时“下一条：…”和无障碍朗读用下面第一个适用的名称（参考实现 `CheerPresentation.title`）：

1. `echo: true` 的 call 显示“跟唱”；
2. 有 `name` 时用它（去掉首尾空白）；
3. 对应到内置 MIX 库的条目时用库里的名称：先看 `mixRef`，没有 `mixRef`（或库里没有这一条）时，`text` 与某个库条目的 `text` 完全相同也算；
4. 否则 MIX 显示前两个词（§5.2，名字已填入），超过两个词时加“…”；call 显示“Call：”、提示显示“提示：”，后接前 8 个字，超过时加“…”；没有文字时只显示“MIX”“Call”或“提示”。

### 4.4 不认识的种类

`kind` 不是上面四种之一的事件被**跳过**，并给出警告 `unknownKind`；文件照常读取。被跳过的事件只检查字段类型（`start`、`end` 为数字，`text` 为字符串……），不检查时间、成员与文字规则，但计入 2000 条上限，也在问题编号中占位（§7）。这为以后在第 1 版里增加新的事件种类留出余地（§11）。

## 5. 文字、拆词与逐词数据

### 5.1 名字空位

`text` 中：

- `{name}`：填入这条事件 `members` 的名字，多位成员用“・”连接。用了 `{name}` 的事件必须有 `members`。
- `{name:<成员 id>}`：填入指定成员的名字，该 id 必须在成员表中。
- `{{`、`}}`：花括号本身。
- 其他任何花括号写法都是错误（如 `{nam}`、单独的 `}`）。

通用 MIX 因此可以套用到任何组合。等价的正则（整段匹配）：`^(?:[^{}]|\{\{|\}\}|\{name(?::[^{}]+)?\})*$`。

### 5.2 拆词

`steps` 与 `readings` 都按词对应。一段文字按下面的规则拆成词（与参考实现 `CheerSteps.words` 一致）：

1. 从头逐字读，遇到“！”（U+FF01）或“!”（U+0021）就在它之后切开，切出的这段去掉首尾空白（§2 的集合）。
2. 如果这段开头是右括号“）”或“)”而前面已有词，把这些括号依次移到前一个词末尾（`（合成！）甲！` → `（合成！）`、`甲！`）。
3. 剩下的部分非空就成为一个词。
4. 最后一个“！”之后的余下文字同样去掉首尾空白：全是右括号且前面有词时并入最后一个词，否则（非空时）成为最后一个词。

没有“！”的文字是一个词。名字空位按原样留在词里。

### 5.3 逐词时间 `steps`

- 只用于有文字的 `mix` / `call`（不能用于 `echo` 的 call）；
- 个数等于词数，词数为 1–64；
- 严格递增，每项 ≥ 0 且 < `end − start`。

不写时，播放端在事件时长内均分。

### 5.4 读音 `readings`

`{ "kana"?: [字符串…], "romaji"?: [字符串…] }`：每个词的平假名与平文式罗马音，不含“！”与括号；某一项可以是空串（这个词没有读音）；`{name}` 照文字保留为空位。

读音“对得上”指：事件是有文字的 `mix` / `call`（不是 `echo`），至少写了一种列表，写了的列表个数都等于词数，每项最多 120 字、不含换行。**对不上只给警告 `readings`，文件照常读取**，这一条的读音被丢弃，播放端按文字重新生成。只写一种列表时，另一种由播放端生成。

## 6. 校验规则与读取顺序

读取一个分享来的文件按以下顺序进行，前七步任何一步失败即停止：

1. 大小超过 524 288 字节（按原始字节计，含 BOM）→ `tooLarge`。然后去掉开头的 UTF-8 BOM。
2. 不是 JSON，或顶层不是对象 → `notJSON`。
3. 任何对象里有重复的键（键按转义还原后的码位比较：`"text"` 与 `"\u0074ext"` 相同，预组合与分解写法的“é”不同）→ `duplicateKey`，只报文件中第一个重复处。
4. `format` 不是 `"liveglow-cheer"`（含缺失）→ `wrongFormat`。
5. `version` 缺失、不是数字、是布尔或不是整数 → `malformed`；是其他整数 → `unsupportedVersion`。
6. 扫描整个文件：任何层级的对象里有歌词键（§10）→ 每个一条 `lyricField`；嵌套超过 8 层 → `tooDeep`（顶层对象为第 0 层，每进入一层对象或数组加一）。
7. 按 §3 检查结构与类型：缺必填字段、类型不对、枚举值不在列表中（`permission`、`sources[].kind`）→ `malformed`（只报第一个）。
8. 跳过不认识种类的事件（§4.4，警告）。
9. 按 §3–§5 检查其余规则，列出全部错误与警告。有任何错误即拒绝。
10. 读取成功：丢弃对不上的读音，事件排序，`isrc` 归一化。

只存在本机的副本（读取方自己保存的文件）除“至少一位作者”外规则相同。

`cheer.schema.json` 能表达第 4–7 步与第 9 步中的大部分规则。以下规则 Schema **无法表达**，读取方须另外实现：文件大小、BOM、重复键、嵌套深度、链接能否解析、成员 id 不重复、事件与空位引用的成员存在、`end − start ≥ 0.05`、`end ≤ duration + 5`、`{name}` 需要成员、`steps` 的个数 / 递增 / 时长内、`readings` 是否对得上（警告）、`retrieved` 是否为真实日期，以及 `original` 而引用他人材料的警告。

## 7. 原因代码

每个问题有代码 `code`、位置 `path`，部分有附带值 `detail`。`path` 用点分隔键、方括号写下标，如 `events[3].text`、`credits.sources[0].url`；`""` 表示整个文件。`events[i]` 一律按文件中的原始顺序编号（被跳过的不认识种类也占位）。

**错误**（文件被拒绝）：

| 代码 | detail | path | 含义 |
| --- | --- | --- | --- |
| `tooLarge` | | `""` | 超过 512 KiB |
| `notJSON` | | `""` | 不是 JSON 对象 |
| `duplicateKey` | 键名 | 重复的键的位置 | 同一对象里有重复的键 |
| `wrongFormat` | | `format` | 不是本格式 |
| `unsupportedVersion` | 版本号 | `version` | 更新的版本 |
| `malformed` | | 出错的位置 | 缺字段或类型不对 |
| `lyricField` | 键名（原样） | 键的位置 | 带有歌词键 |
| `tooDeep` | | `""` | 嵌套超过 8 层 |
| `songTitle` / `songArtist` | | `song.title` / `song.artist` | 空或超过 200 字 |
| `songDuration` | | `song.duration` | 不在 (0, 7200] |
| `isrc` | | `song.isrc` | ISRC 格式不对 |
| `appleMusicID` | | `song.appleMusicID` | 不是 1–20 位数字 |
| `offset` | | `offset` | 超过 ±10 |
| `generator` | | `generator` | 超过 64 字 |
| `tooManyMembers` | | `members` | 超过 64 位 |
| `memberID` | | `members[i].id` | id 格式不对 |
| `duplicateMember` | | `members[i].id` | id 与前面的成员重复 |
| `memberName` | | `members[i].name` | 空或超过 32 字 |
| `memberColor` | | `members[i].color` | 不是 `#RRGGBB` |
| `tooManyEvents` | | `events` | 事件超过 2000 条（含不认识的种类） |
| `eventTime` | | `events[i]` | 开始早于 0，或短于 0.05 秒 |
| `eventPastSongEnd` | | `events[i].end` | 结束晚于歌曲时长 + 5 秒 |
| `unknownMember` | 成员 id | `events[i].members` 或 `events[i].text` | 引用了成员表中没有的成员 |
| `partWithoutMember` | | `events[i].members` | `part` 没有成员 |
| `textRequired` | | `events[i].text` | 缺文字或文字为空 |
| `textForbidden` | | `events[i].text` | `part` 带了文字 |
| `textTooLong` | 上限（120 或 60） | `events[i].text` | 文字太长 |
| `echo` | | `events[i].echo` | `echo: true` 用在 call 以外，或同时写了文字 |
| `slot` | | `events[i].text` | 花括号写法不对 |
| `slotWithoutMember` | | `events[i].text` | 用了 `{name}` 但这条没有成员 |
| `mixRef` | | `events[i].mixRef` | 用在 MIX 以外，或格式不对 |
| `steps` | | `events[i].steps` | §5.3 任一条不满足 |
| `eventName` | | `events[i].name` | 用在 MIX / call 以外，或空、超长、含换行 |
| `authorMissing` | | `credits.authors` | 分享的文件没有作者 |
| `authorName` | | `credits.authors[i].name` | 空或超过 64 字 |
| `url` | | `…url` | 不以 http:// / https:// 开头，或不能解析为 URL |
| `retrievedDate` | | `credits.sources[i].retrieved` | 不是真实日期 `YYYY-MM-DD` |
| `sourceTitle` | | `credits.sources[i].title` | 超过 120 字 |
| `licenseRequired` | | `credits.license` | `open-license` 却没写许可名称 |
| `note` | | `credits.note` | 超过 200 字 |

**警告**（文件照常读取）：

| 代码 | detail | path | 含义 |
| --- | --- | --- | --- |
| `unknownKind` | 种类名 | `events[i].kind` | 跳过了不认识的事件 |
| `readings` | | `events[i].readings` | 读音对不上，已丢弃 |
| `derivedMarkedOriginal` | | `credits.permission` | 标为原创但来源里有他人材料，只在本机使用 |

映场另有两个与文件内容无关、在导入导出时对照当前歌词产生的警告：`lyricOverlap`、`lyricsUnchecked`（§10）。

## 8. 歌曲匹配

播放端用下面的规则判断一个文件是否属于正在播放的录音（参考实现 `CheerChart.Song.match`）：

1. 两边都有非空 ISRC（按 §3.2 归一化后比较）：相同即匹配（强度 `isrc`），不同即**不匹配**——不同的 ISRC 是不同的录音（如现场版）。
2. 否则文件的 `appleMusicID` 非空且与正在播放的相同：匹配（强度 `catalog`）。不同不否决（各地区目录编号不同），继续第 3 步。
3. 否则比较元数据：标题与艺人各自归一化后相等且非空，两边时长都大于 0，且时长差 ≤ max(3 秒, 正在播放时长 × 1.5%)，即匹配（强度 `metadata`）。归一化：去掉 `<…>` 标签；忽略大小写、变音符号与全半角；只保留字母、数字与组合标记（Unicode L、M、N 类）。

一首歌有多份文件时，按强度（`isrc` > `catalog` > `metadata`）、再按导入时间取最新；用户可以手动换。`samples/match-cases.json` 列出了对照用例。

时间换算：`应援时间 = 播放位置 + 文件 offset + 用户偏移`。用户偏移由播放端按歌保存（映场为 ±5 秒、0.1 秒一档），不写进文件。

## 9. 授权状态与分享

| `permission` | 含义 | 能否分享 |
| --- | --- | --- |
| `original` | 制作者自己的作品（自己听写打轴） | 可以；但 `sources` 里有 `self` 以外的来源时给警告并只在本机使用 |
| `open-license` | 来源有明确的开放许可（`license` 写明） | 可以，保留署名 |
| `consented` | 原作者或官方同意转载 | 可以，保留署名 |
| `public-only` | 只是公开可见（含从视频整理的时间轴） | 只在本机使用 |
| `official` | 官方应援法，未明确允许转载 | 只在本机使用 |
| `unknown` | 未标明 | 只在本机使用 |

“只在本机使用”的文件仍然是有效文件，可以读取和使用；播放端只是不把它当作可分享的文件导出。

## 10. 不含歌词原文

分享的文件不得包含歌词原文。分三层保证：

1. **格式层（文件有效性的一部分）**：任何层级的对象里，键名转成小写后是 `lyrics`、`lyric`、`lrc`、`yrc`、`krc`、`qrc`、`tlyric`、`lines`、`words` 之一即拒绝（`lyricField`），未知字段里也一样；`part` 不许有文字；每段文字有长度上限。注意“K”（U+212A 开尔文符号）转小写是“k”。
2. **内容层（播放端在导入与导出时做，不属于文件有效性）**：把事件文字、读音与 `credits.note` 和当前已载入的歌词逐行比对：两边都按 §8 的方式归一化，名字空位去掉，中日韩字（U+2E80 及以上）计 2、其他计 1，两段共有一段权重 ≥ 8 的连续字符（约 4 个汉字或 8 个字母）即判为重合（`lyricOverlap`），须改写后才能分享。没有歌词可比对时给 `lyricsUnchecked`，分享前须制作者确认。
3. **表达层**：跟唱用 `echo: true`，不写原文。

## 11. 版本规则

- `version` 是整数。读取方只认自己支持的版本；遇到更高的版本拒绝读取并提示更新（`unsupportedVersion`），不尝试猜测。
- 第 1 版之内**只增加可选字段**（`steps`、`readings`、`tapped`、`name` 都是这样加入的）：新字段缺省时的行为必须与没有它的旧读取方一致；不改变已有字段的含义，不收紧已有限制，不新增必填字段。新的事件种类也可以在第 1 版内加入，旧读取方会跳过它（§4.4）。
- 旧文件永远照常读取：没有新字段的文件按缺省行为显示。
- 未知字段：读取时忽略，但仍受歌词键、重复键与嵌套深度检查。映场目前重新保存或导出时只写它认识的字段，未知字段不保留；日后在第 1 版里新增字段时，再改为原样保留未知字段，让新文件经旧版映场保存也不丢内容。新增字段不得使用歌词键作名称。
- 需要改变含义、收紧限制或增加必填项时，升为第 2 版；第 2 版的说明须写明如何读取第 1 版文件。

## 12. 对照样例

`samples/expected.json` 的 `samples` 列出每个样例：

| 字段 | 含义 |
| --- | --- |
| `file` | 相对 `samples/` 的路径 |
| `description` | 样例检验的是什么 |
| `valid` | 作为分享来的文件读取，是否成功 |
| `errors` | 失败时的全部错误：`{ code, path, detail? }` |
| `warnings` | 成功时的全部警告 |
| `sharing` | 成功时能否分享：`shareable` 或 `localOnly` |
| `eventStarts` | 成功时读入的事件（已跳过不认识的种类、已排序）的 `start` |
| `isrc` | 成功时归一化后的 ISRC（只在相关样例中给出） |
| `schema` | 只用 `cheer.schema.json` 校验是否通过；`null` 表示文件不是 JSON。用于检查 Schema 本身，不代替第 6 节的完整规则 |

`errors` 与 `warnings` 按集合比较，不比较顺序。实现须让每个样例的 `valid`、`errors` / `warnings`、`sharing` 与 `eventStarts` 都与清单一致；对照测试为映场的 [`CheerSpecTests.swift`](https://github.com/alexpsz/liveglow/blob/main/native/MiraNative/Tests/MiraStageHostTests/CheerSpecTests.swift)（Swift 读取器）与 [`tests/cheer-spec.test.js`](https://github.com/alexpsz/liveglow/blob/main/tests/cheer-spec.test.js)（Schema），以及 CheerBook 的 [`tests/cheer.test.js`](https://github.com/alexpsz/cheerbook/blob/main/tests/cheer.test.js)（JavaScript 读取器）。

样例只用合成内容：曲名、组合、成员、作者与口号都是编造的，链接只用 `example.com`，不含任何真实歌词或账号数据。

## 13. 内置 MIX 库 `mix-library.json`

偶像现场通用的 MIX 与 call，按“应援圈传统”署名，CC0。只收多个独立公开页面交叉核对为通用的口号，不收某个组合专属的口号；不照搬任何网站的分类、顺序或说明。

| 字段 | 含义 |
| --- | --- |
| `format` / `version` | `"liveglow-cheer-mix-library"` / `1` |
| `license` | `"CC0-1.0"` |
| `credit` | 署名“应援圈传统” |
| `retrieved` | 来源页面的读取日期 |
| `sources` | 来源代码 → 页面地址 |
| `entries[]` | 条目，顺序即显示顺序 |

文件头的规则：`format`、`version` 如上；`license` 必须是 `"CC0-1.0"`；`credit` 非空；`retrieved` 是真实日期；`sources` 至少一项，每个地址都是 http / https 链接。任何一条不满足，整份库不加载。

每个条目（除注明“可选”外都必填）：

| 字段 | 规则 |
| --- | --- |
| `id` | `^[a-z0-9][a-z0-9._-]{0,53}$`（这样 `tradition:<id>` 仍是合法的 `mixRef`），在库内唯一；事件用 `mixRef: "tradition:<id>"` 引用 |
| `name` | 名称，非空 |
| `kind` | `mix` 或 `call` |
| `text` | 插入时的日文原文，非空，`{name}` 为成员空位；按原样插入后必须是有效事件：名字空位合法（§5.1），长度不超过该种类的上限（§4） |
| `romaji` | 整句罗马音（显示用），非空 |
| `bars` | `[最少, 最多]` 小节数（约数），整数且 1 ≤ 最少 ≤ 最多；推荐按范围匹配，插入取下限 |
| `positions` | 常见位置，取自 `intro`（前奏）、`afterMix`（接在 MIX 后）、`interlude`（间奏）、`chorusLead`（副歌前）、`outro`（尾奏）、`verse`（有人唱时）；空数组表示不参与自动推荐 |
| `sources` | 来源代码，至少两个且不重复，都在文件头的 `sources` 中 |
| `note` | 可选，用法说明 |
| `readings` | 人工核对的每词平假名与罗马音，`kana` 与 `romaji` 两种都必须有，且按 §5.4 对得上 |
| `readingNote` | 可选，无词典可查的读音说明 |

不合规的条目被跳过，其余条目照常使用。映场把这份文件打包进 App（`Contents/Resources/cheer-mix-library.json`，构建时核对与映场仓库 `spec/cheer/` 中的副本逐字节相同）读取；文件或条目被拒绝时，原因写入系统日志（分类 `Cheer`，只记文件名、条目 id 与违反的规则）。

## 14. 边界规则

以下七条是写规格时发现各实现天然不同的边界，现已定为唯一规则；映场照此实现，网页版与其他读取方也须照此实现，每条都有对照样例。正常文件不受影响。

1. **长度按码位**：所有字数上限按 Unicode 码位计（§2）。JavaScript 用 `[...text].length` 或逐码位计数，不要用 `text.length`（UTF-16 单元）或 `Intl.Segmenter`（字素）。样例：`valid/text-combining-at-limit`、`invalid/call-text-combining-too-long`。
2. **一个空白集合**：所有首尾修剪（是否为空、拆词、ISRC 去空白）都用 §2 的集合：Unicode White_Space 加 U+200B、U+FEFF。JavaScript 的 `trim()` 与 `\s` 不含 U+0085、U+200B，不能直接使用。样例：`valid/whitespace-set`、`invalid/blank-title-bom`、`invalid/blank-artist-nel`、`invalid/blank-artist-zero-width-space`。
3. **`null` 等同缺省**：可选字段写 `null` 与不写完全相同（§3）。样例：`valid/null-optional`。
4. **链接与 ISRC**：链接以 `http://` 或 `https://`（大小写不限）开头且能解析为 URL 即可（§3.5）；ISRC 只接受 ASCII 字母数字，去掉连字符与空白后把 ASCII 字母转大写，剩下任何非 ASCII 字符即无效（§3.2）。样例：`valid/link-forms`、`invalid/link-unparseable`、`invalid/link-bad-port`、`valid/isrc-spaced`、`invalid/isrc-non-ascii`。
5. **重复键与 BOM**：写文件不得有重复键；读到重复键即无效（`duplicateKey`）。JSON 解析器通常不报重复键（`JSON.parse` 取最后一个），读取方须在解析前另行检测：键按转义还原后的码位比较，报文件中第一个重复。读取前去掉开头的 UTF-8 BOM。样例：`invalid/duplicate-key-root`、`invalid/duplicate-key-escaped`、`valid/bom-prefixed`。
6. **事件编号与上限**：问题里的 `events[i]` 一律按文件中的原始顺序编号，被跳过的未知种类也占位；2000 条上限计入全部事件。样例：`invalid/unknown-kind-then-error`、`invalid/too-many-events-with-unknown`。
7. **重新保存不保留未知字段**：映场重新保存或导出时只写它认识的字段（§11）；日后在第 1 版里新增字段时，再改为原样保留未知字段。

仍需注意的一点：“能解析为 URL”由各平台的 URL 解析器判断（映场为 Foundation `URL(string:)`，网页为 WHATWG `new URL()`），两者对极少数畸形链接（如只有 `https://`、主机名中带反斜杠）结论不同；样例只收两者一致的情况。
