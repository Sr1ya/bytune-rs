/** Zustand storage adapter: JSON files via the desktop bridge, localStorage fallback. */
import type { PersistStorage, StateStorage, StorageValue } from "zustand/middleware";

export const storage: StateStorage = {
  getItem: async (name) => {
    const b = typeof window !== "undefined" ? window.bytune : undefined;
    if (b) {
      try {
        const v = await b.readData(name);
        return v == null ? null : JSON.stringify(v);
      } catch {
        /* fall through to localStorage */
      }
    }
    try {
      return localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: async (name, value) => {
    const b = typeof window !== "undefined" ? window.bytune : undefined;
    if (b) {
      try {
        await b.writeData(name, JSON.parse(value));
        return;
      } catch {
        /* fall through to localStorage */
      }
    }
    try {
      localStorage.setItem(name, value);
    } catch {
      /* ignore */
    }
  },
  removeItem: async (name) => {
    const b = typeof window !== "undefined" ? window.bytune : undefined;
    if (b) {
      try {
        await b.writeData(name, null);
        return;
      } catch {
        /* fall through */
      }
    }
    try {
      localStorage.removeItem(name);
    } catch {
      /* ignore */
    }
  },
};

/**
 * Write-coalescing storage for high-frequency stores (player, library). The
 * audio engine updates `position` on every `timeupdate` (~4Hz), download
 * progress patches the library several times a second, and zustand persist
 * hands over the state on every change, even to fields a store doesn't save.
 * This adapter keeps the newest value as an object (no JSON work per change;
 * it crosses IPC by structured clone), drops a value whose saved fields are
 * unchanged, and writes a store at most every 2s — every 10s when only the
 * player's `position` moved. A change lands at once when the store's last
 * write is older than that; otherwise when it falls due, so bursty user
 * actions after an idle stretch still persist immediately.
 *
 * Pending values flush on pagehide/beforeunload, which fire when the window
 * closes or reloads; main's before-quit then waits for the writes it has
 * received. A crash or a killed process loses what was still pending: at most
 * the last 2s of changes and the last 10s of playing position.
 */
let flushAllPending: () => Promise<void> = async () => undefined;

/** Writes every coalesced store now and resolves once the backend has them (the app is quitting). */
export function flushPendingWrites(): Promise<void> {
  return flushAllPending();
}

const COALESCED_WRITE_MS = 2_000;
const POSITION_WRITE_MS = 10_000;

type Value = StorageValue<Record<string, unknown>>;

// Shared by stores of different shapes, hence `any`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const coalescedStorage: PersistStorage<any> = (() => {
  const pending = new Map<string, Value>();
  const timers = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();
  const lastWriteAt = new Map<string, number>();
  /** What each store last wrote (or read at boot), to spot unchanged and position-only values. */
  const written = new Map<string, Value>();
  /** Writes sent but not yet acknowledged — what quitting must wait for. */
  const inFlight = new Set<Promise<void>>();
  const bridge = () => (typeof window !== "undefined" ? window.bytune : undefined);
  /** Same version and saved fields, but for `except`. Stores replace what they save and never edit
      it in place (zustand relies on that too), so the same reference is the same data. */
  const same = (a: Value, b: Value, except?: string): boolean =>
    a.version === b.version && Object.keys(a.state).every((k) => k === except || a.state[k] === b.state[k]);

  const write = async (name: string, value: Value | null): Promise<void> => {
    const b = bridge();
    if (b) {
      try {
        await b.writeData(name, value);
        return;
      } catch {
        /* fall through to localStorage */
      }
    }
    try {
      if (value === null) localStorage.removeItem(name);
      else localStorage.setItem(name, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  };

  const flush = (name: string): void => {
    const t = timers.get(name);
    if (t) {
      clearTimeout(t.timer);
      timers.delete(name);
    }
    const value = pending.get(name);
    if (value === undefined) return;
    pending.delete(name);
    lastWriteAt.set(name, Date.now());
    written.set(name, value);
    // A store without partialize carries its actions, which can't cross IPC.
    const state = Object.fromEntries(Object.entries(value.state).filter(([, v]) => typeof v !== "function"));
    const p = write(name, { ...value, state });
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
  };

  const flushAll = (): void => {
    for (const name of [...pending.keys()]) flush(name);
  };
  flushAllPending = async () => {
    flushAll();
    await Promise.allSettled([...inFlight]);
  };
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", flushAll);
    window.addEventListener("beforeunload", flushAll);
  }

  return {
    getItem: async (name) => {
      let value: Value | null | undefined;
      const b = bridge();
      if (b) {
        try {
          value = ((await b.readData(name)) as Value | null | undefined) ?? null;
        } catch {
          /* fall through to localStorage */
        }
      }
      if (value === undefined) {
        try {
          const raw = localStorage.getItem(name);
          value = raw == null ? null : (JSON.parse(raw) as Value);
        } catch {
          value = null;
        }
      }
      if (value?.state) {
        // As if just written: hydrating what's on disk is no change, and boot's own updates (a song
        // loading, its resume seek landing) coalesce with what follows instead of writing at once.
        written.set(name, value);
        lastWriteAt.set(name, Date.now());
      }
      return value;
    },
    setItem: (name, value) => {
      const prev = written.get(name);
      const latest = pending.get(name) ?? prev;
      if (latest && same(value, latest)) return;
      pending.set(name, value);
      const slow = !!prev && same(value, prev, "position");
      const now = Date.now();
      const due = (lastWriteAt.get(name) ?? 0) + (slow ? POSITION_WRITE_MS : COALESCED_WRITE_MS);
      if (due <= now) flush(name);
      else {
        // Keep the earliest due time: a real change pulls a pending position-only write forward.
        const t = timers.get(name);
        if (!t || t.at > due) {
          if (t) clearTimeout(t.timer);
          timers.set(name, { at: due, timer: setTimeout(() => flush(name), due - now) });
        }
      }
    },
    removeItem: (name) => {
      // A removal must not be resurrected by a pending write.
      pending.delete(name);
      written.delete(name);
      const t = timers.get(name);
      if (t) {
        clearTimeout(t.timer);
        timers.delete(name);
      }
      return write(name, null);
    },
  };
})();
