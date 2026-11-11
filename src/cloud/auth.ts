/**
 * Supabase accounts — a port of ByTune's electron/supabase.ts, run in the main window.
 *
 * Three identities:
 *  - username + password  → Supabase email auth with a synthetic `<username>@users.bytune.local`
 *    address; uniqueness is guaranteed by a UNIQUE column in the `profiles` table, not by the auth
 *    provider.
 *  - Google OAuth         → PKCE flow through the default browser, coming back over the bytune://
 *    deep link (src-tauri/src/links.rs parks it until this module takes it).
 *  - guest                → no account at all; a local profile marker only.
 *
 * The session is sealed in the OS keychain by the backend (src-tauri/src/cloud.rs) — ByTune sealed it
 * with Electron's safeStorage. Supabase's client keeps nothing of its own (`persistSession: false`).
 *
 * One difference from running in Electron's main process: in a page, Supabase's client stops
 * refreshing the token while the window is hidden (ByTune closed to the tray), so cloud work asks for
 * a fresh session first (`liveUserId`) rather than trusting a copy that may have expired meanwhile.
 */
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";
import { OAUTH_REDIRECT, SUPABASE_ANON_KEY, SUPABASE_URL, syntheticEmail } from "../lib/config";
import {
  DISPLAY_NAME_MAX,
  displayNameProblem,
  normalizeDisplayName,
  normalizeUsername,
  passwordProblem,
  usernameProblem,
} from "../lib/account-validators";
import { backend, readStore, writeStore } from "./backend";

export type AuthMode = "guest" | "account";
export interface LocalProfile {
  mode: AuthMode;
  userId?: string;
  username?: string;
  /** Google sign-ins start with an auto username until the user picks one. */
  pendingUsername?: boolean;
  /** What people see (Rooms, the avatar). An account's is kept on the server too (display_names). */
  displayName?: string;
  /** Saved here while the server couldn't take it: sent at the next sync. */
  displayNamePending?: boolean;
  /** A new Google account's name (or the guest's, carried over), offered while it picks a username. */
  suggestedDisplayName?: string;
  deviceId: string;
  createdAt: number;
}
export interface SessionInfo {
  mode: AuthMode | null;
  userId: string | null;
  username: string | null;
  displayName?: string | null;
  suggestedDisplayName?: string;
  /** ByTune's reinstall prompt; packages here keep no install-folder marker, so always false. */
  freshInstall: boolean;
  needsUsername?: boolean;
  /** True only when this call CREATED the account (sign-up, or a first-ever Google sign-in). */
  isNewAccount?: boolean;
}

let client: SupabaseClient | null = null;
let currentSession: Session | null = null;
/** The profile store, mirrored: sessionInfo() answers synchronously, as it did in main. */
let profileCache: LocalProfile | null = null;
/** A guest's display name while they go through sign-up (clearGuestProfile empties the profile first). */
let carriedName: string | null = null;

