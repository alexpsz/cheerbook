'use strict';
// Filters the list of cheers as the visitor types. It reads only text already on the page and
// changes only which items are hidden, so the page works the same without it.
(() => {
  const input = document.getElementById('filter');
  if (!input) return;
  // Shown only when this script runs, so the box never sits there doing nothing.
  input.closest('.filter').hidden = false;
  const songs = [...document.querySelectorAll('[data-search]')];
  const artists = [...document.querySelectorAll('[data-artist]')];
  const status = document.getElementById('filter-status');
  const fold = text => text.normalize('NFKC').toLowerCase();
  input.addEventListener('input', () => {
    const query = fold(input.value.trim());
    let shown = 0;
    for (const song of songs) {
      const match = query === '' || fold(song.dataset.search).includes(query);
      song.hidden = !match;
      if (match) shown++;
    }
    for (const artist of artists) artist.hidden = !artist.querySelector('[data-search]:not([hidden])');
    status.textContent = query === '' ? '' : shown ? `找到 ${shown} ${input.dataset.unit || '首歌'}` : '没有找到，换个关键词试试';
  });
})();
