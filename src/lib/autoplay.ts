/**
 * Endless AutoPlay — keeps YouTube Music's own song radio queued as a tail of
 * suggestions after the listener's songs (see autoplayTail in stores/player).
 *
 * Refills run ahead of time, so the next song is always already in the queue:
 * no silent gap when the listener's songs run out, and crossfade, Automix and
 * prefetch treat suggestions like any other track. The radio continues page by
 * page on YouTube's continuation token for as long as the music plays.
 *
 * Driven by store subscriptions rather than store actions: the macOS menu sets
 * repeat, several views set shuffle, and the crossfade writes the index — all
 * directly.
 */
import { create } from "zustand";
import { autoplayTail, isRadioSeed, usePlayer } from "../stores/player";
import { useSettings } from "../stores/settings";
import { useLibrary } from "../stores/library";
import { useUI } from "../stores/ui";
import { inRoom } from "../stores/room";
import type { RadioPage, Track } from "../types";
import { requireBridge } from "./bridge";
import { artistKey, pickSuggestions, recordingKey, type RadioCandidate } from "./radio-filter";

/** Refill when fewer suggestions than this are queued… */
const LOW_WATER = 5;
/** …up to this many. */
const MAX_TAIL = 25;
/** Radio pages to try per refill when filtering leaves nothing new. */
const MAX_PAGES = 3;
/** After a refill came back empty, wait before asking again (unless the queue ran out). */
const RETRY_AFTER_MS = 60_000;
const OFFER_KEY = "bytune.autoplayOffered";

/** What the queue panel shows above the suggestions. */
export const useAutoplayInfo = create<{ seedTitle: string | null; loading: boolean }>(() => ({
  seedTitle: null,
  loading: false,
}));

/** Bumped when a new context starts or AutoPlay is switched off: in-flight answers are dropped. */
let generation = 0;
let inflight: Promise<void> | null = null;
let seed: Track | null = null;
let token: string | null = null;
let failedAt = 0;
let started = false;
/** contextId last seen — compared, not diffed against `prev`, because the
    engine's own listener updates the store from inside the same change. */
let lastContext = -1;
/** "Don't play this" picks, for this session — by id and by recording, so
    another upload of the same song can't take its place. */
const blocked = new Set<string>();
const blockedKeys = new Set<string>();
/** Every song that started playing this session, so the radio never repeats one.
    (Suggestions dropped unplayed — AutoPlay switched off — may come back.) */
const playedIds = new Set<string>();
const playedKeys = new Set<string>();

function addKeys(tracks: readonly Track[], ids: Set<string>, keys: Set<string>): void {
  for (const t of tracks) {
    ids.add(t.id);
    const key = recordingKey(t.title, t.artist);
    if (key) keys.add(key);
  }
}

/** True while AutoPlay should keep the queue topped up. */
function wantsMore(): boolean {
  const p = usePlayer.getState();
  if (!useSettings.getState().autoplay || inRoom() || p.repeat !== "off") return false;
  // The radio continues from the newest queued song; local files have none.
  const newest = p.queue[p.queue.length - 1];
  if (!isRadioSeed(newest?.id) || newest?.episode) return false; // podcasts have no radio
  if (p.awaitingAutoplay) return true;
  if (!p.playing || Date.now() - failedAt < RETRY_AFTER_MS) return false;
  const tail = autoplayTail(p);
  const ownLeft = p.queue.length - tail - p.index - 1;
  return ownLeft <= 1 && tail < LOW_WATER;
}

function radio(id: string, next?: string | null): Promise<RadioPage | null> {
  return requireBridge()
    .getRadio(id, next ?? undefined)
    .catch(() => null);
}

/** The next batch: the current radio first, then one other seed, then the Home feed. */
async function fetchBatch(gen: number): Promise<Track[]> {
  const p = usePlayer.getState();
  // Nothing already played this session, nothing already in the queue.
  const excludeIds = new Set([...playedIds, ...blocked]);
  const excludeKeys = new Set([...playedKeys, ...blockedKeys]);
  addKeys(p.queue, excludeIds, excludeKeys);
  if (useSettings.getState().dontRepeatSuggestions) {
    for (const t of useLibrary.getState().history) excludeIds.add(t.id);
  }
  const limit = MAX_TAIL - autoplayTail(p);
  const pick = (tracks: RadioCandidate[], seedArtist?: string): Track[] =>
    pickSuggestions(tracks, { excludeIds, excludeKeys, seedArtist, limit });

  // 1. Continue the current radio, or start one from the newest queued song.
  const newest = p.queue[p.queue.length - 1];
  if (!seed || !token) {
    seed = newest;
    token = null;
  }
  useAutoplayInfo.setState({ seedTitle: seed.title });
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await radio(seed.id, token);
    if (gen !== generation) return [];
    token = res?.next ?? null;
    if (!res) break;
    const picked = pick(res.tracks, res.seed?.artistId || artistKey(res.seed?.artist ?? seed.artist));
    if (picked.length) return picked;
    if (!token) break;
  }

  // 2. One other seed: the song playing now.
  const cur = p.queue[p.index];
  if (cur && cur.id !== seed.id && isRadioSeed(cur.id)) {
    seed = cur;
    useAutoplayInfo.setState({ seedTitle: cur.title });
    const res = await radio(cur.id);
    if (gen !== generation) return [];
    token = res?.next ?? null;
    const picked = res ? pick(res.tracks, res.seed?.artistId || artistKey(cur.artist)) : [];
    if (picked.length) return picked;
  }

  // 3. Last resort, as AutoPlay worked before: something new from the Home feed.
  useAutoplayInfo.setState({ seedTitle: null });
  const shelves = await requireBridge()
    .getHome()
    .catch(() => null);
  if (gen !== generation) return [];
  const pool: Track[] = [];
  for (const shelf of shelves ?? []) {
    for (const item of shelf.items ?? []) if (item.kind === "track" && item.track) pool.push(item.track);
  }
  return pick(pool).slice(0, 10);
}

