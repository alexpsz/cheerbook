'use strict';
// Where a contribution goes in cheers/, shared by the community checks (lib/library.js) and the
// web editor, which suggests the path when it opens a contribution on GitHub. Pure: no file system.
const cheer = require('./cheer');

const LIBRARY_DIR = 'cheers';
const NAME_LIMIT = 80;
// The index copies these, so they are kept short; the format itself does not limit them.
const ALBUM_LIMIT = 200;
const AUTHOR_LIMIT = 16;
// Characters a folder or file name may not hold on any of macOS, Windows and Linux, and invisible
// format characters (zero-width, bidirectional controls) that make two names look alike.
const FORBIDDEN = /[\u0000-\u001F\u007F/\\:*?"<>|]/gu;
const INVISIBLE = /\p{Cf}/gu;
// Names Windows reserves for devices, with or without an extension.
const RESERVED = /^(con|prn|aux|nul|com[0-9\u00B9\u00B2\u00B3]|lpt[0-9\u00B9\u00B2\u00B3])(\..*)?$/iu;

/** User-supplied text inside a message: quoted, with line breaks and control characters escaped. */
const quote = value => JSON.stringify(String(value)).replace(/[\u0085\u2028\u2029]/gu, c => '\\u' + c.codePointAt(0).toString(16).padStart(4, '0'));

/** How macOS and Windows compare names: case-insensitively. */
const nameKey = name => name.normalize('NFC').toUpperCase().toLowerCase();

/** A folder name from a song's artist or title (CONTRIBUTING.md §3). */
function folderName(text) {
  const clean = name => cheer.trimmed(name).replace(/[. ]+$/u, '');
  let name = clean(text.normalize('NFC').replace(INVISIBLE, '').replace(FORBIDDEN, '_'));
  name = clean([...name].slice(0, NAME_LIMIT).join(''));
  if (name === '' || name === '.' || name === '..') return '_';
  return RESERVED.test(name) ? name + '_' : name;
}

/** Where a file with this song belongs, relative to the repository root. */
function expectedFolder(song) {
  return [LIBRARY_DIR, folderName(song.artist), folderName(song.title)].join('/');
}

module.exports = { LIBRARY_DIR, NAME_LIMIT, ALBUM_LIMIT, AUTHOR_LIMIT, FORBIDDEN, INVISIBLE, RESERVED, quote, nameKey, folderName, expectedFolder };
