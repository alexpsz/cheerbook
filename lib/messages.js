'use strict';
// What a listener reads for each format issue (spec/README.md §7): a plain sentence, with the
// place named in words ("第 3 条应援") rather than the file's field names. Ported from Liveglow's
// CheerIssue.message and CheerIssue.place so the web editor and the app say the same things.

const MAX_MEMBERS = 64;
const MAX_EVENTS = 2000;
const NAME_LIMIT = 32;

const SENTENCES = {
  tooLarge: () => '文件太大了，应援文件不能超过 512 KB。',
  notJSON: () => '这不是有效的应援文件，内容无法读取。',
  duplicateKey: () => '文件里有重复的项目，无法确定该用哪一个，所以无法读取。',
  malformed: () => '文件里有内容缺失或格式不对，无法读取。',
  wrongFormat: () => '这不是映场的应援文件。',
  unsupportedVersion: detail => `这是新版映场制作的文件（第 ${detail} 版），请更新后再打开。`,
  lyricField: () => '文件里带有歌词内容。应援文件不能包含歌词，所以无法使用。',
  tooDeep: () => '文件结构太复杂，无法读取。',
  songTitle: () => '缺少歌名。',
  songArtist: () => '缺少歌手。',
  songDuration: () => '歌曲时长不对。',
  isrc: () => '歌曲的 ISRC 编号格式不对。',
  appleMusicID: () => '歌曲的 Apple Music 编号格式不对。',
  offset: () => '整体偏移不能超过前后 10 秒。',
  generator: () => '制作工具名称太长。',
  tooManyMembers: () => `成员太多了，最多 ${MAX_MEMBERS} 位。`,
  memberID: () => '成员的内部编号格式不对。',
  duplicateMember: () => '有两位成员用了同一个内部编号。',
  memberName: () => '请填写成员名字（最多 32 个字）。',
  memberColor: () => '成员颜色不对，请重新选择。',
  tooManyEvents: () => `应援太多了，最多 ${MAX_EVENTS} 条。`,
  eventTime: () => '时间不对：开始不能早于 0 秒，且至少要有 0.05 秒长。',
  eventPastSongEnd: () => '结束时间超出了歌曲长度。',
  unknownMember: () => '指定的成员已经不在成员列表里，请重新选择。',
  partWithoutMember: () => '演唱段落需要选一位成员。',
  textRequired: () => '请填写文字。',
  textForbidden: () => '演唱段落不能写文字，唱词会从播放时的歌词显示。',
  textTooLong: detail => `文字太长了，最多 ${detail} 个字。`,
  echo: () => '“跟唱”只能用于 call，而且不能同时写文字。',
  slot: () => '名字的写法不对：请用 {name} 代表成员名字。',
  slotWithoutMember: () => '文字里有 {name}，请为这一条选一位成员。',
  mixRef: () => '引用的 MIX 不对，请重新选择。',
  steps: () => '逐词时间和文字对不上，请重新分配节拍。',
  eventName: () => `名称只能用于 MIX 或 call，最多 ${NAME_LIMIT} 个字，不能换行。`,
  authorMissing: () => '请填写作者名字，可以用昵称。',
  authorName: () => '作者名字最多 64 个字。',
  licenseRequired: () => '选了开放许可时，请写明许可名称。',
  url: () => '链接需要以 http:// 或 https:// 开头，并且是有效的网址。',
  retrievedDate: () => '日期请写成 2026-10-18 这样的格式。',
  sourceTitle: () => '来源说明太长了，最多 120 个字。',
  note: () => '说明太长了，最多 200 个字。',
  unknownKind: detail => `有一种这个版本不认识的应援（${detail}），已跳过。`,
  derivedMarkedOriginal: () => '参考了别人的版本，所以这份应援只在本机使用。',
  lyricOverlap: () => '文字和歌词重合了。分享的文件不能包含歌词原文，请改写。',
  lyricsUnchecked: () => '未能核对歌词，确认文件里没有歌词原文后再分享。',
  readings: () => '读音和文字对不上，已忽略这一条的读音，会按文字重新生成。',
};

/** The index in `path` after `prefix[`, as in `events[3]…`, or null. */
function indexAfter(path, prefix) {
  const match = new RegExp('^' + prefix.replace(/[.[\]]/g, '\\$&') + '\\[(\\d+)\\]').exec(path || '');
  return match ? Number(match[1]) : null;
}

/** The place in words for the parts a listener edits row by row, or null where the sentence says it. */
function issuePlace(issue) {
  let i = indexAfter(issue.path, 'events');
  if (i !== null) return `第 ${i + 1} 条应援`;
  if ((i = indexAfter(issue.path, 'members')) !== null) return `第 ${i + 1} 位成员`;
  if ((i = indexAfter(issue.path, 'credits.sources')) !== null) return `第 ${i + 1} 个来源`;
  if ((i = indexAfter(issue.path, 'credits.authors')) !== null && issue.code === 'url') return `第 ${i + 1} 位作者的链接`;
  return null;
}

/** One sentence for an issue `{ code, path, detail? }`; unknown codes fall back to the code itself. */
function issueMessage(issue) {
  const sentence = SENTENCES[issue.code] ? SENTENCES[issue.code](issue.detail) : `问题：${issue.code}`;
  const place = issuePlace(issue);
  return place ? `${place}：${sentence}` : sentence;
}

/** Warnings let the file load; everything else rejects it (spec/README.md §7). */
const WARNING_CODES = new Set(['unknownKind', 'readings', 'derivedMarkedOriginal', 'lyricOverlap', 'lyricsUnchecked']);
const isWarning = issue => WARNING_CODES.has(issue.code);

module.exports = { issueMessage, issuePlace, isWarning, SENTENCE_CODES: Object.keys(SENTENCES) };