function refill(): Promise<void> {
  if (inflight) return inflight;
  const gen = generation;
  inflight = (async () => {
    useAutoplayInfo.setState({ loading: true });
    try {
      const batch = await fetchBatch(gen);
      if (gen !== generation) return;
      if (batch.length) {
        failedAt = 0;
        usePlayer.getState().appendAutoplay(batch);
        return;
      }
      failedAt = Date.now();
      giveUp();
    } catch {
      if (gen === generation) {
        failedAt = Date.now();
        giveUp();
      }
    } finally {
      inflight = null;
      useAutoplayInfo.setState({ loading: false });
      // An answer dropped as stale left the new context without a refill.
      if (gen !== generation && wantsMore()) void refill();
    }
  })();
  return inflight;
}

/** Nothing to continue with: if the queue had already run out, stop there. */
function giveUp(): void {
  useAutoplayInfo.setState({ seedTitle: null });
  const p = usePlayer.getState();
  if (!p.awaitingAutoplay) return;
  p.stopAwaiting();
  useUI.getState().toast("AutoPlay couldn't find more songs right now", "info");
}

/** Start over: a new context, or AutoPlay switched off. */
function reset(): void {
  generation += 1;
  seed = null;
  token = null;
  failedAt = 0;
  useAutoplayInfo.setState({ seedTitle: null });
}

/** "Don't play this": remove a queued suggestion and keep it out for the session. */
export function dontPlay(index: number): void {
  const p = usePlayer.getState();
  const track = p.queue[index];
  if (!track) return;
  blocked.add(track.id);
  const key = recordingKey(track.title, track.artist);
  if (key) blockedKeys.add(key);
  p.removeAt(index);
}

function offered(): boolean {
  try {
    return localStorage.getItem(OFFER_KEY) === "1";
  } catch {
    return true;
  }
}

/**
 * AutoPlay used to ship switched off, so existing installs carry "off" without
 * having chosen it. The first time their queue runs out, offer it once.
 */
function maybeOffer(): void {
  if (useSettings.getState().autoplay || offered() || inRoom()) return;
  // Never take over a dialog the listener has open; ask at a later end instead.
  if (useUI.getState().dialog) return;
  try {
    localStorage.setItem(OFFER_KEY, "1");
  } catch {
    return;
  }
  useUI.getState().openDialog({
    title: "Keep the music going?",
    body: "When your songs run out, AutoPlay keeps playing music like what you just heard. You can turn it off anytime in Settings.",
    confirmLabel: "Turn on AutoPlay",
    cancelLabel: "Not now",
    onConfirm: () => {
      useSettings.getState().setAutoplay(true);
      // Pick up where the queue ended.
      usePlayer.getState().next(false);
    },
  });
}

function markOffered(): void {
  try {
    localStorage.setItem(OFFER_KEY, "1");
  } catch {
    /* no storage: the offer simply can't show */
  }
}

export function initAutoplay(): void {
  if (started) return;
  started = true;
  // A saved queue may carry suggestions from before AutoPlay was switched off
  // (or repeat on), for example on another device.
  if (!useSettings.getState().autoplay || usePlayer.getState().repeat !== "off") usePlayer.getState().dropAutoplay();
  usePlayer.subscribe((s, prev) => {
    const cur = s.queue[s.index];
    if (cur && cur.id !== prev.queue[prev.index]?.id) addKeys([cur], playedIds, playedKeys);
    if (s.contextId !== lastContext) {
      lastContext = s.contextId;
      reset();
    }
    if (s.repeat !== prev.repeat && s.repeat !== "off") {
      // Repeat loops the listener's songs; suggestions would loop with them.
      reset();
      const waiting = s.awaitingAutoplay;
      usePlayer.getState().dropAutoplay();
      // Repeat-all switched on while the queue had run out: loop it now.
      if (waiting && s.repeat === "all") usePlayer.getState().next(false);
      return;
    }
    // The queue ran out with AutoPlay off: a YouTube song played to the end
    // and stopped (next() resets the position; a pause would keep it).
    if (
      prev.playing &&
      !s.playing &&
      !s.error &&
      s.position === 0 &&
      prev.duration > 0 &&
      // Played to (nearly) the end — Skip Silence stops a few seconds early.
      prev.position >= prev.duration - 15 &&
      s.queue.length > 0 &&
      s.index === s.queue.length - 1 &&
      isRadioSeed(s.queue[s.index]?.id)
    ) {
      maybeOffer();
    }
    if (wantsMore()) void refill();
  });
  useSettings.subscribe((s, prev) => {
    if (s.autoplay === prev.autoplay) return;
    // Stores hydrate before this subscribes, so any change here is a choice
    // (or a synced one): no offer to people who picked either way.
    markOffered();
    reset();
    if (!s.autoplay) usePlayer.getState().dropAutoplay();
    else if (wantsMore()) void refill();
  });
}
