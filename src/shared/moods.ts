/**
 * Moods & genres — the shared shape for the provider's per-market browse
 * catalog (Explore page) and the neutral fallback used when the provider is
 * unreachable. The fallback is deliberately GLOBAL: no market-specific
 * entries, so an offline user never sees another country's suggestions.
 */
export interface MoodEntry {
  title: string;
  browseId: string;
  params: string | null;
  /** provider accent color (#RRGGBB), or null when the button carries none */
  color: string | null;
  /** the moods page heading it sits under ("Moods & moments", "Genres"), when known */
  section?: string | null;
}

/** Neutral global fallback — same titles work as searches in every market. */
export const FALLBACK_MOODS: MoodEntry[] = [
  { title: "Today's hits", browseId: "", params: null, color: "#E13300" },
  { title: "Lo-fi beats", browseId: "", params: null, color: "#4B2AAD" },
  { title: "Workout energy", browseId: "", params: null, color: "#D00000" },
  { title: "Focus flow", browseId: "", params: null, color: "#023E8A" },
  { title: "Rock classics", browseId: "", params: null, color: "#370617" },
  { title: "Jazz evenings", browseId: "", params: null, color: "#2B2D42" },
  { title: "Pop hits", browseId: "", params: null, color: "#C9184A" },
  { title: "Chill mix", browseId: "", params: null, color: "#2D6A4F" },
];
