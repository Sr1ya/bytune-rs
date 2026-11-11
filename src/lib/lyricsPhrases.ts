/**
 * The lyric lookup's stand-in copy, BitChord mobile's own word lists
 * (strings.xml `lyrics_intro_lines` / `lyrics_loading_lines`).
 *
 * While a lookup is in flight the loading view shows one of the loading
 * lines instead of a bare spinner, and the player strip shows one of the
 * intro lines while the song is still building toward its first sung line.
 * Callers pick once per track (memo keyed on the track id) and hold the
 * line there — the way the phone keys its pick to the track so the copy
 * never flickers on recomposition.
 */

export const LYRICS_LOADING_LINES: string[] = [
  "Getting the lyrics",
  "Finding the words",
  "Fetching the verses",
  "Lyrics are loading",
  "Checking the lyric sheet",
  "Searching the songbook",
  "Lining up the lyrics",
  "Words are on the way",
  "Checking the archives",
  "Finding the right words",
  "Lyrics are coming together",
  "Almost found the words",
];

export const LYRICS_INTRO_LINES: string[] = [
  "The beat is landing",
  "The song is starting",
  "Warming up",
  "Setting the mood",
  "Bass first, words later",
  "Wait for it",
  "Feel that build",
  "Just the groove for now",
  "The hook is on the way",
  "Let it breathe",
  "Cue the vocals",
  "First notes in",
];

export function pickLyricsLine(list: string[]): string {
  return list[Math.floor(Math.random() * list.length)] ?? list[0];
}
