/**
 * App-level configuration.
 *
 * The Supabase anon key is public by design (it ships inside the app); the
 * real gate is Row-Level Security on the server. Paste the values from
 * Supabase → Project Settings → API here.
 */
export const SUPABASE_URL = "https://jbctywgcnhryyqgkssme.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_1zlCAPUeNhU9osfQrbnb6A_PvTFVhOq";

/** Deep-link scheme used for the Google OAuth redirect back into the app. */
export const OAUTH_PROTOCOL = "bytune";
export const OAUTH_REDIRECT = "bytune://oauth/callback";

/** Local JSON stores replicated to the cloud when signed in. */
export const SYNCED_STORES = [
  "library",
  "settings",
  "recent-searches",
  "listening-signals",
  "listening-history",
  "artist-meta-cache",
] as const;

/**
 * Username namespace that never collides with real email addresses.
 *
 * Usernames may contain `_` and `@`; the auth provider's email validation
 * rejects a raw `@` inside the local part, so every `@` maps to `--`. The
 * mapping is injective over the allowed charset (`-` is not a legal username
 * character, so `--` can only ever come from an `@`), and names without `@`
 * map exactly as they always have — existing accounts are unaffected.
 */
export const syntheticEmail = (username: string): string =>
  `${username.toLowerCase().replace(/@/g, "--")}@users.bytune.local`;
