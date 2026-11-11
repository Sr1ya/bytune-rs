/**
 * Accounts, cloud sync and Rooms — the main window's side of what ByTune's Electron main process did
 * in main.ts. The bridge (shared/api.ts) sends every `auth:` / `sync:` / `room:` call here instead of
 * to the Rust backend; the answers and the events (`auth:changed`, `sync:restored`, `room:state`) are
 * the ones ByTune's main gave.
 *
 * Signing in, out, or switching to guest ends with a reload, as in ByTune: the page's stores hydrate
 * again from the new owner's files.
 */
import { displayNameProblem, normalizeDisplayName } from "../lib/account-validators";
import { roomCodeIn } from "../lib/roomSync";
import { flushPendingWrites } from "../lib/persist";
import type { RoomChange } from "../types";
import * as auth from "./auth";
import { backend, hear, tell } from "./backend";
import { freezePageWrites, pageWritesFrozen, serializeData } from "./queue";
import * as rooms from "./rooms";
import * as sync from "./sync";
import { changeOwner, currentOwner, initializeOwner } from "./transition";

/** Local state is loaded (owner, profile, sync bookkeeping): calls and writes may proceed. */
let local: Promise<void> | null = null;

function boot(): Promise<void> {
  local ??= (async () => {
    await initializeOwner();
    await auth.loadProfile();
    await sync.initSync();
  })().catch((err) => console.warn("[bytune] cloud boot:", err));
  return local;
}

/** Called once by the main window at start. */
export function startCloud(): void {
  void boot().then(async () => {
    await auth.initAuth();
    // Replay's history is written by the backend; its sync is told here.
    hear<string>("store:written", (name) => {
      if (name === "listening-history") sync.noteHistoryWritten();
    });
    // Google sign-in coming back (bytune://oauth/callback), parked by the backend until now.
    const takeCallbacks = (): void => {
      void backend<string[]>("auth:takeOAuthCallbacks")
        .then((urls) => {
          for (const url of urls ?? []) {
            void auth.handleOAuthCallback(url).catch((err) => console.warn("[bytune] oauth callback:", err.message));
          }
        })
        .catch(() => undefined);
    };
    hear("auth:oauthCallback", takeCallbacks);
    takeCallbacks();
    // A signed-in session restored: back up now and pull anything newer.
    if (auth.sessionInfo().mode === "account") void sync.syncNow().catch(() => undefined);
    // The account's display name: another device may have changed it, or one saved here goes up now.
    void auth.syncDisplayName().then((changed) => {
      if (changed) tell("auth:changed", auth.sessionInfo());
    });
    // A room ByTune quit or crashed in is left; the page puts the listener's queue back.
    void rooms.recover().catch(() => undefined);
    // Back from sleep (the clock jumped): measure the room's clock again and catch up.
    let last = Date.now();
    setInterval(() => {
      const now = Date.now();
      if (now - last > 60_000) rooms.resync();
      last = now;
    }, 15_000);
  });
}

/** Set once quitting: the last writes go straight to disk instead of waiting behind a network sync. */
let quitting = false;

/** Every page store write comes through here: in the data queue, and noted for cloud sync. */
export function pageWrite(name: string, data: unknown): Promise<void> {
  if (quitting) return pageWritesFrozen() ? Promise.resolve() : backend<void>("data:write", name, data);
  return serializeData(async () => {
    await boot();
    if (pageWritesFrozen()) return;
    await backend("data:write", name, data);
    sync.noteLocalWrite(name);
  });
}

/** Quitting: say "left" to a room, start the last push, and record unsynced edits for the next start. */
export async function quitCloud(): Promise<void> {
  quitting = true;
  void rooms.leaveRoom().catch(() => undefined);
  void sync.flushPending();
  await sync.flushMeta();
}

/* ---------------- account switches ---------------- */

function reloadSoon(): void {
  setTimeout(() => window.location.reload(), 50);
}

/**
 * Sign in / sign up / Google sign-in share this path. Guest data migrates ONLY into an account being
 * created here (`isNewAccount`) — signing into an account that already exists brings that account's
 * own cloud copy forward. `changeOwner` archives whatever the guest did under the guest slot, so a
 * later "continue as guest" finds it again.
 */
async function signIn(authenticate: () => Promise<auth.SessionInfo>): Promise<auth.SessionInfo> {
  await flushPendingWrites();
  return serializeData(async () => {
    // A room belongs to the account in it: leave while that account can still say so.
    await rooms.leaveRoom().catch(() => undefined);
    const previous = currentOwner();
    const info = await authenticate();
    freezePageWrites();
    try {
      const migrateGuest = previous === "guest" && info.isNewAccount === true;
      await changeOwner(info.userId ?? "guest", migrateGuest);
      if (previous !== info.userId) await sync.resetSyncState(info.userId ?? undefined);
      // Spotify is kept per owner; a guest's goes along with their library.
      if (migrateGuest && info.userId) await backend("spotify:moveGuest", info.userId).catch(() => undefined);
      await auth.syncDisplayName();
      await sync.syncNowExclusive().catch((err) => {
        console.error("[bytune] login sync failed (account data not pulled):", err instanceof Error ? err.message : err);
        sync.noteSyncFailure(err);
      });
    } finally {
      reloadSoon();
    }
    return info;
  });
}

