/** Player state — pure data; playback side effects live in lib/audio.ts. */
import { create } from "zustand";
import { persist } from "zustand/middleware";
// Coalescing storage: the engine bumps `position` ~4Hz and persist writes on
// every change — raw writes would hit disk/IPC several times a second.
import { coalescedStorage } from "../lib/persist";
import { hash32, seededShuffle } from "../lib/recs/seeded";
import type { Track } from "../types";
import { useSettings } from "./settings";
import { inRoom } from "./room";

export type RepeatMode = "off" | "all" | "one";

/** Played songs kept ahead of the current one: AutoPlay never ends, so the
    queue would otherwise grow without bound (and is persisted every 2s). */
const HISTORY_KEEP = 100;

/** A bare YouTube video id — the only kind of track YouTube Music has a radio for. */
export function isRadioSeed(id: string | undefined): boolean {
  return !!id && /^[A-Za-z0-9_-]{11}$/.test(id);
}

/**
 * How many upcoming queue entries are AutoPlay suggestions. They are always
 * the queue's tail, after the listener's own songs; the stored count is
 * clamped here because the index can move into the tail (the crossfade writes
 * it directly), and a song that is playing is no longer upcoming.
 */
export function autoplayTail(s: { queue: Track[]; index: number; autoplayCount: number }): number {
  return Math.max(0, Math.min(s.autoplayCount, s.queue.length - s.index - 1));
}

/** The song on screen: the one a blend has crossed over to, else the one playing. */
export function shownTrack(s: { blendInto: Track | null; queue: Track[]; index: number }): Track | null {
  return s.blendInto ?? s.queue[s.index] ?? null;
}

type PlayOrder = { queue: Track[]; index: number; repeat: RepeatMode; shuffle: boolean };

/** Where the queue moves on to: the next entry, or the top of another pass (reordered when shuffled). */
function advance(s: PlayOrder): { queue: Track[]; index: number } {
  if (s.index + 1 < s.queue.length) return { queue: s.queue, index: s.index + 1 };
  return { queue: s.shuffle ? nextPass(s.queue) : s.queue, index: 0 };
}

/**
 * The song a blend may lead into: the one next(false) lands on — the next
 * entry, or at a repeat-all wrap the next pass's first song (nextPass's when
 * shuffled). Null under repeat-one, at the end without repeat-all, and on a
 * one-song queue.
 */
export function upNext(s: PlayOrder): Track | null {
  if (s.repeat === "one") return null;
  if (s.index + 1 >= s.queue.length && (s.repeat !== "all" || s.queue.length < 2)) return null;
  const to = advance(s);
  return to.queue[to.index];
}

/** The queue ran out: AutoPlay continues it when it is on, nothing repeats,
    and the newest song has a YouTube radio (local files have none). A room's
    queue is the room's: AutoPlay sits out there. */
function autoplayContinues(queue: Track[], repeat: RepeatMode): boolean {
  const last = queue[queue.length - 1];
  return useSettings.getState().autoplay && !inRoom() && repeat === "off" && isRadioSeed(last?.id) && !last?.episode;
}

const randomSeed = (): number => (Math.random() * 2 ** 32) >>> 0;

type QueueShape = { queue: Track[]; index: number; autoplayCount: number };

/**
 * Shuffle reorders the queue itself, so the queue is the play order and
 * Previous retraces it. Only your upcoming songs move: what played, the song
 * playing and AutoPlay's suggestions stay where they are.
 */
function shuffledUpcoming(s: QueueShape): Track[] {
  const end = s.queue.length - autoplayTail(s);
  return [...s.queue.slice(0, s.index + 1), ...seededShuffle(s.queue.slice(s.index + 1, end), randomSeed()), ...s.queue.slice(end)];
}

/** Your songs' ids from the one at `index` round to the one before it: your order as a cycle read from that song. */
const orderFrom = (tracks: Track[], index: number): string[] =>
  [...tracks.slice(index), ...tracks.slice(0, index)].map((t) => t.id);

/**
 * Where your upcoming songs stand in your order (`unshuffled`, a cycle).
 * `from` is the place of the song playing (`own`) or, when your order holds
 * no place for it (a suggestion, a song from "Play now"), of the last song
 * before it that it does; -1 when none. `at[k]` is the place of upcoming entry
 * index+1+k: a song's upcoming copies take its places in turn on from
 * `from`; -1 when none is left (added with Add to queue while shuffled).
 * `spare` lists the places no upcoming copy takes (songs played or removed).
 */
