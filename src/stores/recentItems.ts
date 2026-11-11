/**
 * What you opened from search lately — songs, artists, albums, playlists —
 * with their art, one click from the empty search page. Kept on this device
 * only (it never syncs), newest first.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { storage } from "../lib/persist";
import type { Track } from "../types";

export type RecentItem =
  | { kind: "song"; id: string; title: string; subtitle: string; thumb: string; track: Track }
  | { kind: "artist" | "album" | "playlist"; id: string; title: string; subtitle: string; thumb: string };

const KEEP = 12;
const same = (a: RecentItem, kind: RecentItem["kind"], id: string): boolean => a.kind === kind && a.id === id;

interface RecentItemsState {
  items: RecentItem[];
  add(item: RecentItem): void;
  remove(kind: RecentItem["kind"], id: string): void;
  clear(): void;
}

export const useRecentItems = create<RecentItemsState>()(
  persist(
    (set, get) => ({
      items: [],
      add: (item) => set({ items: [item, ...get().items.filter((x) => !same(x, item.kind, item.id))].slice(0, KEEP) }),
      remove: (kind, id) => set({ items: get().items.filter((x) => !same(x, kind, id)) }),
      clear: () => set({ items: [] }),
    }),
    { name: "recent-items", storage: createJSONStorage(() => storage) },
  ),
);