function newDeviceId(): string {
  return `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** For sync and Rooms — the shared client (null before first use). */
export function getClient(): SupabaseClient | null {
  return client;
}

function supabase(): SupabaseClient {
  if (client) return client;
  client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      flowType: "pkce",
      detectSessionInUrl: false,
      autoRefreshToken: true,
      persistSession: false, // the backend keeps it, sealed
    },
  });
  client.auth.onAuthStateChange((_event, session) => {
    currentSession = session;
    void persistSession(session);
  });
  return client;
}

/** The profile mirror, at boot (local only: every page write waits on this). */
export async function loadProfile(): Promise<void> {
  profileCache = ((await readStore("profile")) as LocalProfile | null) ?? null;
}

/** Restore the sealed session (if any) — may need the network to refresh it. */
export async function initAuth(): Promise<void> {
  const stored = (await backend<Session | null>("auth:loadSession").catch(() => null)) ?? null;
  if (!stored?.access_token || !stored?.refresh_token) return;
  try {
    const { data, error } = await supabase().auth.setSession({
      access_token: stored.access_token,
      refresh_token: stored.refresh_token,
    });
    if (error) {
      console.warn("[bytune] session restore failed:", error.message);
      return;
    }
    currentSession = data.session;
  } catch (err) {
    console.warn("[bytune] unreadable stored session:", err);
  }
}

async function persistSession(session: Session | null): Promise<void> {
  await backend("auth:saveSession", session ?? null).catch((err) => console.warn("[bytune] session not saved:", err));
}

/* ------------------------------------------------------------------ */
/* Local profile (guest marker / signed-in marker)                     */
/* ------------------------------------------------------------------ */

export function readProfile(): LocalProfile | null {
  return profileCache;
}

async function saveProfile(next: LocalProfile | null): Promise<void> {
  profileCache = next;
  await writeStore("profile", next);
}

async function writeProfile(patch: Partial<LocalProfile> & { mode: AuthMode }): Promise<LocalProfile> {
  const existing = readProfile();
  const next: LocalProfile = {
    deviceId: existing?.deviceId ?? newDeviceId(),
    createdAt: existing?.createdAt ?? Date.now(),
    ...existing,
    ...patch,
  } as LocalProfile;
  // `undefined` fields are dropped by the JSON write, as they were by ByTune's.
  await saveProfile(JSON.parse(JSON.stringify(next)) as LocalProfile);
  return next;
}

export function sessionInfo(): SessionInfo {
  const profile = readProfile();
  if (!profile) {
    return { mode: null, userId: null, username: null, displayName: null, freshInstall: false, ...(carriedName ? { suggestedDisplayName: carriedName } : {}) };
  }
  if (profile.mode === "guest") {
    return { mode: "guest", userId: null, username: null, displayName: profile.displayName ?? null, freshInstall: false };
  }
  const username = profile.username ?? null;
  return {
    mode: "account",
    userId: currentSession?.user?.id ?? profile.userId ?? null,
    username,
    displayName: profile.displayName ?? null,
    freshInstall: false,
    needsUsername: profile.pendingUsername === true,
    ...(profile.pendingUsername && profile.suggestedDisplayName ? { suggestedDisplayName: profile.suggestedDisplayName } : {}),
  };
}

/** The profile for an account just signed in. Its display name is the account's own. */
async function accountProfile(userId: string, patch: Partial<LocalProfile>): Promise<LocalProfile> {
  carriedName = null;
  const same = readProfile()?.userId === userId;
  return writeProfile({
    ...(same ? {} : { displayName: undefined, displayNamePending: undefined, suggestedDisplayName: undefined }),
    ...patch,
    mode: "account",
    userId,
  });
}

/* ------------------------------------------------------------------ */
/* Display name                                                        */
/* ------------------------------------------------------------------ */

function nameError(message: string): Error {
  // The migration isn't on the server yet: PostgREST can't find the table.
  if (/schema cache|could not find the table|does not exist/i.test(message)) {
    return new Error("Display names aren't set up on ByTune's server yet.");
  }
  return new Error(message);
}

async function fetchDisplayName(userId: string): Promise<string | null> {
  const { data, error } = await supabase().from("display_names").select("name").eq("user_id", userId).maybeSingle();
  if (error) throw nameError(error.message);
  return typeof data?.name === "string" ? data.name : null;
}

async function pushDisplayName(userId: string, name: string): Promise<void> {
  const { error } = await supabase().from("display_names").upsert({ user_id: userId, name });
  if (error) throw nameError(error.message);
}

/** Writes only while the profile is still this account's: an answer after a sign-out mustn't sign it back in. */
async function patchAccount(userId: string, patch: Partial<LocalProfile>): Promise<void> {
  const profile = readProfile();
  if (profile?.mode === "account" && profile.userId === userId) await writeProfile({ ...patch, mode: "account" });
}

/** A new account's name: to the server, or (it can't take it now) kept here and sent at the next sync. */
async function claimDisplayName(userId: string, name: string): Promise<void> {
  let pending = false;
  try {
    await pushDisplayName(userId, name);
  } catch (err) {
    pending = true;
    console.warn("[bytune] display name not saved on the server yet:", err instanceof Error ? err.message : err);
  }
  await patchAccount(userId, { displayName: name, displayNamePending: pending || undefined, suggestedDisplayName: undefined });
}

/** Settings: an account's name goes to the server first (every device and room gets it there); a guest's stays here. */
export async function setDisplayName(raw: string): Promise<SessionInfo> {
  const name = normalizeDisplayName(raw);
  const problem = displayNameProblem(name);
  if (problem) throw new Error(problem);
  const profile = readProfile();
  if (profile?.mode === "guest") {
    await writeProfile({ mode: "guest", displayName: name });
    return sessionInfo();
  }
  const userId = await liveUserId();
  if (profile?.mode !== "account" || !userId) throw new Error("Sign in again to change your display name.");
  await pushDisplayName(userId, name);
  await patchAccount(userId, { displayName: name, displayNamePending: undefined });
  return sessionInfo();
}

/**
 * Puts this computer's copy of the account's name in step with the server's. True when the name
 * shown here changed.
 */
export async function syncDisplayName(): Promise<boolean> {
  const profile = readProfile();
  const userId = await liveUserId();
  if (profile?.mode !== "account" || !userId) return false;
  try {
    if (profile.displayNamePending && profile.displayName) {
      await pushDisplayName(userId, profile.displayName);
      await patchAccount(userId, { displayNamePending: undefined });
      return false;
    }
    const remote = await fetchDisplayName(userId);
    if ((remote ?? undefined) === profile.displayName) return false;
    await patchAccount(userId, { displayName: remote ?? undefined });
    return true;
  } catch (err) {
    console.warn("[bytune] display name sync failed:", err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * The user id that cloud operations may act as: a LIVE verified session whose user matches the local
 * profile marker. The plain sessionInfo() fallback to the stored profile userId is display-only — a
 * stale/expired token must never authorize pushing or pulling another identity's cloud rows.
 */
export function authenticatedUserId(): string | null {
  const session = currentSession;
  if (!session?.user?.id || !session.access_token) return null;
  const expiresAt = typeof session.expires_at === "number" ? session.expires_at * 1000 : 0;
  if (expiresAt && expiresAt <= Date.now()) return null;
  const profile = readProfile();
  if (profile?.mode !== "account") return null;
  return profile.userId === session.user.id ? session.user.id : null;
}

/** authenticatedUserId after letting the client refresh a token that ran out while the window was hidden. */
export async function liveUserId(): Promise<string | null> {
  if (client && currentSession && !authenticatedUserId()) {
    try {
      const { data } = await client.auth.getSession();
      if (data.session) currentSession = data.session;
    } catch {
      /* offline: stays unauthenticated until the next try */
    }
  }
  return authenticatedUserId();
}

/* ------------------------------------------------------------------ */
/* Username + password                                                 */
/* ------------------------------------------------------------------ */

export function validateUsername(username: string): string | null {
  return usernameProblem(username);
}

/** Is the name free? Hits the `profiles` table's UNIQUE backing index. */
export async function usernameAvailable(username: string): Promise<boolean> {
  const clean = normalizeUsername(username);
  const { data, error } = await supabase().from("profiles").select("username").eq("username", clean).maybeSingle();
  if (error) throw new Error(error.message);
  return data == null;
}

/** Availability for renaming / first-time claim by a signed-in user: their own current name is free. */
export async function usernameAvailableToUser(username: string, userId: string | null): Promise<boolean> {
  const clean = normalizeUsername(username);
  const { data, error } = await supabase().from("profiles").select("id").eq("username", clean).maybeSingle();
  if (error) throw new Error(error.message);
  return data == null || (userId != null && data.id === userId);
}

export async function signUp(username: string, password: string, displayName: string): Promise<SessionInfo> {
  const clean = normalizeUsername(username);
  const name = normalizeDisplayName(displayName);
  const problem = usernameProblem(clean) ?? passwordProblem(password) ?? displayNameProblem(name);
  if (problem) throw new Error(problem);
  if (!(await usernameAvailable(clean))) throw new Error("That username is already taken.");

  const { data, error } = await supabase().auth.signUp({ email: syntheticEmail(clean), password });
  if (error) throw new Error(error.message);
  const userId = data.user?.id;
  if (!userId) throw new Error("Sign-up failed — no user returned.");

  // Claim the username; the UNIQUE constraint makes double-claims impossible.
  const { error: pErr } = await supabase().from("profiles").insert({ id: userId, username: clean });
  if (pErr) throw new Error(pErr.message);

  if (!data.session) {
    throw new Error(
      "Account created but email confirmation is enabled in Supabase. Disable 'Confirm email' in Authentication → Sign In / Providers."
    );
  }
  currentSession = data.session;
  await persistSession(data.session);
  const profile = await accountProfile(userId, { username: clean });
  await claimDisplayName(userId, name);
  return { mode: profile.mode, userId, username: clean, displayName: name, freshInstall: false, isNewAccount: true };
}

export async function signIn(username: string, password: string): Promise<SessionInfo> {
  const clean = normalizeUsername(username);
  if (!clean || !password) throw new Error("Enter your username and password.");
  const { data, error } = await supabase().auth.signInWithPassword({ email: syntheticEmail(clean), password });
  if (error) throw new Error("Wrong username or password.");
  currentSession = data.session;
  await persistSession(data.session);
  const userId = data.user.id;
  const profile = await accountProfile(userId, { username: clean });
  return { mode: profile.mode, userId, username: profile.username ?? clean, freshInstall: false, isNewAccount: false };
}

/* ------------------------------------------------------------------ */
/* Google OAuth (PKCE through the default browser)                     */
/* ------------------------------------------------------------------ */

let pendingOAuthResolve: ((info: SessionInfo) => void) | null = null;
let pendingOAuthReject: ((err: Error) => void) | null = null;
let pendingOAuthTimer: ReturnType<typeof setTimeout> | null = null;
/** Valid callbacks that arrived while no flow was waiting (a very fast redirect). */
const earlyOAuthCallbacks: string[] = [];

function clearPendingOAuth(): void {
  pendingOAuthResolve = null;
  pendingOAuthReject = null;
  if (pendingOAuthTimer) {
    clearTimeout(pendingOAuthTimer);
    pendingOAuthTimer = null;
  }
}

export async function signInGoogle(): Promise<SessionInfo> {
  const { data, error } = await supabase().auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: OAUTH_REDIRECT,
      skipBrowserRedirect: true,
      // Never silently reuse the browser's Google session — always let the user choose.
      queryParams: { prompt: "select_account" },
    },
  });
  if (error || !data?.url) throw new Error(error?.message ?? "Could not start Google sign-in.");

  return new Promise<SessionInfo>((resolve, reject) => {
    clearPendingOAuth();
    pendingOAuthResolve = resolve;
    pendingOAuthReject = reject;
    const early = earlyOAuthCallbacks.splice(0).pop();
    if (early) {
      void handleOAuthCallback(early).catch((err) => console.warn("[bytune] oauth callback:", err.message));
      return;
    }
    void backend("app:openExternal", data.url).catch((err) => {
      if (pendingOAuthResolve !== resolve) return;
      clearPendingOAuth();
      reject(err instanceof Error ? err : new Error("Could not open the sign-in browser."));
    });
    // The browser tab may simply be closed — give up after 5 minutes.
    pendingOAuthTimer = setTimeout(() => {
      if (pendingOAuthResolve === resolve) clearPendingOAuth();
      reject(new Error("Google sign-in timed out. Please try again."));
    }, 5 * 60 * 1000);
  });
}

/** Deep-link entry point — index.ts hands over the callback URLs the backend parked. */
export async function handleOAuthCallback(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  const redirect = new URL(OAUTH_REDIRECT);
  // Only the exact registered redirect is accepted. (A custom scheme's "host" reads as its first
  // path segment in some URL parsers, so the host and path are compared together.)
  const where = (u: URL): string => `${u.host}${u.pathname}`.replace(/\/+$/, "").replace(/^\/+/, "");
  if (
    parsed.protocol !== redirect.protocol ||
    where(parsed) !== where(redirect) ||
    parsed.username || parsed.password || parsed.hash ||
    (parsed.searchParams.get("code") ?? "").length > 512
  ) {
    return;
  }
  if (!pendingOAuthResolve) {
    earlyOAuthCallbacks.push(url);
    if (earlyOAuthCallbacks.length > 3) earlyOAuthCallbacks.shift();
    return;
  }
  const resolve = pendingOAuthResolve;
  const reject = pendingOAuthReject;
  clearPendingOAuth();
  const code = parsed.searchParams.get("code");
  if (!code) {
    const desc = parsed.searchParams.get("error_description") ?? "Google sign-in didn't complete.";
    const err = new Error(desc.slice(0, 300));
    reject?.(err);
    throw err;
  }
  try {
    resolve?.(await finishGoogleSignIn(code));
  } catch (err) {
    reject?.(err instanceof Error ? err : new Error("Google sign-in didn't complete."));
    throw err;
  }
}

async function finishGoogleSignIn(code: string): Promise<SessionInfo> {
  const { data, error } = await supabase().auth.exchangeCodeForSession(code);
  if (error) throw new Error(error.message);
  currentSession = data.session;
  await persistSession(data.session);

  const userId = data.user.id;
  // Google users get their Google display name (or email stem) as a default username if the
  // profile row doesn't exist yet — letters/digits only.
  let username = String(data.user.user_metadata?.user_name ?? data.user.user_metadata?.name ?? "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase()
    .slice(0, 20);
  if (username.length < 3) username = `user${userId.slice(0, 8).replace(/[^a-z0-9]/g, "")}`;
  const { data: existing } = await supabase().from("profiles").select("username").eq("id", userId).maybeSingle();
  if (!existing) {
    let finalName = username;
    for (let i = 0; i < 5 && !(await usernameAvailable(finalName)); i++) {
      finalName = `${username}${Math.random().toString(36).replace(/[^a-z0-9]/g, "").slice(2, 6)}`;
    }
    const { error: pErr } = await supabase().from("profiles").insert({ id: userId, username: finalName });
    if (pErr) console.warn("[bytune] profile insert failed:", pErr.message);
    username = finalName;
    const meta = data.user.user_metadata ?? {};
    const fromGoogle = normalizeDisplayName([...normalizeDisplayName(String(meta.full_name ?? meta.name ?? ""))].slice(0, DISPLAY_NAME_MAX).join(""));
    const suggested = carriedName ?? (fromGoogle || undefined);
    const profile = await accountProfile(userId, { username, pendingUsername: true, suggestedDisplayName: suggested });
    return { mode: profile.mode, userId, username, freshInstall: false, needsUsername: true, isNewAccount: true };
  }
  username = existing.username;
  const profile = await accountProfile(userId, { username });
  return { mode: profile.mode, userId, username, freshInstall: false, isNewAccount: false };
}

/** One-time username choice for Google sign-ups (Settings renames through here too). */
export async function setUsername(username: string, displayName?: string): Promise<SessionInfo> {
  const clean = normalizeUsername(username);
  const name = displayName === undefined ? null : normalizeDisplayName(displayName);
  const problem = usernameProblem(clean) ?? (name === null ? null : displayNameProblem(name));
  if (problem) throw new Error(problem);
  const profile = readProfile();
  const userId = sessionInfo().userId ?? profile?.userId ?? null;
  if (profile?.mode !== "account" || !userId) throw new Error("Sign in with Google first.");
  if (!(await usernameAvailableToUser(clean, userId))) throw new Error("That username is already in use.");
  const { error } = await supabase().from("profiles").update({ username: clean }).eq("id", userId);
  if (error) throw new Error(error.message);
  const next = await writeProfile({ mode: "account", username: clean, pendingUsername: false });
  if (name !== null) await claimDisplayName(userId, name);
  return { mode: next.mode, userId, username: clean, freshInstall: false };
}

/** Offline-safe escape from the pick-username screen: keep the auto name. */
export async function skipUsernameClaim(displayName?: string): Promise<SessionInfo> {
  const profile = readProfile();
  if (profile?.mode === "account" && profile.pendingUsername) {
    await writeProfile({ mode: "account", pendingUsername: false, suggestedDisplayName: undefined });
    const name = normalizeDisplayName(displayName ?? "");
    if (profile.userId && !displayNameProblem(name)) await claimDisplayName(profile.userId, name);
  }
  return sessionInfo();
}

/* ------------------------------------------------------------------ */
/* Guest + sign-out                                                    */
/* ------------------------------------------------------------------ */

/** A guest's display name is optional: given, it's checked; left out, a guest keeps the one they had. */
export async function continueAsGuest(displayName?: string): Promise<SessionInfo> {
  const given = normalizeDisplayName(displayName ?? "");
  const problem = given ? displayNameProblem(given) : null;
  if (problem) throw new Error(problem);
  // An account session must not survive a switch to guest.
  currentSession = null;
  await persistSession(null);
  const was = readProfile();
  const kept = was?.mode === "guest" ? was.displayName : (carriedName ?? undefined);
  const profile = await writeProfile({ mode: "guest", displayName: given || kept, displayNamePending: undefined, suggestedDisplayName: undefined });
  carriedName = null;
  return { mode: profile.mode, userId: null, username: null, displayName: profile.displayName ?? null, freshInstall: false };
}

/** Wipe the guest marker so onboarding shows (used by "Sign in instead"). The guest's name is offered at sign-up. */
export async function clearGuestProfile(): Promise<void> {
  const profile = readProfile();
  if (profile?.mode === "guest") {
    carriedName = profile.displayName ?? null;
    await saveProfile(null);
  }
}

export async function signOut(): Promise<SessionInfo> {
  try {
    await supabase().auth.signOut();
  } catch {
    /* offline — clear locally anyway */
  }
  currentSession = null;
  await persistSession(null);
  // Signing out returns to onboarding; data stays on disk.
  await saveProfile(null);
  return { mode: null, userId: null, username: null, freshInstall: false };
}
