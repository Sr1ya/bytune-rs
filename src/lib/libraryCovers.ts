/**
 * Sleeves for the collections ByTune keeps for you: Liked Songs, Replay,
 * Downloads and Local Music. Each is one soft diagonal light, deep at the top
 * left and pale at the bottom right, under a single white mark, drawn as SVG
 * so it stays sharp at every size. Liked Songs is violet into mint (the
 * user's pick); the others take colours of their own, clear of the Spotify
 * row's green right under Liked Songs.
 */

const sleeve = (stops: readonly [string, string, string], mark: (mid: string) => string): string =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240">` +
      `<defs>` +
      `<linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
      `<stop offset="0" stop-color="${stops[0]}"/><stop offset="0.52" stop-color="${stops[1]}"/><stop offset="1" stop-color="${stops[2]}"/>` +
      `</linearGradient>` +
      // A faint sheen from the top left, so the light reads as light rather than a flat fill.
      `<radialGradient id="s" cx="0.2" cy="0.1" r="0.8"><stop offset="0" stop-color="#fff" stop-opacity="0.18"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>` +
      `</defs>` +
      `<rect width="240" height="240" fill="url(#g)"/><rect width="240" height="240" fill="url(#s)"/>` +
      `<g transform="translate(69.6 69.6) scale(4.2)" fill="#fff">${mark(stops[1])}</g>` +
      `</svg>`
  )}`;

/** A full heart, its point rounded off like the lobes. */
const HEART = () =>
  `<path d="M12 20.4 4.6 13.1C2.5 11 2.2 7.7 4.1 5.6 6 3.5 9.3 3.4 11.4 5.4L12 6l.6-.6c2.1-2 5.4-1.9 7.3.2 1.9 2.1 1.6 5.4-.5 7.5Z" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/>`;

/** Three bars of a listening chart. */
const BARS = () =>
  `<rect x="4.2" y="11" width="4.2" height="9" rx="2.1"/><rect x="9.9" y="4" width="4.2" height="16" rx="2.1"/><rect x="15.6" y="8" width="4.2" height="12" rx="2.1"/>`;

/** An arrow coming down into a tray. */
const DOWN = () =>
  `<g fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.8v10.4"/><path d="m7.4 9.8 4.6 4.6 4.6-4.6"/><path d="M4.8 19.6h14.4"/></g>`;

/** A folder with a note on it, the note cut in the sleeve's own colour. */
const FOLDER = (mid: string) =>
  `<path d="M3.2 7.4c0-1.4 1.1-2.5 2.5-2.5h3.7c.7 0 1.3.3 1.8.8l1.2 1.3h5.9c1.4 0 2.5 1.1 2.5 2.5v8.3c0 1.4-1.1 2.5-2.5 2.5H5.7c-1.4 0-2.5-1.1-2.5-2.5Z"/>` +
  `<g fill="${mid}"><circle cx="11.6" cy="15.2" r="1.9"/><rect x="12.7" y="9.2" width="1.5" height="6.2" rx=".7"/><path d="M13.4 9.2h2.9c.4 0 .7.3.7.7v.9h-3.6Z"/></g>`;

export const LIKED_COVER = sleeve(["#4310F5", "#8D85E5", "#B4F0D6"], HEART);
export const REPLAY_COVER = sleeve(["#E0135A", "#F77B7B", "#FFDDB0"], BARS);
export const DOWNLOADS_COVER = sleeve(["#1238E6", "#3D8BF2", "#CDE9FF"], DOWN);
export const LOCAL_COVER = sleeve(["#E2550B", "#F59A2F", "#FFEAB0"], FOLDER);
