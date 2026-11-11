/**
 * The cloud module's line to the Rust backend and to the rest of the page.
 *
 * ByTune ran accounts, cloud sync and Rooms in Electron's main process. Here they run in the main
 * window (src/cloud/), and these helpers stand in for what main had at hand: store files
 * (`cloud:read` / `cloud:write`, which reach a few bookkeeping stores the page itself may not), the
 * sealed session (the OS keychain), pre-merge backups, and messages to the page (`auth:changed`,
 * `sync:restored`, `room:state`), which go out as ordinary app events so the bridge's listeners in
 * shared/api.ts hear them as before.
 */
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";

export async function backend<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await invoke("ipc", { channel, args })) as T;
  } catch (err) {
    throw new Error(typeof err === "string" ? err : err instanceof Error ? err.message : String(err));
  }
}

export const readStore = (name: string): Promise<unknown> => backend("cloud:read", name);
export const writeStore = (name: string, data: unknown): Promise<void> => backend("cloud:write", name, data ?? null);
export const backupStore = (name: string, data: unknown): Promise<void> =>
  backend<void>("cloud:backup", name, data ?? null).catch((err) => console.warn("[bytune] pre-merge backup failed:", err));

/** A message to the page, as main's webContents.send was. */
export function tell(event: string, payload?: unknown): void {
  void emit(event, payload ?? null).catch(() => undefined);
}

export function hear<T>(event: string, cb: (payload: T) => void): () => void {
  let off: (() => void) | null = null;
  let dead = false;
  void listen<T>(event, (e) => cb(e.payload)).then((u) => {
    if (dead) u();
    else off = u;
  });
  return () => {
    dead = true;
    off?.();
  };
}

export const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
