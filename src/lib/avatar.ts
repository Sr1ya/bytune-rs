/**
 * The round avatar: its colour and its letter. The top bar's profile button and the account card in
 * Settings draw the same one, so you see the button you pressed again at the top of Settings.
 */

/* Every tone is mid-saturation and light enough that near-black text stays readable on it. */
const AVATAR_COLORS = [
  "#d97757", "#e0a458", "#d4c95a", "#8fc74f", "#5fc9a2",
  "#59a5d8", "#8f9bf4", "#c58af9", "#e17bb0", "#e06c75",
];

/* Deterministic per-user colour: a simple FNV-1a hash of the username picks
   the palette entry, so an account always gets the same colour across
   launches while different users land on effectively random ones. */
function avatarColor(seed: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/**
 * The avatar for a session. The colour stays tied to the account, so it doesn't change with a new
 * display name. The letter is the first one of the name shown (a guest without a name, and a session
 * not loaded yet, show "G"), by code point, so an emoji stays whole.
 */
export function avatarFor(mode: "guest" | "account" | null, username: string | null, shown: string | null | undefined): { color: string; letter: string } {
  return {
    color: avatarColor(mode === "account" && username?.trim() ? username.trim().toLowerCase() : "guest"),
    letter: shown ? Array.from(shown)[0].toUpperCase() : "G",
  };
}