function placesIn(order: string[], s: QueueShape): { from: number; own: boolean; at: number[]; spare: number[] } {
  const end = s.queue.length - autoplayTail(s);
  const first = new Map<string, number>();
  const left = new Map<string, number>();
  order.forEach((id, p) => {
    if (!first.has(id)) first.set(id, p);
    left.set(id, (left.get(id) ?? 0) + 1);
  });
  let j = Math.min(s.index, s.queue.length - 1); // -1 for an empty queue
  while (j >= 0 && !first.has(s.queue[j].id)) j--;
  const from = j < 0 ? -1 : first.get(s.queue[j].id)!;
  const own = j === s.index;
  if (own) left.set(s.queue[j].id, left.get(s.queue[j].id)! - 1); // the song playing keeps its own place
  const free = new Map<string, number[]>();
  for (let k = 1; k <= order.length; k++) {
    const p = (from + k) % order.length;
    const n = left.get(order[p])!;
    if (n <= 0) continue;
    left.set(order[p], n - 1);
    const list = free.get(order[p]);
    if (list) list.push(p);
    else free.set(order[p], [p]);
  }
  const at = s.queue.slice(s.index + 1, end).map((t) => free.get(t.id)?.shift() ?? -1);
  return { from, own, at, spare: [...free.values()].flat() };
}

/** Your order as a cycle read from the song playing — given a place right after the last song before it when it had none. */
function fromPlaying(order: string[], s: QueueShape): string[] {
  const { from, own } = placesIn(order, s);
  const k = own ? from : from + 1;
  const cycle = [...order.slice(k), ...order.slice(0, k)];
  return own ? cycle : [s.queue[s.index].id, ...cycle];
}

/** `order` without the places in `drop`, with `ids` right after place `after` (-1: first). */
function reorder(order: string[], drop: Set<number>, ids: string[], after: number): string[] {
  const out = after < 0 ? [...ids] : [];
  order.forEach((id, p) => {
    if (!drop.has(p)) out.push(id);
    if (p === after) out.push(...ids);
  });
  return out;
}

/**
 * Shuffle off: your upcoming songs in your order on from the song playing —
 * the ones before it in your order go after the last — then songs your order
 * doesn't hold, as queued; AutoPlay's suggestions stay last.
 */
function inYourOrder(s: QueueShape, order: string[]): Track[] {
  const end = s.queue.length - autoplayTail(s);
  const { from, at } = placesIn(order, s);
  const n = order.length;
  const rank = (p: number): number => (p < 0 ? n : (p - from - 1 + n) % n);
  const upcoming = s.queue
    .slice(s.index + 1, end)
    .map((t, k) => ({ t, r: rank(at[k]) }))
    .sort((a, b) => a.r - b.r)
    .map((u) => u.t);
  return [...s.queue.slice(0, s.index + 1), ...upcoming, ...s.queue.slice(end)];
}

/**
 * The next pass of a shuffled repeat-all queue: a fresh order that never
 * starts with the song that just ended (a queue of copies of one song stays
 * as it is). Seeded by the queue's own order, so upNext() can name the
 * wrap's first song while the last one plays, and next() and finishBlend()
 * install that same order.
 */
export function nextPass(queue: Track[]): Track[] {
  if (queue.length < 2) return queue;
  const out = seededShuffle(queue, hash32(queue.map((t) => t.id).join()));
  const last = queue[queue.length - 1].id;
  if (out[0].id !== last) return out;
  const k = out.findIndex((t) => t.id !== last);
  if (k < 0) return queue;
  [out[0], out[k]] = [out[k], out[0]];
  return out;
}