async function continueGuest(displayName: unknown): Promise<auth.SessionInfo> {
  // Checked before anything switches: a name that can't be kept stops the whole step.
  const name = normalizeDisplayName(typeof displayName === "string" ? displayName : "");
  const problem = name ? displayNameProblem(name) : null;
  if (problem) throw new Error(problem);
  await flushPendingWrites();
  return serializeData(async () => {
    freezePageWrites();
    try {
      await changeOwner("guest", false);
      await sync.resetSyncState();
      return await auth.continueAsGuest(name || undefined);
    } finally {
      reloadSoon();
    }
  });
}

async function signOut(): Promise<auth.SessionInfo> {
  await flushPendingWrites();
  return serializeData(async () => {
    await sync.syncNowExclusive().catch((err) => {
      console.error("[bytune] logout backup failed:", err instanceof Error ? err.message : err);
      sync.noteSyncFailure(err);
    });
    await rooms.leaveRoom().catch(() => undefined);
    freezePageWrites();
    try {
      const info = await auth.signOut();
      await changeOwner("guest", false);
      await sync.resetSyncState();
      return info;
    } finally {
      reloadSoon();
    }
  });
}

/* ---------------- the bridge's calls ---------------- */

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const uuid = (v: unknown): string => {
  if (typeof v !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw new Error("Not a member");
  return v;
};

function roomChange(change: unknown): RoomChange {
  const c = change as Record<string, unknown> | null;
  const ok =
    !!c && typeof c === "object" &&
    typeof c.baseSeq === "number" && Number.isSafeInteger(c.baseSeq) && c.baseSeq >= 0 &&
    (c.track === null || (typeof c.track === "object" && !Array.isArray(c.track))) &&
    typeof c.positionMs === "number" && Number.isFinite(c.positionMs) && c.positionMs >= 0 && c.positionMs <= 86_400_000 &&
    typeof c.playing === "boolean" && typeof c.lead === "boolean" &&
    Array.isArray(c.queue) && c.queue.length <= 200 &&
    typeof c.note === "string" && c.note.length <= 200;
  if (!ok) throw new Error("Not a room change");
  return c as unknown as RoomChange;
}

/** Channels that stay with the Rust backend even though they're named like the cloud's. */
export const BACKEND_CHANNELS = new Set(["room:takeInvite", "auth:takeOAuthCallbacks", "auth:loadSession", "auth:saveSession"]);

export async function handle(channel: string, args: unknown[]): Promise<unknown> {
  await boot();
  const [a, b, c] = args;
  switch (channel) {
    /* accounts */
    case "auth:getSession":
      return auth.sessionInfo();
    case "auth:signUp":
      return signIn(() => auth.signUp(String(a ?? ""), String(b ?? ""), text(c) ?? ""));
    case "auth:signIn":
      return signIn(() => auth.signIn(String(a ?? ""), String(b ?? "")));
    case "auth:signInGoogle":
      return signIn(() => auth.signInGoogle());
    case "auth:continueGuest":
      return continueGuest(a);
    case "auth:clearGuestProfile":
      return auth.clearGuestProfile();
    case "auth:usernameAvailable": {
      const problem = auth.validateUsername(String(a ?? ""));
      if (problem) return { available: false, reason: problem };
      try {
        return { available: await auth.usernameAvailableToUser(String(a), auth.sessionInfo().userId) };
      } catch (err) {
        // Lookup failure is NOT "taken" — offline must not brick the form.
        return { available: null, reason: err instanceof Error ? err.message : "Network error" };
      }
    }
    case "auth:setUsername":
      return auth.setUsername(String(a ?? ""), text(b));
    case "auth:skipUsername":
      return auth.skipUsernameClaim(text(a));
    case "auth:setDisplayName":
      return auth.setDisplayName(text(a) ?? "");
    case "auth:signOut":
      return signOut();

    /* cloud backup */
    case "sync:status":
      return sync.syncStatus();
    case "sync:now":
      return sync.syncNow();
    case "sync:backupNow":
      return sync.backupNow();
    case "sync:restoreNow":
      return sync.restoreNow();

    /* Rooms */
    case "room:current":
      return rooms.roomView();
    case "room:create":
      return rooms.createRoom();
    case "room:join": {
      const code = typeof a === "string" && a.length <= 100 ? roomCodeIn(a) : null;
      if (!code) throw new Error("That isn't a room code.");
      return rooms.joinRoom(code);
    }
    case "room:leave":
      return rooms.leaveRoom();
    case "room:update":
      return rooms.updateRoom(roomChange(a));
    case "room:hostOnly":
      if (typeof a !== "boolean") throw new Error("Not a setting");
      return rooms.setHostOnly(a);
    case "room:makeHost":
      return rooms.makeHost(uuid(a));
    case "room:remove":
      return rooms.removeMember(uuid(a));
    case "room:stash": {
      const s = a as { queue?: unknown } | null;
      if (!s || typeof s !== "object" || !Array.isArray(s.queue) || s.queue.length > 5000 || JSON.stringify(s).length > 5_000_000) {
        throw new Error("Not a queue");
      }
      return rooms.stash(s);
    }
    case "room:unstash":
      return rooms.unstash();
    default:
      throw new Error(`Unknown channel ${channel}`);
  }
}
