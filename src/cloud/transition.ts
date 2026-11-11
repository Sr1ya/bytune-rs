/**
 * Whose data is on this computer — a port of ByTune's electron/data-transition.ts.
 *
 * Every account's personal stores (and the guest's) are kept apart: switching owner archives the
 * current owner's stores under `owner-<sha256(identity)>-<store>` and brings the next owner's
 * archived copy back, so a guest who signs in and later continues as a guest finds their own library
 * again, and account A's data never shows under account B. A guest creating an account takes their
 * data along instead. Device-owned parts (downloads, this machine's settings) stay where they are.
 */
import { SYNCED_STORES } from "../lib/config";
import { readStore, writeStore } from "./backend";
import { DEVICE_SETTINGS_FIELDS } from "./syncMerge";

// The listening journal and Home engagement are personal but device-only: they switch with the account, never sync.
const accountStores = new Set<string>([...SYNCED_STORES, "player", "artist-meta-cache", "listen-journal", "home-engagement"]);
let owner = "guest";

async function archive(identity: string, name: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `owner-${hex}-${name}`;
}

export async function initializeOwner(): Promise<void> {
  const saved = (await readStore("data-owner")) as { owner?: string } | null;
  const profile = (await readStore("profile")) as { mode?: string; userId?: string } | null;
  const meta = (await readStore("sync-meta")) as { lastUserId?: string } | null;
  owner = saved?.owner ?? (profile?.mode === "account" ? profile.userId : undefined) ?? meta?.lastUserId ?? "guest";
}

export function currentOwner(): string {
  return owner;
}

type Envelope = { state?: Record<string, unknown>; version?: number } | null;

export async function changeOwner(next: string, migrateGuest: boolean): Promise<void> {
  if (next === owner) return;
  const previous = owner;
  if (!(previous === "guest" && migrateGuest)) {
    for (const name of accountStores) {
      const local = (await readStore(name)) as Envelope;
      await writeStore(await archive(previous, name), local);
      const saved = (await readStore(await archive(next, name))) as Envelope;
      let value: unknown = saved;
      if (name === "library") value = { state: { ...(saved?.state ?? {}), downloads: local?.state?.downloads ?? {} }, version: 1 };
      if (name === "settings") {
        const device = Object.fromEntries(
          DEVICE_SETTINGS_FIELDS.filter((key) => local?.state?.[key] !== undefined).map((key) => [key, local!.state![key]])
        );
        value = { state: { ...(saved?.state ?? {}), ...device }, version: saved?.version ?? 0 };
      }
      await writeStore(name, value);
    }
  }
  owner = next;
  await writeStore("data-owner", { owner });
}

/** "Reset app data" starts over as nobody's. */
export function resetOwner(): void {
  owner = "guest";
}