interface PlayerState {
  queue: Track[];
  index: number;
  playing: boolean;
  buffering: boolean;
  position: number;
  duration: number;
  /** 0..1 — how much of the current track the audio element has buffered */
  buffered: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  /** bumped whenever the engine should hard-seek to `position` */
  seekNonce: number;
  error: string | null;
  /** AutoPlay suggestions at the end of the queue — read via autoplayTail(). */
  autoplayCount: number;
  /** The queue ran out and AutoPlay is fetching what plays next (not persisted). */
  awaitingAutoplay: boolean;
  /** Bumped when a new listening context starts, so AutoPlay reseeds (not persisted). */
  contextId: number;
  /** The sidebar row the queue was started from (a playlist, Liked Songs, Downloads, Local files
      or an artist), for its "now playing" marker; null when it started anywhere else. */
  playingFrom: string | null;
  /** While shuffle is on: your songs' ids in your order, a cycle read from the song that was playing
      when it last changed; shuffle off continues it from the song playing then. */
  unshuffled: string[] | null;
  /** The song a running blend has crossed over to (it is the louder one now):
      what the screen shows until the blend completes (not persisted). */
  blendInto: Track | null;

  current(): Track | null;
  playQueue(tracks: Track[], startIndex?: number, from?: string): void;
  playTrack(track: Track): void;
  /** Play an entry already in the queue without rebuilding it. */
  jumpTo(i: number): void;
  /** Returns how many songs were added (0 when they were all already waiting). */
  addToQueue(tracks: Track | Track[], playNext?: boolean): number;
  /**
   * Drag-reorder among the upcoming songs: the song at `from` lands at queue
   * index `to`, kept on its own side — your songs among your songs, AutoPlay's
   * suggestions among the suggestions.
   */
  moveUpcoming(from: number, to: number): void;
  removeAt(i: number): void;
  clearUpcoming(): void;
  /** Append AutoPlay suggestions; starts the first one if the queue had run out. */
  appendAutoplay(tracks: Track[]): void;
  /** Remove the upcoming AutoPlay suggestions. */
  dropAutoplay(): void;
  /** AutoPlay found nothing to continue with: stop where the queue ended. */
  stopAwaiting(): void;
  next(manual?: boolean): void;
  /**
   * The audio engine's blend into upNext() finished: move on as next(false)
   * does (at a shuffled repeat-all wrap into the same next pass), already
   * `position` seconds into the song. False, changing nothing, when upNext()
   * is no longer the song `id`.
   */
  finishBlend(id: string, position: number): boolean;
  prev(): void;
  toggle(): void;
  setPlaying(playing: boolean): void;
  seek(sec: number): void;
  setVolume(v: number): void;
  toggleMute(): void;
  toggleShuffle(): void;
  cycleRepeat(): void;

