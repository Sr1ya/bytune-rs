/**
 * Explore's card art: a mood or genre page's first playlist covers (and the
 * podcasts page's first shows), kept on this device for a week. A category
 * page runs 0.2–3 MB, so a card asks only once it scrolls into view, three
 * at a time, and not again while its covers are fresh.
 */
import { useCallback, useEffect, useRef, useState, type RefObject, type SyntheticEvent } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { artworkUrlOk } from "./artwork";
import { storage } from "./persist";

const FRESH_MS = 7 * 24 * 3_600_000;
const KEEP = 200;
const AT_ONCE = 3;

interface CoverEntry {
  covers: string[];
  at: number;
}

interface CoversState {
  byKey: Record<string, CoverEntry>;
  put(key: string, covers: string[]): void;
  drop(key: string): void;
}

export const useExploreCovers = create<CoversState>()(
  persist(
    (set, get) => ({
      byKey: {},
      put(key, covers) {
        const byKey = { ...get().byKey, [key]: { covers, at: Date.now() } };
        const keys = Object.keys(byKey);
        if (keys.length > KEEP) {
          keys
            .sort((a, b) => byKey[a].at - byKey[b].at)
            .slice(0, keys.length - KEEP)
            .forEach((k) => delete byKey[k]);
        }
        set({ byKey });
      },
      drop(key) {
        const byKey = { ...get().byKey };
        delete byKey[key];
        set({ byKey });
      },
    }),
    { name: "explore-covers", storage: createJSONStorage(() => storage) }
  )
);

let running = 0;
const waiting: Array<() => void> = [];
const asking = new Set<string>();
/** Cards whose saved covers stopped loading this session: asked again once, never in a loop. */
const reasked = new Set<string>();

function queue(job: () => Promise<void>): void {
  const start = (): void => {
    running++;
    void job().finally(() => {
      running--;
      waiting.shift()?.();
    });
  };
  if (running < AT_ONCE) start();
  else waiting.push(start);
}

/**
 * The covers for `key`, fetched by `load` once the element behind `ref`
 * comes into view (and again once they're a week old). [] until then, and
 * when there were none or the page couldn't be had: it's asked next visit.
 * An empty `key` never asks. `onError` goes on each cover's <img>: a saved
 * link can die before its week is up (YouTube's signed ones,
 * i.ytimg.com/pl_c/…?sqp=…&rs=…, stop loading within hours), so a cover that
 * won't load hides, and the card's covers are dropped and asked again.
 */
export function useCovers<T extends Element>(
  key: string,
  load: () => Promise<string[]>
): { ref: RefObject<T>; covers: string[]; onError: (e: SyntheticEvent<HTMLImageElement>) => void } {
  const ref = useRef<T>(null);
  const entry = useExploreCovers((s) => (key ? s.byKey[key] : undefined));
  const fresh = !!entry && Date.now() - entry.at < FRESH_MS;
  // The saved covers land from disk a moment after launch; asking before
  // that would fetch every card once more per start.
  const [hydrated, setHydrated] = useState(() => useExploreCovers.persist.hasHydrated());
  useEffect(() => (hydrated ? undefined : useExploreCovers.persist.onFinishHydration(() => setHydrated(true))), [hydrated]);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const el = ref.current;
    if (!key || fresh || !hydrated || !el) return;
    const io = new IntersectionObserver((seen) => {
      if (!seen.some((e) => e.isIntersecting) || asking.has(key)) return;
      io.disconnect();
      asking.add(key);
      queue(async () => {
        try {
          const covers = (await loadRef.current()).filter(artworkUrlOk);
          if (covers.length) useExploreCovers.getState().put(key, covers);
        } catch {
          /* asked again next visit */
        } finally {
          asking.delete(key);
        }
      });
    });
    io.observe(el);
    return () => io.disconnect();
  }, [key, fresh, hydrated]);

  const onError = useCallback(
    (e: SyntheticEvent<HTMLImageElement>) => {
      e.currentTarget.style.visibility = "hidden";
      if (!key || reasked.has(key)) return;
      reasked.add(key);
      // No saved entry → not fresh → the observer above asks again while the card is in view.
      useExploreCovers.getState().drop(key);
    },
    [key]
  );

  return { ref, covers: entry?.covers ?? [], onError };
}
