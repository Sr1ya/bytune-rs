/**
 * Account validation rules — shared by the Electron main process (the
 * authority, talks to Supabase) and the renderer (live inline feedback), so
 * both sides can never disagree.
 *
 * Username policy: ASCII letters, digits, underscore and @. Uniqueness is
 * case-insensitive: everything is normalized to lowercase before any
 * database read/write. The `profiles.username_format` CHECK constraint in
 * supabase/schema.sql must stay in sync with USERNAME_RE (lowercase form).
 */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 20;
export const PASSWORD_MIN = 8;

export const USERNAME_RE = /^[a-zA-Z0-9_@]+$/;

/** Canonical form stored in the database and used for lookups. */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

/** What the user may type — the canonical form must round-trip losslessly. */
export function usernameTypable(username: string): string {
  return username.replace(/[^a-zA-Z0-9_@]/g, "").slice(0, USERNAME_MAX);
}

/**
 * Returns null when the username is acceptable, otherwise a short human
 * message. The database UNIQUE constraint remains the final authority for
 * availability — this only validates format.
 */
export function usernameProblem(username: string): string | null {
  const clean = normalizeUsername(username);
  if (clean.length < USERNAME_MIN) return `Username must be at least ${USERNAME_MIN} characters.`;
  if (clean.length > USERNAME_MAX) return `Username must be at most ${USERNAME_MAX} characters.`;
  if (!USERNAME_RE.test(clean)) return "Use letters, numbers, _ and @ only.";
  return null;
}

export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  return null;
}

/* ---------------------------------------------------------------------- */
/* Display name                                                            */
/* ---------------------------------------------------------------------- */

/**
 * What people see in Rooms and around the app: any language, emoji, not unique. In step with the
 * display_names checks in supabase/migrations/0003-display-names.sql: 1-30 characters counted as the
 * database counts them (code points), no spaces at either end, no control characters.
 */
export const DISPLAY_NAME_MAX = 30;

/** Line breaks, tabs and other control characters become spaces, runs of spaces one, then trimmed. */
export function normalizeDisplayName(name: string): string {
  return name
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function displayNameProblem(name: string): string | null {
  const clean = normalizeDisplayName(name);
  if (!clean) return "Enter a display name.";
  if ([...clean].length > DISPLAY_NAME_MAX) return `Display names can be up to ${DISPLAY_NAME_MAX} characters.`;
  return null;
}

/* ---------------------------------------------------------------------- */
/* Availability lookup result → UI state                                   */
/* ---------------------------------------------------------------------- */

export type UsernameAvailability = "idle" | "checking" | "free" | "taken" | "unknown";

/**
 * Map a live availability-check result to form state. `null`/undefined (the
 * lookup failed — offline, network error) reads as "unknown", never "taken":
 * the form stays submittable and the database UNIQUE constraint decides for
 * real at sign-up. Treating a failed lookup as "taken" used to brick the
 * sign-up form whenever the network was down.
 */
export function availabilityState(available: boolean | null | undefined): UsernameAvailability {
  if (available === true) return "free";
  if (available === false) return "taken";
  return "unknown";
}