  /* internal setters used by the audio engine */
  _setTime(position: number, duration?: number): void;
  _setBuffered(ratio: number): void;
  _setBuffering(buffering: boolean): void;
  _setError(error: string | null): void;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export const usePlayer = create<PlayerState>()(
  persist(
    (set, get) => ({
      queue: [],
      index: 0,
      playing: false,
      buffering: false,
      position: 0,
      duration: 0,
      buffered: 0,
      volume: 0.8,
      muted: false,
      shuffle: false,
      repeat: "off",
      seekNonce: 0,
      error: null,
      autoplayCount: 0,
      awaitingAutoplay: false,
      contextId: 0,
      playingFrom: null,
      unshuffled: null,
      blendInto: null,

      current() {
        const { queue, index } = get();
        return queue[index] ?? null;
      },

      playQueue(tracks, startIndex = 0, from) {
        if (!tracks.length) return;
        const start = clamp(startIndex, 0, tracks.length - 1);
        // Shuffled: the chosen song first, the rest in a random order after it.
        const shuffle = get().shuffle;
        set({
          queue: shuffle
            ? [tracks[start], ...seededShuffle([...tracks.slice(0, start), ...tracks.slice(start + 1)], randomSeed())]
            : tracks,
          index: shuffle ? 0 : start,
          unshuffled: shuffle ? orderFrom(tracks, start) : null,
          playing: true,
          position: 0,
          error: null,
          autoplayCount: 0,
          awaitingAutoplay: false,
          contextId: get().contextId + 1,
          playingFrom: from ?? null,
        });
      },

      playTrack(track) {
        const { queue, index } = get();
        // Ahead of the current song only: an earlier copy is history, and
        // jumping back to it would replay everything after it.
        const at = queue.findIndex((t, i) => i >= index && t.id === track.id);
        if (queue.length && at >= 0) {
          set({ index: at, playing: true, position: 0, error: null, awaitingAutoplay: false });
          return;
        }
        // A song picked to play now starts its own AutoPlay radio, so the
        // old suggestions go. (An empty queue used to land on index 1 of a
        // one-song queue — nothing played.)
        const own = queue.slice(0, queue.length - autoplayTail(get()));
        const at2 = own.length ? index + 1 : 0;
        set({
          queue: [...own.slice(0, at2), track, ...own.slice(at2)],
          index: at2,
          playing: true,
          position: 0,
          error: null,
          autoplayCount: 0,
          awaitingAutoplay: false,
          contextId: get().contextId + 1,
          playingFrom: null,
        });
      },

      jumpTo(i) {
        if (i < 0 || i >= get().queue.length) return;
        set({ index: i, playing: true, position: 0, error: null, awaitingAutoplay: false });
      },

      addToQueue(tracks, playNext = false) {
        const seenIn = new Set<string>();
        const list = (Array.isArray(tracks) ? tracks : [tracks]).filter((t) => !seenIn.has(t.id) && seenIn.add(t.id));
        if (!list.length) return 0;
        const { queue, index, awaitingAutoplay, shuffle, unshuffled } = get();
        if (!queue.length) {
          set({
            queue: shuffle ? [list[0], ...seededShuffle(list.slice(1), randomSeed())] : list,
            unshuffled: shuffle ? list.map((t) => t.id) : null,
            index: 0,
            playing: false,
            position: 0,
            autoplayCount: 0,
          });
          return list.length;
        }
        // The listener's songs always go before the AutoPlay suggestions. The
        // count is rebased here: once a suggestion has played, the stored
        // count is larger than what is left, and the added songs would
        // otherwise be counted as suggestions (and dropped with them).
        let tail = autoplayTail(get());
        // A song waits in the queue once. Already among your upcoming songs:
        // "Play next" moves it up, "Add to queue" leaves it. Suggested by
        // AutoPlay: it becomes yours (taken out of the suggestions).
        const ownUpcoming = new Set(queue.slice(index + 1, queue.length - tail).map((t) => t.id));
        const add = playNext ? list : list.filter((t) => !ownUpcoming.has(t.id));
        if (!add.length) return 0;
        const addIds = new Set(add.map((t) => t.id));
        const firstSuggestion = queue.length - tail;
        let adopted = 0;
        const q = queue.filter((t, j) => {
          if (j <= index || !addIds.has(t.id)) return true;
          if (j >= firstSuggestion) {
            adopted++;
            return false;
          }
          return false; // your upcoming copy, moving up with Play next
        });
        tail -= adopted;
        const at = playNext ? index + 1 : q.length - tail;
        let order = unshuffled;
        if (shuffle && unshuffled) {
          // Shuffled: Play next also goes right after the song playing in your order, so it stays
          // next when shuffle goes off; Add to queue takes no place there and plays after your songs.
          const base = fromPlaying(unshuffled, get());
          const { at: places, spare } = placesIn(base, get());
          const drop = new Set(spare.filter((p) => addIds.has(base[p])));
          if (playNext) places.forEach((p, k) => p >= 0 && addIds.has(queue[index + 1 + k].id) && drop.add(p));
          order = reorder(base, drop, playNext ? add.map((t) => t.id) : [], 0);
        }
        set({ queue: [...q.slice(0, at), ...add, ...q.slice(at)], autoplayCount: tail, unshuffled: order });
        // Added while AutoPlay was fetching after the queue ran out: play it now.
        if (awaitingAutoplay) set({ index: at, playing: true, position: 0, error: null, awaitingAutoplay: false });
        return add.length;
      },

      moveUpcoming(from, to) {
        const s = get();
        const tail = autoplayTail(s);
        const firstSuggestion = s.queue.length - tail;
        if (from <= s.index || from >= s.queue.length) return;
        const [lo, hi] = from < firstSuggestion ? [s.index + 1, firstSuggestion - 1] : [firstSuggestion, s.queue.length - 1];
        const at = Math.min(Math.max(to, lo), hi);
        if (at === from) return;
        const q = [...s.queue];
        q.splice(at, 0, ...q.splice(from, 1));
        let order = s.unshuffled;
        if (s.shuffle && order && from < firstSuggestion) {
          // Shuffled: the song moves in your order too, right after the song it now follows. After a
          // song your order doesn't hold, it leaves your order and plays after your songs with it.
          const base = fromPlaying(order, s);
          const { at: places, spare } = placesIn(base, s);
          const id = s.queue[from].id;
          const drop = new Set([places[from - s.index - 1], ...spare.filter((p) => base[p] === id)]);
          const after = at === s.index + 1 ? 0 : places[(at < from ? at - 1 : at) - s.index - 1];
          order = reorder(base, drop, after >= 0 ? [id] : [], after);
        }
        set({ queue: q, autoplayCount: tail, unshuffled: order });
      },

      removeAt(i) {
        const s = get();
        const { queue, index } = s;
        if (i < 0 || i >= queue.length) return;
        const tail = autoplayTail(s);
        const q = queue.filter((_, j) => j !== i);
        let ni = index;
        if (i < index) ni = index - 1;
        else if (i === index) ni = Math.min(index, Math.max(q.length - 1, 0));
        set({
          queue: q,
          index: ni,
          autoplayCount: i >= queue.length - tail ? tail - 1 : tail,
          // The song playing is gone: the one taking its place starts from the top.
          ...(i === index ? { position: 0 } : {}),
          // The ended song AutoPlay was waiting after is gone: stop waiting.
          ...(i === index && s.awaitingAutoplay ? { awaitingAutoplay: false, playing: false } : {}),
        });
      },

      clearUpcoming() {
        // Clears the listener's own upcoming songs; the AutoPlay tail stays.
        const s = get();
        const tail = autoplayTail(s);
        set({ queue: [...s.queue.slice(0, s.index + 1), ...s.queue.slice(s.queue.length - tail)], autoplayCount: tail });
      },

      appendAutoplay(incoming) {
        const s = get();
        // Never a song that is playing or already waiting in the queue.
        const present = new Set(s.queue.slice(s.index).map((t) => t.id));
        const tracks = incoming.filter((t) => !present.has(t.id) && present.add(t.id));
        if (!tracks.length) return;
        const tail = autoplayTail(s);
        const cut = Math.max(0, s.index - HISTORY_KEEP);
        const queue = [...s.queue.slice(cut), ...tracks];
        const index = s.index - cut;
        // Only queue/index/count change: writing `position` here would make
        // the engine rewind the song that is playing.
        if (s.awaitingAutoplay) {
          set({
            queue,
            index: queue.length - tracks.length, // the first new song
            autoplayCount: tail + tracks.length,
            playing: true,
            position: 0,
            error: null,
            awaitingAutoplay: false,
          });
          return;
        }
        set({ queue, index, autoplayCount: tail + tracks.length });
      },

      dropAutoplay() {
        const s = get();
        const tail = autoplayTail(s);
        if (!tail && !s.autoplayCount && !s.awaitingAutoplay) return;
        set({
          queue: s.queue.slice(0, s.queue.length - tail),
          autoplayCount: 0,
          awaitingAutoplay: false,
          // Cancelling a wait leaves the queue ended: nothing is playing.
          ...(s.awaitingAutoplay ? { playing: false } : {}),
        });
      },

      stopAwaiting() {
        if (get().awaitingAutoplay) set({ awaitingAutoplay: false, playing: false });
      },

      next(manual = false) {
        const s = get();
        if (!s.queue.length) {
          set({ playing: false });
          return;
        }
        // The queue is the play order, shuffled or not.
        if (s.index + 1 >= s.queue.length && s.repeat !== "all") {
          if (autoplayContinues(s.queue, s.repeat)) {
            // Wait for AutoPlay (lib/autoplay) rather than stopping, or
            // wrapping back to a song from long ago.
            set({ awaitingAutoplay: true });
            return;
          }
          if (!manual) {
            set({ playing: false, position: 0 });
            return;
          }
        }
        const to = advance(s);
        set({ ...(to.queue !== s.queue ? { queue: to.queue } : {}), index: to.index, playing: true, position: 0, error: null, awaitingAutoplay: false });
      },

      finishBlend(id, position) {
        const s = get();
        if (upNext(s)?.id !== id) return false;
        const to = advance(s);
        set({ ...(to.queue !== s.queue ? { queue: to.queue } : {}), index: to.index, position, playing: true, error: null, awaitingAutoplay: false, blendInto: null });
        return true;
      },

      prev() {
        if (get().position > 3) {
          set({ position: 0, seekNonce: get().seekNonce + 1 });
          return;
        }
        const s = get();
        const { queue, index } = s;
        if (!queue.length) return;
        // Wrapping from the first song lands on the listener's last song,
        // never on an AutoPlay suggestion.
        const ni = index > 0 ? index - 1 : Math.max(0, queue.length - autoplayTail(s) - 1);
        set({ index: ni, playing: true, position: 0, error: null, awaitingAutoplay: false });
      },

      toggle() {
        // Nothing to play or pause: flipping `playing` against an empty queue
        // left the play button reading "Pause" with no audio behind it.
        if (!get().queue.length) return;
        // Pausing while AutoPlay fetches cancels the wait, so a late batch
        // can't start playing over the pause.
        const playing = !get().playing;
        set(playing ? { playing } : { playing, awaitingAutoplay: false });
      },

      setPlaying(playing) {
        // Mirrors toggle(): a media-key "play" with an empty queue (e.g.
        // after removing every queued track) must not flip the store into a
        // playing state nothing can back.
        if (playing && !get().queue.length) return;
        set(playing ? { playing } : { playing, awaitingAutoplay: false });
      },

      seek(sec) {
        const { duration } = get();
        set({
          position: clamp(sec, 0, duration > 0 ? duration : sec),
          seekNonce: get().seekNonce + 1,
        });
      },

      setVolume(v) {
        set({ volume: clamp(v, 0, 1), muted: false });
      },

      toggleMute() {
        set({ muted: !get().muted });
      },

      toggleShuffle() {
        const s = get();
        const tail = autoplayTail(s);
        if (!s.shuffle) {
          set({
            shuffle: true,
            unshuffled: orderFrom(s.queue.slice(0, s.queue.length - tail), s.index),
            queue: shuffledUpcoming(s),
            autoplayCount: tail,
          });
        } else {
          set({ shuffle: false, unshuffled: null, queue: inYourOrder(s, s.unshuffled ?? []), autoplayCount: tail });
        }
      },

      cycleRepeat() {
        const order: RepeatMode[] = ["off", "all", "one"];
        set({ repeat: order[(order.indexOf(get().repeat) + 1) % order.length] });
      },

      _setTime(position, duration) {
        const d = Number.isFinite(duration) && (duration ?? 0) > 0 ? (duration as number) : get().duration;
        set({ position, duration: d });
      },

      _setBuffered(buffered) {
        if (Math.abs(get().buffered - buffered) > 0.005) set({ buffered });
      },

      _setBuffering(buffering) {
        if (get().buffering !== buffering) set({ buffering });
      },

      _setError(error) {
        set({ error });
      },
    }),
    {
      name: "player",
      storage: coalescedStorage,
      partialize: (s) =>
        ({
          queue: s.queue,
          index: s.index,
          position: s.position,
          volume: s.volume,
          muted: s.muted,
          shuffle: s.shuffle,
          repeat: s.repeat,
          autoplayCount: s.autoplayCount,
          unshuffled: s.unshuffled,
          playingFrom: s.playingFrom,
        }) as unknown as PlayerState,
      merge: (persisted, current) => {
        const s = { ...current, ...(persisted as Partial<PlayerState>) };
        // Saved by a build whose shuffle picked songs at random: shuffle the upcoming songs once.
        if (s.shuffle && Array.isArray(s.queue) && !Array.isArray(s.unshuffled)) {
          return {
            ...s,
            unshuffled: orderFrom(s.queue.slice(0, s.queue.length - autoplayTail(s)), s.index),
            queue: shuffledUpcoming(s),
          };
        }
        return s;
      },
    }
  )
);

// Once AutoPlay's suggestions take over, the queue no longer plays from where
// it started, for good (a refill later counts the one playing as history).
usePlayer.subscribe((s) => {
  if (s.playingFrom !== null && s.index >= s.queue.length - s.autoplayCount) usePlayer.setState({ playingFrom: null });
});

/** The sidebar row to mark as playing: where the queue started, while it plays. */
export function playingFromRow(s: { playing: boolean; playingFrom: string | null }): string | null {
  return s.playing ? s.playingFrom : null;
}

/** How a song is doing right now — "playing", "paused" (current but paused) or
 *  null — so every list can mark the song that's on. */
export function useTrackPlayback(id: string): "playing" | "paused" | null {
  return usePlayer((s) => (s.queue[s.index]?.id === id ? (s.playing ? "playing" : "paused") : null));
}
