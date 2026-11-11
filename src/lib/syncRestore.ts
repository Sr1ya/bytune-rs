/**
 * Cloud-restore → live-store bridge. The sync engine writes restored JSON
 * files to disk from the main process, but the renderer's zustand stores
 * hydrated once at boot — without this bridge the UI keeps showing empty
 * state over restored data (and a later write would clobber the restore).
 * On "sync:restored" we rehydrate the matching stores in place.
 */
import { useLibrary } from "../stores/library";
import { useSettings } from "../stores/settings";
import { useRecents } from "../stores/recents";
import { useListening } from "../stores/listening";
import { invalidateStatsCache } from "./recs/profile";
import { hasBridge } from "./bridge";

const STORE_PERSIST: Record<string, { rehydrate: () => void | Promise<void> }> = {
  library: useLibrary.persist,
  settings: useSettings.persist,
  "recent-searches": useRecents.persist,
  "listening-signals": useListening.persist,
};

let appliedSeq = 0;

function apply(stores: string[], seq: number): void {
  if (seq <= appliedSeq) return;
  appliedSeq = seq;
  // listening-history is a main-process store (no renderer hydration); the
  // Replay summary read from it just needs its cache dropped.
  if (stores.includes("listening-history")) invalidateStatsCache();
  for (const name of stores) {
    void STORE_PERSIST[name]?.rehydrate();
  }
}

/** Subscribe once from App — returns an unsubscribe fn. */
export function watchSyncRestores(): () => void {
  if (!hasBridge()) return () => undefined;
  const off = window.bytune!.onSyncRestored((info) => apply(info.stores ?? [], info.seq ?? 0));
  // Boot race: the session-restore sync at startup can finish just before
  // or after this mounts — re-check the status shortly after boot.
  const t = setTimeout(() => {
    void window.bytune
      ?.syncStatus()
      .then((st) => {
        const s = st as { restoreSeq?: number; restoredStores?: string[] } | undefined;
        if (s?.restoreSeq && s.restoreSeq > appliedSeq) apply(s.restoredStores ?? [], s.restoreSeq);
      })
      .catch(() => undefined);
  }, 4000);
  return () => {
    off();
    clearTimeout(t);
  };
}
