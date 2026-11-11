/** Recent search queries (persisted) — powers the empty search state. */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { storage } from "../lib/persist";
import { recordDeletionChanges, searchKey } from "../lib/deletion-sync";
import type { DeletionChange, DeletionSync } from "../lib/deletion-sync";

interface RecentsState {
  searches: string[];
  deletionSync?: DeletionSync;
  pushSearch(q: string): void;
  removeSearch(q: string): void;
  clearSearches(): void;
}

const MAX = 8;
type SearchAction = { kind: "add" | "delete" | "clear"; query?: string };
let hydrationSearches: SearchAction[] | null = null;

function applySearch(state: RecentsState, action: SearchAction): Partial<RecentsState> {
  const query = action.query ?? "";
  const rest = state.searches.filter((s) => searchKey(s) !== searchKey(query));
  const searches = action.kind === "clear" ? [] : action.kind === "add" ? [query, ...rest].slice(0, MAX) : rest;
  const change: DeletionChange = { kind: action.kind, group: "searches", id: query };
  return { searches, deletionSync: recordDeletionChanges(state, { searches }, [change]) };
}

export const useRecents = create<RecentsState>()(
  persist(
    (set, get) => ({
      searches: [],
      pushSearch(q) {
        const query = q.trim();
        if (!query) return;
        const action: SearchAction = { kind: "add", query };
        hydrationSearches?.push(action);
        set(applySearch(get(), action));
      },
      removeSearch(q) {
        const query = q.trim();
        if (!query) return;
        const action: SearchAction = { kind: "delete", query };
        hydrationSearches?.push(action);
        set(applySearch(get(), action));
      },
      clearSearches() {
        const action: SearchAction = { kind: "clear" };
        hydrationSearches?.push(action);
        set(applySearch(get(), action));
      },
    }),
    {
      name: "recent-searches",
      storage: createJSONStorage(() => storage),
      onRehydrateStorage: () => {
        const buffer = hydrationSearches ?? [];
        hydrationSearches = buffer;
        return (state) => {
          if (hydrationSearches !== buffer) return;
          hydrationSearches = null;
          if (!state || buffer.length === 0) return;
          // Replay actual buffered intents, including removes, against restored
          // metadata. Do not infer fresh adds from the unchanged snapshot.
          let replay = state;
          for (const action of buffer) replay = { ...replay, ...applySearch(replay, action) };
          useRecents.setState({ searches: replay.searches, deletionSync: replay.deletionSync });
        };
      },
    }
  )
);
