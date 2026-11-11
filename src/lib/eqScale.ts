/**
 * Where a band of the Settings equalizer sits: its knob is drawn where the band's own (invisible)
 * native slider puts its thumb, so a press or a drag moves the knob under the pointer.
 */

/** The bands' range, ± dB. */
export const EQ_RANGE = 12;

/**
 * A knob's centre, px from the slider's top, for `gain` dB on a vertical slider `height` px tall
 * with a `thumb` px thumb (a native range keeps its whole thumb inside the track).
 */
export function eqY(gain: number, height: number, thumb: number): number {
  const g = Math.max(-EQ_RANGE, Math.min(EQ_RANGE, gain));
  return thumb / 2 + (1 - (g + EQ_RANGE) / (2 * EQ_RANGE)) * (height - thumb);
}
