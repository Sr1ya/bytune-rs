/**
 * Audio engine — two HTMLAudioElements wired to the player store.
 *
 * The store holds pure state; this module owns all playback side effects:
 * stream resolution (via the main process), play/pause/seek application,
 * error recovery with client rotation, history logging, MediaSession
 * integration (Windows media keys / SMTC, with double-press recognition for
 * headset play/pause buttons and pause-on-output-loss), and transitions.
 *
 * Transitions (crossfade controller):
 *   - "standard" crossfade: when a setting duration is configured, the next
 *     track is resolved and started on the standby element a beat before the
 *     current one ends, and the two are blended with an equal-power curve
 *     (out·cosθ + in·sinθ) — no dip in the middle, the standard crossfade law.
 *   - Automix (and Skip silence) plan the blend on each song's analysis — one
 *     reduced-rate decode per song (lib/analysis): it ends where the outgoing
 *     song's sound ends and the incoming one enters at its first sound, and
 *     Automix slides the start by under a beat so the beats land together
 *     when the tempos match (planBlend). No analysis ⇒ the standard fade.
 *     Half way through, the screen moves to the incoming song (blendInto).
 *   - manual next/prev/seek aborts any fade in flight.
 *
 * Transition states, and the invariant they exist to protect:
 *
 *   idle     — one live deck; the session player is the only one playing.
 *   armed    — the next track is resolved and sits on the standby deck.
 *   blending — the standby deck is PLAYING and audible while the session
 *              player fades out. Two decks are live, and the standby's media
 *              clock is authoritative for the track it is playing.
 *   settled  — the standby deck was promoted to session player.
 *
 *   IF A TRACK IS ALREADY PLAYING DURING A BLEND, THE TRANSITION'S COMPLETION
 *   MUST PROMOTE THAT DECK. Re-running the fresh-track path would reload the
 *   same track from 0:00 and replay the seconds the listener just heard.
 *
 * Two independent signals mean "the transition is over": the blend timer
 * reaching the end of its curve, and the outgoing element's `ended`. They race
 * by a few milliseconds — the fade timeline starts after an async resolve and a
 * play(), so `ended` usually lands first — so both funnel through one
 * idempotent completion, and the deck that is already playing wins either way.
 */
import { useLibrary } from "../stores/library";
import { upNext, usePlayer } from "../stores/player";
import { useSettings } from "../stores/settings";
import { useUI } from "../stores/ui";
import { isEarlyExit, useListening } from "../stores/listening";
import { useJournal } from "../stores/journal";
import type { Track } from "../types";
import { requireBridge } from "./bridge";
import { emitPlayEvent } from "./playEvents";
import { analyseTrack, peekAnalysis, type TrackAnalysis } from "./analysis";
import { upgradeArtwork } from "./artwork";
import { shortTitle } from "./format";
import { createMediaKeyTap } from "./media-key-tap";
import { useSleepTimer } from "./sleepTimer";
import { inRoom, stopHere, useRoom } from "../stores/room";
import {
  deviceChoices,
  outputChangeAction,
  snapshotOutputs,
  type OutputDeviceChoice,
  type OutputSnapshot,
} from "./audio-output";

let elements: [HTMLAudioElement, HTMLAudioElement] | null = null;
/** which element is the session player right now */
let mainIdx: 0 | 1 = 0;
let loadedId: string | null = null;
let pendingSeek = 0;
/** retries (with client rotation) for the current track */
let retryCount = 0;
/** Where the song was when it was last retried: one that plays on for 30 s may retry again. */
let retriedAt = -Infinity;
/** consecutive tracks that failed to play — stops auto-skipping eventually */
let consecutiveFailures = 0;
/** the unlinked-local-folder explainer fires once per failing streak, not per skip */
let localMissingToasted = false;
let historyForId: string | null = null;
/** track id the engine itself is advancing to via crossfade — suppresses reload */
let advancingToId: string | null = null;

const MAX_SKIPS = 5;
const LOCAL_MISSING = "Local file is missing on disk";

interface FadeState {
  /** ids, to detect the fade's own completion vs an interrupting change */
  fromId: string;
  toId: string;
  /** the incoming song, shown from the crossover on */
  to: Track;
  /** the screen has switched to the incoming song (half way, where it becomes the louder one) */
  crossed?: boolean;
  startTs: number;
  durMs: number;
  /** performance.now() when playback paused mid-fade; null while playing.
      The blend freezes with playback — see the pause branch and driveFade. */
  pausedAt: number | null;
}
let fade: FadeState | null = null;
let fadeTimer: number | null = null;
/** arming window: resolve/start the next track this long before the fade point */
const ARM_LEAD_MS = 4000;
let armed: { toId: string } | null = null;
/** A blend whose incoming song failed. It isn't retried while the same song
 *  plays: that song plays out and the normal end path loads the next one. */
let failedBlend: { fromId: string | null; toId: string } | null = null;
/**
 * Bumped whenever something invalidates an in-flight arming (a track change, a
 * completed or aborted transition). `beginFade` awaits several times before it
 * starts the standby deck; without this its continuation could wake up after
 * the world moved on and start a track the user already skipped past.
 */
let transitionToken = 0;
/** True while a completion is promoting a deck — makes completion idempotent. */
let settling = false;

/** Derived phase, for callers that must not fight an in-flight transition. */
function transitioning(): boolean {
  return fade !== null || armed !== null;
}
/**
 * The playback settings in force. A room plays every song as it is, at normal speed, one after
 * another, so every computer in it stays at the same moment (lib/rooms).
 */
function playbackSettings(): { smartFade: boolean; skipSilence: boolean; crossfadeSeconds: number; playbackSpeed: number } {
  return inRoom() ? { smartFade: false, skipSilence: false, crossfadeSeconds: 0, playbackSpeed: 1 } : useSettings.getState();
}

/** A song's silent edges, when Skip silence wants them trimmed. */
function silenceEdges(trackId: string | undefined): TrackAnalysis | null {
  return trackId && playbackSettings().skipSilence ? peekAnalysis(trackId) : null;
}
/** Songs whose loudness leveling waits on a measurement: Piped streams (YouTube
    reported none) and local files without ReplayGain. */
const needsMeasuring = new Set<string>();

function el(): HTMLAudioElement {
  return elements![mainIdx];
}

/** Live element clock for consumers needing sub-`timeupdate` resolution (lyrics sweep). */
export function getPlaybackPosition(): number {
  return elements ? el().currentTime : 0;
}
function standbyEl(): HTMLAudioElement {
  return elements![mainIdx === 0 ? 1 : 0];
}

/**
 * play() promises reject with "AbortError" when pause() or a src change wins
 * the race — that is a normal interruption, not a playback failure. Treating
 * it as one made handleFailure force-rotate the stream and restart audio the
 * user had just stopped.
 */
function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: string }).name === "AbortError";
}

/* ============================ loudness normalisation ============================ */

/**
 * Spotify-parity loudness normalisation.
 *
 * Spotify adjusts every stream to roughly -14 LUFS before it reaches the OS
 * mixer; raw YouTube streams are mastered hotter (measured: -7.7 LUFS for
 * "Shape of You", -10.7 for "All of Me"), which is why ByTune blasted past
 * Spotify at identical volume settings. YouTube reports each track's true
 * integrated loudness in the player response — the stream proxy exposes it
 * at `?meta=1` — so we compute the exact per-track gain that lands the
 * stream on the same -14 LUFS target. The gain is attenuation-only (see
 * gainForLufs): loud masters scale down, quiet ones play untouched, and no
 * sample is ever pushed past full scale. Piped streams carry no loudness and
 * are measured instead; local files level by their ReplayGain tag, or by the
 * same measurement when they have none.
 */
/** Volume leveling targets (integrated loudness); "off" plays streams as mastered. */
const LOUDNESS_TARGETS: Record<string, number> = { quiet: -19, normal: -14, loud: -11 };
/**
 * Loudness assumed for a track whose loudness hasn't landed yet, or whose
 * measurement failed. Typical YouTube masters sit around -9 LUFS, whose
 * normalisation gain is ≈0.56; YouTube's report usually arrives with the first
 * audio chunk, so for most streams this only shapes the very start.
 */
const FALLBACK_LUFS = -9;

/** track id → loudness (LUFS): YouTube's report, ReplayGain or a measurement. Insertion-ordered as an LRU. */
const loudnessLufs = new Map<string, number>();
const GAINS_MAX = 600;

/** Normalisation gain that moves a track measured at `lufs` to the target.
 * Attenuation-only: scaling a signal down is lossless, boosting would clip
 * peaks on masters that sit near full scale — quality comes first. */
function gainForLufs(lufs: number, target: number): number {
  return Math.min(1, Math.max(0.05, Math.pow(10, (target - lufs) / 20)));
}

function rememberLufs(trackId: string, lufs: number): void {
  loudnessLufs.delete(trackId);
  loudnessLufs.set(trackId, lufs);
  while (loudnessLufs.size > GAINS_MAX) {
    const first = loudnessLufs.keys().next().value;
    if (first === undefined) break;
    loudnessLufs.delete(first);
  }
}

function gainForTrack(trackId: string | null): number {
  const known = trackId ? loudnessLufs.get(trackId) : undefined;
  const target = LOUDNESS_TARGETS[useSettings.getState().loudnessLevel];
  if (target === undefined) return MASTER_TRIM; // leveling off
  return gainForLufs(known ?? FALLBACK_LUFS, target) * MASTER_TRIM;
}

/** A level that lands on a song being heard glides this long instead of stepping. */
const LEVEL_GLIDE_MS = 2000;
/** Songs whose level is gliding: from the level heard when the new one landed, since `at`. */
const glides = new Map<string, { from: number; at: number }>();
let glideTimer: number | null = null;

/** Seconds of its source a deck has played; a new src starts at none. */
function playedSeconds(a: HTMLAudioElement): number {
  let s = 0;
  for (let i = 0; i < a.played.length; i++) s += a.played.end(i) - a.played.start(i);
  return s;
}

/** The level a song plays at now: its leveling gain, or part way along a glide to it. */
function levelOf(trackId: string | null): number {
  const target = gainForTrack(trackId);
  const g = trackId ? glides.get(trackId) : undefined;
  if (!g) return target;
  const p = Math.min(1, (performance.now() - g.at) / LEVEL_GLIDE_MS);
  return g.from + ((target - g.from) * (1 - Math.cos(Math.PI * p))) / 2;
}

function tickGlides(): void {
  const now = performance.now();
  for (const [id, g] of glides) if (now - g.at >= LEVEL_GLIDE_MS) glides.delete(id);
  refreshVolumes();
  if (!glides.size && glideTimer != null) {
    window.clearInterval(glideTimer);
    glideTimer = null;
  }
}

/** A song's loudness landed (YouTube's report, ReplayGain or a measurement): a song being heard glides to it. */
function setLoudness(trackId: string, lufs: number): void {
  if (loudnessLufs.get(trackId) === lufs) {
    rememberLufs(trackId, lufs); // unchanged: it only moves up the LRU
    return;
  }
  const st = usePlayer.getState();
  const current = st.queue[st.index]?.id === trackId;
  const blending = fade?.toId === trackId || fade?.fromId === trackId;
  const from = levelOf(trackId);
  rememberLufs(trackId, lufs);
  // Heard already: a blend's decks, or the playing deck once it has played some of this song.
  const heard = blending || (current && st.playing && loadedId === trackId && playedSeconds(el()) > 0);
  if (heard && Math.abs(gainForTrack(trackId) - from) > 1e-4) {
    glides.set(trackId, { from, at: performance.now() });
    if (glideTimer == null) glideTimer = window.setInterval(tickGlides, 25);
  } else {
    glides.delete(trackId); // not heard: it takes the new level at once
  }
  if (current || blending) refreshVolumes();
}

/**
 * Fetch a stream's loudness metadata from the proxy and cache its gain.
 * Best-effort: on failure the track keeps the fallback gain.
 */
async function fetchLoudness(proxyUrl: string, track: Track): Promise<void> {
  const trackId = track.id;
  try {
    const res = await fetch(`${proxyUrl}&meta=1`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return;
    const data = (await res.json()) as { lufs?: unknown };
    const lufs = typeof data?.lufs === "number" && Number.isFinite(data.lufs) ? data.lufs : null;
    if (lufs === null) {
      // A Piped stream: YouTube reported nothing, so measure it.
      needsMeasuring.add(trackId);
      analyse(track);
      return;
    }
    needsMeasuring.delete(trackId);
    // The track already playing (or being faded into) picks the gain up now.
    setLoudness(trackId, lufs);
  } catch {
    /* metadata is best-effort */
  }
}

/**
 * Pre-warm the next queue track: its loudness must be known before a
 * crossfade starts, and the proxy-side resolution cache warms up too, so the
 * transition itself never waits on a getBasicInfo roundtrip.
 */
function prefetchLoudness(track: Track | null): void {
  if (!track) return;
  analyse(track); // edges and beats ahead of a blend
  if (track.localPath || track.id.startsWith("local:")) {
    levelLocal(track);
    return;
  }
  // No loudnessGains shortcut: a replayed track knows its gain but its
  // resolution has likely expired, and a warm `?meta=1` hit costs nothing.
  void (async () => {
    const url = await requireBridge().getStreamUrl(track.id, false, useSettings.getState().streamingQuality);
    if (url) await fetchLoudness(url, track);
  })().catch(() => undefined);
}

/** A local file levels by its ReplayGain tag (reference ≈ -18 LUFS), else by a measurement. */
function levelLocal(track: Track): void {
  if (loudnessLufs.has(track.id)) return;
  void (async () => {
    const gainDb = await requireBridge().localGainDb(track.id);
    if (typeof gainDb === "number") {
      setLoudness(track.id, -18 - gainDb);
      return;
    }
    needsMeasuring.add(track.id);
    analyse(track);
  })().catch(() => undefined);
}

/**
 * Analyse a song once (lib/analysis) when something uses it: Skip silence and
 * Automix its edges and beats, leveling its loudness. Applies what it finds
 * to the song if it is the one playing.
 */
function analyse(track: Track): void {
  const s = playbackSettings();
  if (!s.smartFade && !s.skipSilence && !needsMeasuring.has(track.id)) return;
  // A song listed without its length (Home cards, podcast episodes) waits for its deck to know it.
  const duration = track.duration || (loadedId === track.id && Number.isFinite(el().duration) ? el().duration : 0);
  if (!duration) return;
  void analyseTrack({ ...track, duration })
    .then((a) => {
      if (needsMeasuring.has(track.id)) {
        needsMeasuring.delete(track.id);
        // A failed or dropped measurement isn't remembered: the fallback gain stays and the next play measures again.
        if (a?.lufs != null) setLoudness(track.id, a.lufs);
      }
      const edges = silenceEdges(track.id);
      const st = usePlayer.getState();
      if (!edges || st.queue[st.index]?.id !== track.id || loadedId !== track.id) return;
      const a0 = el();
      // Trim the head only while the song has barely started.
      if (edges.head > 0.05 && a0.currentTime < Math.max(0.6, edges.head)) {
        try {
          a0.currentTime = edges.head;
        } catch {
          /* ignore */
        }
      }
      if (edges.tail > 0.05 && st.playing) armSilenceTail(edges.tail);
    })
    .catch(() => undefined);
}

/**
 * Master trim — folded into every track's gain, local files included. 1.0 =
 * neutral: songs play at the standard -14 LUFS loudness, same as
 * Spotify/YouTube Music. Lower it (e.g. 0.7) if you want them quieter than
 * the standard, or nudge it up if you want them hotter — above 1.0 a loud
 * master can clip, so treat anything >1.0 with care.
 */
const MASTER_TRIM = 1.0;

function userVolume(): number {
  const s = usePlayer.getState();
  return s.muted ? 0 : s.volume;
}

/* ------------------- play/pause volume ramp ------------------- */

/**
 * Spotify-style pause/resume: the volume glides to silence over ~150ms before
 * the element actually pauses, and glides back up on resume, so play/pause
 * never clicks. Deliberately separate from the crossfade controller — it only
 * shapes the main element around a play/pause flip and stands down the moment
 * anything else (a crossfade, a track change, a fresh load) touches volumes.
 */
const PP_RAMP_MS = 150;

/** Active ramp: dir 0 = gliding down to a pause, 1 = gliding up on resume.
 * `from` lets a reversed ramp continue from its current level instead of
 * snapping (pause pressed mid fade-in, play pressed mid fade-out). */
let ppRamp: { dir: 0 | 1; from: number; startTs: number; timer: number } | null = null;

function stopPpRamp(): void {
  if (ppRamp) {
    window.clearInterval(ppRamp.timer);
    ppRamp = null;
  }
}

/** Ramp multiplier for the main element — 1 (neutral) when no ramp runs. */
function ppRampGain(): number {
  if (!ppRamp) return 1;
  const p = Math.min(1, Math.max(0, (performance.now() - ppRamp.startTs) / PP_RAMP_MS));
  const eased = (1 - Math.cos(Math.PI * p)) / 2;
  return ppRamp.dir === 0 ? ppRamp.from * (1 - eased) : ppRamp.from + (1 - ppRamp.from) * eased;
}

function startPpRamp(dir: 0 | 1): void {
  const from = ppRamp ? ppRampGain() : dir === 1 ? 0 : 1;
  stopPpRamp();
  if (!elements) return;
  ppRamp = { dir, from, startTs: performance.now(), timer: 0 };
  ppRamp.timer = window.setInterval(() => {
    if (!ppRamp || !elements) {
      stopPpRamp();
      return;
    }
    // A crossfade owns the volume curve while it runs — stand down.
    if (fade) {
      stopPpRamp();
      return;
    }
    const d = ppRamp.dir;
    if ((d === 0 && ppRampGain() <= 0) || (d === 1 && ppRampGain() >= 1)) {
      stopPpRamp();
      // The fade-out's whole point: pause only once silence is reached —
      // and never if a resume already won the race.
      if (d === 0 && !usePlayer.getState().playing) el().pause();
      refreshVolumes();
      return;
    }
    refreshVolumes();
  }, 25);
}

/** Re-apply element volumes for the current state (fade curve, ramp or steady). */
function refreshVolumes(): void {
  if (fade) {
    // Same clock driveFade uses: while paused the blend holds its frozen
    // point instead of drifting to the end of the curve.
    const clock = fade.pausedAt ?? performance.now();
    const p = Math.min(1, Math.max(0, (clock - fade.startTs) / fade.durMs));
    const theta = p * (Math.PI / 2);
    applyElementVolumes(Math.cos(theta), Math.sin(theta));
  } else {
    applyElementVolumes(ppRampGain(), 0);
  }
}

/**
 * Set both elements' volumes from the user volume, the crossfade curve and
 * each element's own track loudness gain (main = current track, standby =
 * the track being faded in).
 */
function applyElementVolumes(mainGain: number, standbyGain: number): void {
  if (!elements) return;
  const v = userVolume() * useSleepTimer.getState().level;
  const state = usePlayer.getState();
  const mainId = state.queue[state.index]?.id ?? null;
  const standbyId = fade?.toId ?? null;
  const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
  const mainLevel = levelOf(mainId);
  elements[mainIdx].volume = clamp01(v * mainGain * mainLevel);
  // The leveling level, not the volume slider or the sleep fade: headroom tied
  // to those cancelled them out whenever a boost needed room.
  applyHeadroom(clamp01(mainLevel));
  elements[mainIdx === 0 ? 1 : 0].volume = clamp01(v * standbyGain * levelOf(standbyId));
}

function applySpeed(): void {
  if (!elements) return;
  const rate = playbackSettings().playbackSpeed || 1;
  for (const e of elements) {
    try {
      e.playbackRate = rate;
      // Chromium honours pitch preservation separately; keep speech/music natural.
      (e as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
    } catch {
      /* ignore */
    }
  }
}

/**
 * Route both decks to the user's chosen output device (settings.audioSinkId).
 * An empty string is the spec's "system default". A vanished device makes
 * setSinkId reject — fall back to the default so resume stays audible; the
 * output watch independently resets the setting when the chosen device
 * disappears from enumeration.
 */
function applySink(): void {
  if (!elements) return;
  const target = useSettings.getState().audioSinkId || "";
  // Once the EQ graph owns the decks, the element sinks are bypassed: the
  // context's own sink is the one that reaches the speakers.
  if (eqCtx) {
    const ctx = eqCtx as AudioContext & { sinkId?: string; setSinkId?: (id: string) => Promise<void> };
    if (typeof ctx.setSinkId === "function" && ctx.sinkId !== target) {
      // Same transient-rejection retry as the element path below: with the EQ
      // on, a Bluetooth reconnect used to bounce playback to the default device.
      ctx.setSinkId(target).catch(() => {
        if (!target) return;
        window.setTimeout(() => {
          ctx.setSinkId!(target).catch(() => ctx.setSinkId!("").catch(() => undefined));
        }, 300);
      });
    }
    return;
  }
  for (const e of elements) {
    // setSinkId is Chromium-only; test harnesses and exotic embeds mock plain
    // elements — degrade to the default rather than throw.
    if (typeof e.setSinkId !== "function") continue;
    const current = (e as HTMLAudioElement & { readonly sinkId: string }).sinkId;
    if (current === target) continue;
    e.setSinkId(target).catch(() => {
      if (!target) return;
      // Windows re-issues endpoint ids around device switches, so a just-set
      // sink can reject transiently. Retry once the enumeration settles;
      // only then fall back to the default.
      window.setTimeout(() => {
        e.setSinkId(target).catch(() => e.setSinkId("").catch(() => undefined));
      }, 300);
    });
  }
}

/* ============================ equalizer ============================ */

/** Band centres (Hz) of the 10-band graphic EQ; settings.eqGains maps 1:1. */
export const EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

let eqCtx: AudioContext | null = null;
let eqFilters: BiquadFilterNode[] = [];
let eqLimiter: DynamicsCompressorNode | null = null;
let eqPreGain: GainNode | null = null;
/** Peak of the current EQ curve in dB (0 with no boost). */
let eqPeakDb = 0;

const LIMIT_THRESHOLD_DB = -0.5;
const LIMIT_RATIO = 20;

/**
 * The makeup gain the Web Audio compressor adds on its own (spec: (1 /
 * fullRangeGain)^0.6, hard knee). Cancelled after the limiter so it only ever
 * touches peaks and never lifts the whole signal.
 */
export function compressorMakeupDb(thresholdDb: number, ratio: number): number {
  const fullRangeDb = thresholdDb + (0 - thresholdDb) / ratio;
  return -0.6 * fullRangeDb;
}

/**
 * Auto headroom: how far to pull the signal down before the limiter so EQ
 * boosts don't clip — only by what the boost would push past full scale at
 * this input level (element volume × loudness gain, applied before the graph).
 */
export function headroomDb(peakDb: number, level: number): number {
  if (!(level > 0) || !Number.isFinite(peakDb) || peakDb <= 0) return 0;
  return Math.max(0, peakDb + 20 * Math.log10(Math.min(1, level)));
}

/** Peak of the combined band response, from throwaway filters set to the target gains. */
function eqResponsePeakDb(ctx: BaseAudioContext, gains: number[]): number {
  if (!gains.some((g) => g > 0)) return 0;
  const freqs = new Float32Array(96);
  // Below Nyquist: a 16/24 kHz context (Bluetooth hands-free) answers NaN above it.
  const top = Math.min(20000, ctx.sampleRate / 2 - 1);
  for (let i = 0; i < freqs.length; i++) freqs[i] = 20 * Math.pow(top / 20, i / (freqs.length - 1));
  const total = new Float32Array(freqs.length);
  const mag = new Float32Array(freqs.length);
  const phase = new Float32Array(freqs.length);
  EQ_BANDS.forEach((freq, i) => {
    const f = ctx.createBiquadFilter();
    f.type = i === 0 ? "lowshelf" : i === EQ_BANDS.length - 1 ? "highshelf" : "peaking";
    f.frequency.value = freq;
    f.Q.value = 1.41;
    f.gain.value = gains[i] ?? 0;
    f.getFrequencyResponse(freqs, mag, phase);
    for (let k = 0; k < freqs.length; k++) total[k] += 20 * Math.log10(Math.max(1e-6, mag[k]));
  });
  const peak = Math.max(0, ...total);
  return Number.isFinite(peak) ? peak : 0;
}

/** Re-aim the headroom pre-gain for the steady level of the playing deck. */
function applyHeadroom(level: number): void {
  if (!eqCtx || !eqPreGain) return;
  const db = useSettings.getState().eqAutoHeadroom ? headroomDb(eqPeakDb, level) : 0;
  eqPreGain.gain.setTargetAtTime(Math.pow(10, -db / 20), eqCtx.currentTime, 0.05);
}

/**
 * Both decks → 10 biquads → headroom pre-gain → limiter → makeup cancel →
 * speakers. The limiter is always last, so crossfades and boosts can't clip;
 * below its threshold it passes the signal untouched. Element volume is
 * applied before a MediaElementSource (verified on Electron's Chromium), so the
 * gain/fade/normalisation logic above keeps working through the graph.
 * Built on first enable only: a deck can never be detached from its source
 * node again, so turning the EQ off afterwards just flattens the bands
 * (0 dB biquads are transparent).
 */
function applyEq(): void {
  if (!elements) return;
  const { eqEnabled, eqGains } = useSettings.getState();
  if (!eqCtx) {
    if (!eqEnabled) return;
    const ctx = new AudioContext();
    eqCtx = ctx;
    // A limiter instead of a fixed preamp: a preamp pulled the whole signal
    // down by the largest boost, so every boost made playback quieter. Auto
    // headroom only lowers the level when a boost would clip at this volume.
    eqLimiter = ctx.createDynamicsCompressor();
    eqLimiter.threshold.value = LIMIT_THRESHOLD_DB;
    eqLimiter.knee.value = 0;
    eqLimiter.ratio.value = LIMIT_RATIO;
    eqLimiter.attack.value = 0.002;
    eqLimiter.release.value = 0.15;
    const makeup = ctx.createGain();
    makeup.gain.value = Math.pow(10, -compressorMakeupDb(LIMIT_THRESHOLD_DB, LIMIT_RATIO) / 20);
    eqPreGain = ctx.createGain();
    eqFilters = EQ_BANDS.map((freq, i) => {
      const f = ctx.createBiquadFilter();
      f.type = i === 0 ? "lowshelf" : i === EQ_BANDS.length - 1 ? "highshelf" : "peaking";
      f.frequency.value = freq;
      f.Q.value = 1.41; // one-octave bands
      return f;
    });
    for (const e of elements) ctx.createMediaElementSource(e).connect(eqFilters[0]);
    for (let i = 1; i < eqFilters.length; i++) eqFilters[i - 1].connect(eqFilters[i]);
    eqFilters[eqFilters.length - 1].connect(eqPreGain);
    eqPreGain.connect(eqLimiter);
    eqLimiter.connect(makeup);
    makeup.connect(ctx.destination);
    applySink();
  }
  const gains = eqEnabled ? eqGains : [];
  const t = eqCtx.currentTime;
  eqFilters.forEach((f, i) => f.gain.setTargetAtTime(gains[i] ?? 0, t, 0.02));
  eqPeakDb = eqResponsePeakDb(eqCtx, gains);
  refreshVolumes();
  if (eqCtx.state === "suspended") void eqCtx.resume();
}

let labelsUnlocked = false;

/** Chromium hides labels AND hands out empty deviceIds until the page has
    held capture permission once — without the unlock the picker can list
    endpoints it cannot route to. */
function needsLabelUnlock(devices: readonly MediaDeviceInfo[]): boolean {
  return devices.some((d) => d.kind === "audiooutput" && (!d.deviceId || !d.label));
}

/**
 * The pickable output list for the settings menu. Chromium hides device
 * labels until the page has held capture permission once, so the first open
 * asks for it (tracks stopped immediately) — only on explicit user intent
 * (opening the picker), never at startup. Failure degrades to generic
 * "Speaker N" labels, and the unlock retries on later opens (e.g. after the
 * user enables microphone access in Windows settings) instead of being
 * permanently written off after one failure.
 */
export async function listOutputDevices(): Promise<OutputDeviceChoice[]> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) return [];
  let devices = await navigator.mediaDevices.enumerateDevices();
  if (!labelsUnlocked && needsLabelUnlock(devices)) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
      // Only retire the unlock when it actually produced ids + labels —
      // an OS-level refusal (Windows microphone privacy) stays retryable.
      labelsUnlocked = !needsLabelUnlock(devices);
    } catch {
      /* keep whatever labels we have; retry on the next open */
    }
  }
  return deviceChoices(devices);
}

function updateBuffered(): void {
  const a = el();
  if (!a) return;
  try {
    if (a.buffered.length > 0 && Number.isFinite(a.duration) && a.duration > 0) {
      usePlayer.getState()._setBuffered(a.buffered.end(a.buffered.length - 1) / a.duration);
    }
  } catch {
    /* ignore */
  }
}

function onTimeUpdate(): void {
  const a = el();
  if (!a) return;
  usePlayer.getState()._setTime(a.currentTime, a.duration);
  updateBuffered();
  const cur = usePlayer.getState().queue[usePlayer.getState().index];
  if (cur) accumulate(cur.id, a.currentTime);
  maybeArmTransition();
}

/* ============================ transitions ============================ */

function fadeMsForNext(): number {
  const s = playbackSettings();
  // Automix owns transitions, so it works out of the box: no crossfade
  // duration set means a sensible 6s blend rather than no transition at all.
  const fallback = s.smartFade ? 6 : 0;
  return Math.max(0, Math.round((s.crossfadeSeconds || fallback) * 1000));
}

/**
 * Where a blend starts on the outgoing song (`outAt`) and where the incoming
 * one joins (`inAt`), in each song's own media seconds. With `edges` the blend
 * ends where the outgoing song's sound ends and the incoming song enters at
 * its first sound. With `beats` (Automix) the start slides earlier by under
 * one beat so the incoming song's beat lands on an outgoing beat: the beat
 * nearest the blend's middle when the tempos are within 4%, else its first
 * sound.
 */
export function planBlend(
  out: TrackAnalysis | null,
  outDuration: number,
  inc: TrackAnalysis | null,
  blendSec: number,
  edges: boolean,
  beats: boolean
): { outAt: number; inAt: number } {
  const inAt = edges ? (inc?.head ?? 0) : 0;
  let outAt = outDuration - (edges ? (out?.tail ?? 0) : 0) - blendSec;
  const outro = beats ? out?.outro : null;
  const intro = beats ? inc?.intro : null;
  if (outro && outro.bpm > 0) {
    const beat = 60 / outro.bpm;
    let lands = inAt;
    if (intro && intro.bpm > 0 && Math.abs(intro.bpm - outro.bpm) / outro.bpm <= 0.04) {
      const ib = 60 / intro.bpm;
      lands = intro.at + Math.max(0, Math.round((inAt + blendSec / 2 - intro.at) / ib)) * ib;
    }
    // Where the outgoing song is when the incoming one reaches `lands`, off its beat grid by `slip`.
    const slip = (((outAt + lands - inAt - outro.at) % beat) + beat) % beat;
    outAt -= slip;
  }
  return { outAt: Math.max(0, outAt), inAt };
}

/** Blends use the songs' real edges with Automix or Skip silence on. */
const blendEdges = (): boolean => {
  const s = playbackSettings();
  return s.smartFade || s.skipSilence;
};

function maybeArmTransition(): void {
  if (fade || armed) return;
  if (useSleepTimer.getState().endOfSong) return; // the music stops when this song ends
  const fadeMs = fadeMsForNext();
  if (fadeMs < 500) return;
  const state = usePlayer.getState();
  const nextTrack = upNext(state);
  if (!nextTrack) return;
  const a = el();
  const duration = Number.isFinite(a.duration) ? a.duration : 0;
  if (!duration || !state.playing) return;
  // Up to the end of the song's sound when the blend uses its edges.
  const tail = blendEdges() ? (peekAnalysis(state.queue[state.index].id)?.tail ?? 0) : 0;
  const remainingMs = (duration - tail - a.currentTime) * 1000;
  if (remainingMs > fadeMs + ARM_LEAD_MS || remainingMs <= 250) return;

  if (nextTrack.id === state.queue[state.index].id) return; // a second copy restarts from the top, never blends into itself
  if (failedBlend?.fromId !== loadedId) failedBlend = null;
  if (failedBlend?.toId === nextTrack.id) return;
  armed = { toId: nextTrack.id };
  void beginFade(nextTrack, fadeMs);
}

async function beginFade(nextTrack: Track, fadeMs: number): Promise<void> {
  const stand = standbyEl();
  const token = ++transitionToken;
  /** The arming this continuation belongs to is still the live one. */
  const stale = (): boolean => token !== transitionToken;
  try {
    // Local files load through their own route; streams through the proxy.
    const local = !!nextTrack.localPath || nextTrack.id.startsWith("local:");
    const url = local
      ? await requireBridge().localTrackUrl(nextTrack.id)
      : await requireBridge().getStreamUrl(nextTrack.id, false, useSettings.getState().streamingQuality);
    if (!url) throw new Error("next track has no source");
    // The fade's standby element carries the incoming track's own loudness
    // gain; the load-time prefetch usually already did this — cheap retry.
    if (local) levelLocal(nextTrack);
    else void fetchLoudness(url, nextTrack);
    // The world may have moved on while we resolved.
    const cur = usePlayer.getState().queue[usePlayer.getState().index];
    if (stale() || !armed || armed.toId !== nextTrack.id || fade || cur?.id === nextTrack.id) {
      armed = null;
      return;
    }
    // The plan needs the incoming song's edges and beats; if they aren't
    // analysed yet this is the moment (bounded by the arm window).
    const edges = blendEdges();
    if (edges) {
      await Promise.race([
        analyseTrack(nextTrack).catch(() => null),
        new Promise<void>((r) => window.setTimeout(r, 2200)),
      ]);
    }
    if (stale() || !armed || armed.toId !== nextTrack.id || fade) {
      armed = null;
      return;
    }
    const outgoing = el();
    const plan = planBlend(
      peekAnalysis(usePlayer.getState().queue[usePlayer.getState().index]?.id ?? ""),
      Number.isFinite(outgoing.duration) ? outgoing.duration : 0,
      peekAnalysis(nextTrack.id),
      fadeMs / 1000,
      edges,
      playbackSettings().smartFade
    );
    stand.src = url;
    stand.currentTime = plan.inAt;
    applySpeed();
    // The plan is in media time; the deck covers it faster or slower at other speeds.
    const waitMs = ((plan.outAt - outgoing.currentTime) * 1000) / (outgoing.playbackRate || 1);
    if (waitMs > 30) await new Promise<void>((r) => window.setTimeout(r, waitMs));
    if (stale() || fade) return;
    // If the user interacted meanwhile, re-check.
    const s2 = usePlayer.getState();
    if (upNext(s2)?.id !== nextTrack.id) {
      abortFade(false);
      return;
    }
    const main = el();
    if (!s2.playing) {
      armed = null;
      try {
        stand.pause();
      } catch {
        /* ignore */
      }
      return;
    }
    // Woke late: start the incoming song as far in, so the beats stay in phase.
    const late = main.currentTime - plan.outAt;
    if (late > 0.03) {
      try {
        stand.currentTime = plan.inAt + late;
      } catch {
        /* ignore */
      }
    }
    armed = null;
    fade = {
      fromId: s2.queue[s2.index].id,
      toId: nextTrack.id,
      to: nextTrack,
      startTs: performance.now(),
      durMs: fadeMs,
      pausedAt: null,
    };
    // A refused or failed start drops the blend (see the standby error listener).
    stand.play().catch((err: unknown) => {
      if (isAbortError(err) || fade?.toId !== nextTrack.id) return;
      failedBlend = { fromId: loadedId, toId: nextTrack.id };
      abortFade(false);
    });
    stopPpRamp();
    applyElementVolumes(1, 0);
    driveFade();
  } catch {
    // Resolution failed — the natural end path handles playback.
    armed = null;
  }
}

/** One 25ms tick of the equal-power ramp; finalizes the transition at the end. */
function driveFade(): void {
  if (fadeTimer != null) return;
  fadeTimer = window.setInterval(() => {
    if (!fade || !elements) {
      stopFadeTimer();
      return;
    }
    const state = usePlayer.getState();
    const cur = state.queue[state.index];
    // Interrupted by anything that changed the current track identity.
    if (!cur || cur.id !== fade.fromId) {
      abortFade(false);
      return;
    }
    // A track shorter than the blend runs out mid-transition. Promoting it
    // there is the only outcome that isn't a silent gap: the blend would
    // otherwise keep fading a deck with nothing left to fade in.
    if (standbyEl().ended) {
      completeTransition("incoming-ended");
      return;
    }
    // The blend freezes while paused (see the pause branch): hold the curve
    // and never finalize — finalize swaps roles and sets playing: true, which
    // force-resumed the next track after the user had paused.
    const clock = fade.pausedAt ?? performance.now();
    const p = Math.min(1, Math.max(0, (clock - fade.startTs) / fade.durMs));
    const theta = p * (Math.PI / 2);
    applyElementVolumes(Math.cos(theta), Math.sin(theta));
    // The equal-power crossover: the incoming song is the louder one from here,
    // so the cover and title move to it now rather than when the blend ends.
    if (p >= 0.5 && !fade.crossed) {
      fade.crossed = true;
      usePlayer.setState({ blendInto: fade.to });
    }
    if (p >= 1) {
      if (!state.playing) return;
      completeTransition("blend-complete");
    }
  }, 25);
}

function stopFadeTimer(): void {
  if (fadeTimer != null) {
    window.clearInterval(fadeTimer);
    fadeTimer = null;
  }
}

/**
 * The single, idempotent end of a transition.
 *
 * Both completion signals — the blend timer and the outgoing element's
 * `ended` — land here, so whichever wins, the deck that is already playing
 * the incoming track is the one that becomes the session player. Its media
 * element is kept as-is: same src, same playback position, still running.
 * Nothing is reloaded and `currentTime` is never rewritten.
 */
function completeTransition(
  reason: "blend-complete" | "outgoing-ended" | "incoming-ended",
  /** where the store already put the incoming track (a Next pressed mid-blend) */
  knownIndex?: number
): void {
  if (settling) return;
  const f = fade;
  if (!f) return;
  settling = true;
  fade = null;
  armed = null;
  stopFadeTimer();
  try {
    const state = usePlayer.getState();
    // The incoming track sits right after the outgoing one. An earlier copy of
    // the same id (a song replayed further back) must not win, or the index
    // jumps back and everything after it plays again.
    // Where the store already put it (Next pressed mid-blend), what follows the outgoing song (at a
    // shuffled repeat-all wrap the next pass's first), else wherever it is now.
    const known = knownIndex !== undefined && state.queue[knownIndex]?.id === f.toId;
    const follows = !known && upNext(state)?.id === f.toId;
    const ni = known ? knownIndex : state.queue.findIndex((t) => t.id === f.toId);
    if (ni < 0) {
      // The incoming track left the queue mid-blend (it was removed, or the
      // queue was truncated). Nothing owns that deck any more, so stop it —
      // leaving it playing would put a track in the air that the UI has no
      // record of — and hand the volume back to the outgoing one.
      const orphan = standbyEl();
      try {
        orphan.pause();
        orphan.removeAttribute("src");
        orphan.load();
      } catch {
        /* ignore */
      }
      applyElementVolumes(1, 0);
      if (usePlayer.getState().blendInto) usePlayer.setState({ blendInto: null });
      // The outgoing deck already ended: nothing else would move the queue on.
      if (reason === "outgoing-ended") usePlayer.getState().next(false);
      return;
    }
    // Role swap FIRST: the standby element IS the session player now, and the
    // outgoing main gets cleaned up only after it has been demoted.
    const oldMain = el();
    mainIdx = mainIdx === 0 ? 1 : 0;
    loadedId = f.toId;
    historyForId = f.toId;
    try {
      oldMain.pause();
      oldMain.removeAttribute("src");
      oldMain.load();
    } catch {
      /* ignore */
    }
    // The promoted deck's own clock is the authority for where this track is.
    // Read it before touching the store, and clamp: a deck that ran out early
    // can report a position at or past its duration, and a store position
    // beyond the media duration is what makes a later seek jump.
    const stand = el();
    const raw = stand.currentTime;
    const dur = Number.isFinite(stand.duration) ? stand.duration : Infinity;
    const pos = Number.isFinite(raw) ? Math.min(Math.max(raw, 0), Number.isFinite(dur) ? dur : Math.max(raw, 0)) : 0;
    flushAccum("stop");
    accum = { id: f.toId, playedMs: 0, pendingMs: 0, lastPos: pos };
    emitPlayEvent("start", f.to, pos, 0, 0);
    useLibrary.getState().pushHistory(f.to);
    advancingToId = f.toId;
    if (follows) usePlayer.getState().finishBlend(f.toId, pos);
    else usePlayer.setState({ index: ni, position: pos, playing: true, error: null, blendInto: null });
    advancingToId = null;
    // Volumes after the index update: the loudness gain is keyed by the current
    // track, and the engine-driven advance short-circuits the store subscription,
    // so this is the one place the new main's gain gets applied. The last fade
    // tick already left the elements at these levels — no jump.
    applyElementVolumes(1, 0);
    // The engine-driven advance skips the store subscriber: tell the OS what's
    // playing now, and warm the song after it.
    updateMediaSession(f.to);
    prefetchLoudness(upNext(usePlayer.getState()));
    // Listed without its length: its deck's durationchange came while it was the standby (see analyse).
    if (!f.to.duration) analyse(f.to);
    const edges = silenceEdges(f.toId);
    if (edges && edges.tail > 0.05) armSilenceTail(edges.tail);
  } finally {
    settling = false;
    transitionToken += 1;
  }
  // A deck promoted after it already ran out would stall the queue: its
  // `ended` fired while it was still the standby and nothing re-arms it. Hand
  // straight to the normal end path so playback keeps moving.
  if (reason === "incoming-ended") onTrackEnded();
}

function abortFade(keepRoles: boolean): void {
  const f = fade;
  const wasArmed = armed;
  fade = null;
  armed = null;
  stopFadeTimer();
  // Invalidate any arming still awaiting its start — its continuation must
  // not wake up and start a deck for a track the user already moved past.
  transitionToken += 1;
  if (usePlayer.getState().blendInto) usePlayer.setState({ blendInto: null });
  if ((!f && !wasArmed) || !elements) return;
  const oldStandby = standbyEl();
  try {
    oldStandby.pause();
    oldStandby.removeAttribute("src");
    oldStandby.load();
  } catch {
    /* ignore */
  }
  if (!keepRoles) applyElementVolumes(1, 0);
}

/* ============================ skip silence ============================ */

let silenceTailTimer: number | null = null;

/* -------- listening telemetry (feeds stats, scrobblers, Discord) -------- */
const PROGRESS_EVERY_MS = 5000;
interface Accum {
  id: string;
  /** total listening time on this track (drives scrobble thresholds) */
  playedMs: number;
  /** listening time not yet reported (never double-counted on pause) */
  pendingMs: number;
  lastPos: number;
}
let accum: Accum | null = null;

/** Fold a span of element time into the accumulator; emit on 5s boundaries. */
function accumulate(trackId: string, nowPos: number): void {
  const state = usePlayer.getState();
  if (!state.playing) return;
  const track = state.queue[state.index];
  if (!track || track.id !== trackId) return;
  if (!accum || accum.id !== trackId) accum = { id: trackId, playedMs: 0, pendingMs: 0, lastPos: nowPos };
  const delta = nowPos - accum.lastPos;
  // Seeks backwards / element resets must not register as listening time.
  if (delta > 0 && delta < 2.5) {
    accum.playedMs += delta * 1000;
    accum.pendingMs += delta * 1000;
  }
  accum.lastPos = nowPos;
  if (accum.pendingMs >= PROGRESS_EVERY_MS) {
    emitPlayEvent("progress", track, nowPos, accum.playedMs / 1000, Math.round(accum.pendingMs));
    accum.pendingMs = 0;
  }
}

/** The current track stopped being heard — flush what it earned. */
function flushAccum(type: "stop" | "pause"): void {
  if (!accum) return;
  const track = usePlayer.getState().queue.find((t) => t.id === accum!.id) ?? null;
  if (track && accum.pendingMs >= 500) {
    emitPlayEvent(type, track, accum.lastPos, accum.playedMs / 1000, Math.round(accum.pendingMs));
    accum.pendingMs = 0;
  }
  if (type === "stop") {
    // Every flush("stop") is a track switch — the one moment a skip is
    // knowable. "stop" is only ever sent here and at the crossfade swap.
    if (track && isEarlyExit(accum.playedMs / 1000, track.duration)) {
      useListening.getState().recordSkip(track);
    }
    // The Home algorithm's memory: finished, part-heard or skipped (stores/journal).
    if (track) useJournal.getState().record(track, accum.playedMs / 1000);
    accum = null;
  }
}

/** The app is quitting: bank the listening time this song has earned and go quiet at once. */
export function quitAudio(): void {
  flushAccum("pause");
  if (!elements) return;
  for (const a of [el(), standbyEl()]) {
    try {
      a.muted = true;
      a.pause();
    } catch {
      /* ignore */
    }
  }
}

function armSilenceTail(tailSec: number): void {
  disarmSilenceTail();
  const check = (): void => {
    // A paused element holds its position inside the tail zone — advancing
    // then would start the next track while the user asked for silence.
    if (!usePlayer.getState().playing) return;
    // A blend in flight owns the transition. Advancing here would land on the
    // track already fading in, tear the standby deck down and restart it from
    // zero — the same double-play the blend exists to prevent. The promoted
    // track re-arms its own tail when the blend completes.
    if (transitioning()) return;
    const cur = el();
    if (!Number.isFinite(cur.duration)) return;
    // The sound is over: repeat, stop for the sleep timer or move on, exactly as at the song's end.
    if (cur.currentTime >= cur.duration - tailSec - 0.05) onTrackEnded();
  };
  silenceTailTimer = window.setInterval(check, 500);
  void check();
}

function disarmSilenceTail(): void {
  if (silenceTailTimer != null) {
    window.clearInterval(silenceTailTimer);
    silenceTailTimer = null;
  }
}

/** Head silence trim applied for this track, if any (lyric offset math). */
export function getHeadTrim(trackId: string): number {
  return silenceEdges(trackId)?.head ?? 0;
}

/* ============================ engine boot ============================ */

export function initAudioEngine(): void {
  if (elements) return;
  const mk = (): HTMLAudioElement => {
    const a = new Audio();
    a.preload = "auto";
    // CORS mode, so the EQ graph can read the proxy's audio: a no-cors
    // cross-origin source feeds Web Audio silence. The proxy answers
    // Access-Control-Allow-Origin: * on every route.
    a.crossOrigin = "anonymous";
    return a;
  };
  elements = [mk(), mk()];
  applyElementVolumes(1, 0);
  applySpeed();
  applySink();

  for (let i = 0; i < 2; i++) {
    const e = elements[i];
    // Only the session player's clock drives the tick: onTimeUpdate and
    // updateBuffered read the main element, so standby events would run them
    // against the wrong element twice per update.
    let clockAt = 0;
    e.addEventListener("timeupdate", () => {
      if (i !== mainIdx) return;
      // A clock that moves is playing, whatever was last heard from the element: after a seek
      // GStreamer reports `waiting` and then often neither `canplay` nor `playing` (the element
      // never left the playing state), which left the play button's spinner turning for good.
      if (!e.seeking && !e.paused && e.currentTime > clockAt && usePlayer.getState().buffering) {
        usePlayer.getState()._setBuffering(false);
      }
      clockAt = e.currentTime;
      onTimeUpdate();
    });
    // The seek landed: paused, nothing else will say so; playing, the data is there or `waiting` follows.
    e.addEventListener("seeked", () => {
      if (i !== mainIdx) return;
      clockAt = e.currentTime;
      if (e.paused || e.readyState >= 3) usePlayer.getState()._setBuffering(false);
    });
    e.addEventListener("canplaythrough", () => {
      if (i === mainIdx) usePlayer.getState()._setBuffering(false);
    });
    e.addEventListener("progress", () => {
      if (i === mainIdx) updateBuffered();
    });
    e.addEventListener("waiting", () => {
      if (i === mainIdx) usePlayer.getState()._setBuffering(true);
    });
    e.addEventListener("canplay", () => {
      if (i === mainIdx) usePlayer.getState()._setBuffering(false);
    });
    e.addEventListener("playing", () => {
      if (eqCtx?.state === "suspended") void eqCtx.resume();
      if (i !== mainIdx) return;
      usePlayer.getState()._setBuffering(false);
      consecutiveFailures = 0;
      localMissingToasted = false;
      const cur = usePlayer.getState().queue[usePlayer.getState().index];
      if (cur && historyForId !== cur.id) {
        historyForId = cur.id;
        useLibrary.getState().pushHistory(cur);
        accum = { id: cur.id, playedMs: 0, pendingMs: 0, lastPos: el().currentTime };
        emitPlayEvent("start", cur, el().currentTime, 0, 0);
      } else if (cur) {
        emitPlayEvent("resume", cur, el().currentTime, (accum?.playedMs ?? 0) / 1000, 0);
      }
    });
    // Errors and natural ends must be caught on BOTH elements: after a
    // crossfade the other element becomes the session player.
    e.addEventListener("error", () => {
      if (i !== mainIdx) {
        // The standby deck failed while blending in: drop the blend so the
        // outgoing song plays out and the normal end path loads the next one.
        // Otherwise the music faded to silence and a dead deck was promoted.
        const toId = fade?.toId ?? armed?.toId;
        if (toId) {
          failedBlend = { fromId: loadedId, toId };
          abortFade(false);
        }
        return;
      }
      const cur = usePlayer.getState().queue[usePlayer.getState().index];
      if (!cur || loadedId !== cur.id) return;
      handleFailure(cur);
    });
    e.addEventListener("ended", () => {
      if (i !== mainIdx) return;
      onTrackEnded();
    });
    // A song listed without its length is analysed once its deck knows it (see analyse).
    e.addEventListener("durationchange", () => {
      const cur = usePlayer.getState().queue[usePlayer.getState().index];
      if (i === mainIdx && cur && !cur.duration && loadedId === cur.id) analyse(cur);
    });
  }



  usePlayer.subscribe((state, prev) => {
    if (!elements) return;
    const cur = state.queue[state.index] ?? null;
    const prevCur = prev.queue[prev.index] ?? null;

    // Moving between two copies of one song is a new track too (same queue, new index).
    if (cur?.id !== prevCur?.id || (state.queue === prev.queue && state.index !== prev.index)) {
      if (advancingToId && cur && advancingToId === cur.id) {
        // Engine-driven advance: roles already swapped; nothing to load.
        return;
      }
      // A jump to the track that is already fading in is not a new track — it
      // is the transition being called early. `next()` from the outgoing
      // track resolves to exactly that track, so the skip would otherwise
      // tear down a deck the listener is already hearing and replay it from
      // the top. Promote it instead: it becomes active once, where it is.
      if (fade && cur && cur.id === fade.toId) {
        completeTransition("outgoing-ended", state.index);
        return;
      }
      // Anything else is the user (or a settings/queue change) steering to a
      // different track. That is a deliberate cancellation, not a completion:
      // tear the standby deck down so its half-heard track cannot go on
      // playing alongside the new one.
      abortFade(false);
      stopPpRamp();
      flushAccum("stop");
      void loadTrack(cur, state.playing);
      return;
    }

    const blendTo = fade?.toId ?? armed?.toId;
    if (blendTo) {
      // Manual interference with a blend, armed or running: a seek aborts it,
      // and so does anything that changes what comes next (a song added in
      // front of the one fading in, that song removed, repeat turned off at
      // the wrap): the blend would land on the wrong track.
      if (state.seekNonce !== prev.seekNonce || upNext(state)?.id !== blendTo) {
        abortFade(false);
      }
    }

    if (state.queue !== prev.queue && cur && cur.id === prevCur?.id && state.position === 0 && prev.position > 3) {
      try {
        el().currentTime = 0;
      } catch {
        /* ignore */
      }
    }

    // A new song became next under the playing one (an AutoPlay refill, Play
    // next): warm it the way loadTrack does, so a skip or blend never waits.
    if (state.queue !== prev.queue && cur && loadedId === cur.id) {
      const following = upNext(state);
      if (following && following.id !== upNext(prev)?.id) prefetchLoudness(following);
    }

    if (state.playing !== prev.playing) {
      if (state.playing) {
        // Resuming mid-crossfade: shift the frozen fade timeline by the
        // paused span and bring the standby element back, so the blend
        // continues from where it froze instead of jumping to its end.
        const f = fade;
        if (f && f.pausedAt != null) {
          fade = { ...f, startTs: f.startTs + (performance.now() - f.pausedAt), pausedAt: null };
          const stand = standbyEl();
          if (stand.src) void stand.play().catch(() => undefined);
        }
        if (loadedId === cur?.id && el().src) {
          el().play().catch((err: unknown) => {
            // An aborted play() is a pause() or src change winning the race —
            // not a failure (see isAbortError).
            if (isAbortError(err)) return;
            handleFailure(cur, err);
          });
          // Spotify-style resume: the sound glides back in. Mid-crossfade the
          // blend owns the volumes — leave it alone.
          if (!fade) startPpRamp(1);
        } else if (cur) {
          stopPpRamp();
          void loadTrack(cur, true);
        }
      } else {
        flushAccum("pause");
        const f = fade;
        if (f) {
          stopPpRamp();
          el().pause();
          // Pausing holds both elements and freezes the blend: the fade
          // timeline stops with playback (pausedAt) and completes after
          // resume. Left running, the timer reached its end while paused and
          // finalizeFade force-resumed the next track over the pause.
          f.pausedAt = performance.now();
          standbyEl().pause();
          const t = Math.min(1, Math.max(0, (f.pausedAt - f.startTs) / f.durMs));
          const theta = t * (Math.PI / 2);
          applyElementVolumes(Math.cos(theta), Math.sin(theta));
        } else {
          // Spotify-style pause: glide to silence first; the ramp tick pauses
          // the element once it bottoms out (~PP_RAMP_MS later).
          startPpRamp(0);
        }
        if (state.position === 0 && state.duration === 0) disarmSilenceTail();
      }
    }

    refreshVolumes();

    if (state.seekNonce !== prev.seekNonce) {
      disarmSilenceTail();
      try {
        el().currentTime = state.position;
      } catch {
        /* ignore */
      }
      const edges = silenceEdges(cur?.id);
      if (edges && edges.tail > 0.05 && state.playing) armSilenceTail(edges.tail);
    }
  });

  // Playback speed lives in settings — re-apply whenever they change.
  useSettings.subscribe(() => applySpeed());
  // Entering or leaving a room changes the speed and blends in force (playbackSettings).
  useRoom.subscribe((s, prev) => {
    if (!s.view.state === !prev.view.state) return;
    applySpeed();
    if (s.view.state && (fade || armed)) abortFade(false);
  });
  // Same for the chosen output device.
  useSettings.subscribe(() => applySink());
  applyEq();
  useSettings.subscribe((st, prev) => {
    if (st.eqEnabled !== prev.eqEnabled || st.eqGains !== prev.eqGains || st.eqAutoHeadroom !== prev.eqAutoHeadroom) applyEq();
  });
  // Volume leveling level changes apply at once, a glide in progress included (the user's own change).
  useSettings.subscribe((st, prev) => {
    if (st.loudnessLevel !== prev.loudnessLevel) {
      glides.clear();
      refreshVolumes();
    }
  });
  // The sleep timer's closing fade.
  useSleepTimer.subscribe((s, prev) => {
    if (s.level !== prev.level) refreshVolumes();
    if (s.endOfSong && !prev.endOfSong && (fade || armed)) abortFade(false);
  });

  setupMediaSession();
  setupAudioOutputWatch();
}

/** The sleep timer's "end of this song": stop instead of moving on (no
 *  repeat, no next song, no AutoPlay). True when it stopped playback. */
function sleepStopsHere(): boolean {
  const sleep = useSleepTimer.getState();
  if (!sleep.endOfSong) return false;
  sleep.cancel();
  // In a room only this computer stops; the room plays on.
  stopHere({ until: "play" }, () => usePlayer.getState().setPlaying(false));
  return true;
}

function onTrackEnded(): void {
  const state = usePlayer.getState();
  const current = state.queue[state.index] ?? null;
  // The user (or a fade) already chose the next track while this element was
  // finishing - its natural end must not advance the queue again.
  if (!current || loadedId !== current.id) return;
  // A blend owns this transition: the next track is already PLAYING on the
  // standby deck and its media clock is authoritative. This element reaching
  // its natural end IS the transition completing, so promote that deck.
  //
  // Advancing the queue here instead re-entered the fresh-track path — it
  // reloaded the very track the listener is already hearing, on the deck that
  // had just been demoted, and restarted it at 0:00. That is the audible
  // "Auto Mix plays the first seconds of the next song twice" bug.
  if (fade && fade.fromId === current.id) {
    completeTransition("outgoing-ended");
    return;
  }
  if (sleepStopsHere()) return;
  // Repeat-one — and repeat-all on a one-song queue, where the next song is
  // this song again and the store sees no change to act on.
  if (state.repeat === "one" || (state.repeat === "all" && state.queue.length === 1)) {
    const a = el();
    a.currentTime = 0;
    void a.play().catch(() => undefined);
    return;
  }
  // At the end of the queue the store's next() hands over to AutoPlay
  // (lib/autoplay.ts), which normally has the next song queued already.
  state.next(false);
}

/** Called once after persisted state has been rehydrated. */
export function engineBoot(): void {
  initAudioEngine();
  const state = usePlayer.getState();
  const cur = state.queue[state.index] ?? null;
  if (cur) void loadTrack(cur, false);
}

async function loadTrack(track: Track | null, autoplay: boolean): Promise<void> {
  if (!elements) return;
  disarmSilenceTail();
  // A fresh load is a new playback session: any arming still waiting on a
  // start belongs to the previous track and must not fire.
  transitionToken += 1;
  armed = null;
  if (!track) {
    loadedId = null;
    historyForId = null;
    el().pause();
    el().removeAttribute("src");
    el().load();
    usePlayer.setState({ position: 0, duration: 0, buffered: 0, buffering: false, error: null });
    updateMediaSession(null);
    return;
  }
  loadedId = null;
  historyForId = null;
  glides.clear();
  retryCount = 0;
  retriedAt = -Infinity;
  // The store keeps the position until the deck plays from it: zeroing it here lost a saved resume
  // point whose song could not load yet (offline at launch), on screen, on disk and for the next play.
  pendingSeek = usePlayer.getState().position;
  usePlayer.setState({
    buffering: true,
    error: null,
    duration: track.duration || 0,
  });
  // The song's own stream first: analysis downloads the whole file, and starting it ahead competed
  // with the first audio bytes. Its findings still apply if they land early (see analyse).
  await loadUrl(track, autoplay, false);
  // Not for a song skipped while it loaded: its whole-file download would hold up the next one's.
  if (usePlayer.getState().queue[usePlayer.getState().index]?.id === track.id) analyse(track);
  // Pre-warm the next track: its proxy-side stream resolution (so a skip
  // never waits on a getBasicInfo + probe roundtrip) and its loudness (a
  // crossfade needs the gain the moment it starts). After loadUrl, so the
  // current track's resolution goes first.
  const st = usePlayer.getState();
  if (st.queue[st.index]?.id === track.id) prefetchLoudness(upNext(st));
}

/** Bumped by every load. A load whose source resolves after a newer one began leaves the deck to it:
 *  both setting the src lost the resume point (play pressed while the launch load resolved). */
let loadSeq = 0;

async function loadUrl(track: Track, autoplay: boolean, forceRotate: boolean): Promise<void> {
  if (!elements) return;
  const seq = ++loadSeq;
  try {
    if (track.localPath || track.id.startsWith("local:")) {
      const a = el();
      // Local files stream through the main-process proxy (a file:// src is
      // blocked from the http renderer origin). Always resolve fresh — the
      // proxy port changes between launches, so cached URLs would go stale,
      // and the IPC lookup is a local roundtrip.
      const src = await requireBridge().localTrackUrl(track.id);
      if (seq !== loadSeq) return;
      if (!src) throw new Error(LOCAL_MISSING);
      // Levels like a stream: by its ReplayGain tag, else a measurement; the
      // fallback gain covers the moment before.
      levelLocal(track);
      // Apply immediately: without this the element keeps the PREVIOUS
      // track's gain (streams land their own via fetchLoudness, locals
      // would otherwise never get a volume write).
      refreshVolumes();
      a.src = src;
      loadedId = track.id;
      if (pendingSeek > 0) {
        try {
          a.currentTime = pendingSeek;
        } catch {
          /* ignore */
        }
        pendingSeek = 0;
      }
      applySpeed();
      updateMediaSession(track);
      if (autoplay || usePlayer.getState().playing) {
        await a.play();
      } else {
        usePlayer.setState({ buffering: false });
      }
      return;
    }
    const url = await requireBridge().getStreamUrl(track.id, forceRotate, useSettings.getState().streamingQuality);
    const cur = usePlayer.getState().queue[usePlayer.getState().index];
    if (cur?.id !== track.id || seq !== loadSeq) return; // user moved on while we were resolving
    // Loudness metadata races the element's own first request: both share the
    // proxy's single in-flight resolution, so the measured gain lands with the
    // first audio chunk while the fallback gain covers the moment before.
    void fetchLoudness(url, track);
    const a = el();
    a.src = url;
    // Start at this track's own gain (cached or fallback) instead of the
    // previous track's — fetchLoudness refines it once metadata lands.
    refreshVolumes();
    loadedId = track.id;
    const trim = silenceEdges(track.id);
    if (pendingSeek > 0) {
      try {
        a.currentTime = pendingSeek;
      } catch {
        /* ignore */
      }
      pendingSeek = 0;
    } else if (trim && trim.head > 0.05) {
      try {
        a.currentTime = trim.head;
      } catch {
        /* ignore */
      }
    }
    applySpeed();
    updateMediaSession(track);
    if (autoplay || usePlayer.getState().playing) {
      await a.play();
    } else {
      usePlayer.setState({ buffering: false });
    }
    if (trim && trim.tail > 0.05 && usePlayer.getState().playing) armSilenceTail(trim.tail);
  } catch (err) {
    const cur = usePlayer.getState().queue[usePlayer.getState().index];
    if (cur?.id !== track.id || seq !== loadSeq) return;
    handleFailure(track, err);
  }
}

function handleFailure(track: Track, err?: unknown): void {
  const state = usePlayer.getState();
  if (state.queue[state.index]?.id !== track.id) return;
  usePlayer.setState({ buffering: false });
  // A failure while paused must never force playback: the retry used to load
  // with autoplay=true and start audio the user had stopped (also the landing
  // spot for play() promises aborted by an immediate pause). The next play
  // re-attempts the load from the top.
  if (!state.playing) return;
  const deckAt = el().currentTime;
  const at = deckAt > 1 ? deckAt : usePlayer.getState().position;
  // Once per song, and again for a long song or podcast that played on for
  // 30 s since; a failure straight after a retry skips instead of looping.
  if (retryCount < 1 || at - retriedAt > 30) {
    retryCount += 1;
    retriedAt = at;
    // Resume where the song was, not from 0:00 (a stream dying mid-song).
    pendingSeek = at;
    void loadUrl(track, true, true);
    return;
  }
  if (inRoom()) {
    // The room decides what plays: skipping here would skip the song for everyone. This computer sits
    // the song out and plays the room's next one (lib/rooms).
    console.warn(`[bytune] playback failed for ${track.id} (in a room)`, err);
    useUI.getState().toast(`Couldn't play "${shortTitle(track.title)}" on this computer. The room plays on.`, "error");
    stopHere({ until: "next song", song: track.id }, () => usePlayer.getState().setPlaying(false));
    return;
  }
  consecutiveFailures += 1;
  // A local: track that resolves to nothing means ByTune lost the file's
  // folder — a data reset, a fresh sign-in on this device, or the drive is
  // away. The entries survive in synced playlists, and re-importing the
  // folder relinks them (ids are hashes of the file's absolute path).
  const isLocal = !!track.localPath || track.id.startsWith("local:");
  // A missing file fails before the player even loads it, so a local song that
  // loaded and still failed (the retry found it too) is one it can't decode.
  const unreadable = isLocal && !(err instanceof Error && err.message === LOCAL_MISSING);
  const localGoneMsg = unreadable
    ? `Couldn't play "${shortTitle(track.title)}": ByTune can't play this file's format.`
    : `Couldn't play "${track.title}" — its local file can't be reached on this device. Re-add the folder in Local Music to relink your songs.`;
  if (state.playing && consecutiveFailures <= MAX_SKIPS) {
    console.warn(`[bytune] playback failed for ${track.id}`, err);
    if (isLocal) {
      // One explainer per failing streak — a whole playlist of unlinked
      // locals must not stack five identical toasts.
      if (!localMissingToasted) {
        localMissingToasted = true;
        useUI.getState().toast(localGoneMsg, "warning", 7000);
      }
    } else {
      useUI.getState().toast(`Couldn't play "${shortTitle(track.title)}" — skipping`, "error");
    }
    state.next(false);
  } else {
    usePlayer.setState({ playing: false, error: "Playback failed" });
    if (isLocal) {
      localMissingToasted = false;
      useUI.getState().toast(localGoneMsg, "warning", 7000);
    } else {
      useUI.getState().toast(`Couldn't play "${shortTitle(track.title)}"`, "error");
    }
  }
}

/* ------------------------- MediaSession ------------------------- */

let lastPositionState = 0;

function updateMediaSession(track: Track | null): void {
  window.bytune?.mediaSetMetadata(
    track ? { title: track.title, artist: track.artist, album: track.album || "ByTune", thumb: track.thumb } : null
  );
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  if (!track) {
    navigator.mediaSession.metadata = null;
    return;
  }
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album || "ByTune",
      artwork: [96, 192, 512].map((size) => ({
        src: upgradeArtwork(track.thumb),
        sizes: `${size}x${size}`,
        type: "image/jpeg",
      })),
    });
  } catch {
    /* ignore */
  }
}

function syncPositionState(): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  const a = el();
  if (!a || !Number.isFinite(a.duration) || a.duration <= 0) return;
  // Throttle: SMTC only needs coarse updates.
  if (Math.abs(a.currentTime - lastPositionState) < 0.75) return;
  lastPositionState = a.currentTime;
  window.bytune?.mediaSetPosition(Math.min(a.currentTime, a.duration), a.duration);
  try {
    navigator.mediaSession.setPositionState({
      duration: a.duration,
      playbackRate: a.playbackRate || 1,
      position: Math.min(a.currentTime, a.duration),
    });
  } catch {
    /* ignore */
  }
}

function setupMediaSession(): void {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  const actions = new Map<string, MediaSessionActionHandler>();
  const set = (name: MediaSessionAction, fn: MediaSessionActionHandler): void => {
    actions.set(name, fn);
    try {
      ms.setActionHandler(name, fn);
    } catch {
      /* unsupported action */
    }
  };
  // Physical media play/pause buttons (headset middle buttons, BT AVRCP, the
  // Windows media flyout) all arrive here as absolute play/pause actions —
  // there is no native double-press event, so repeated presses are recognized
  // as next-track at this layer (see media-key-tap.ts). The pressed command
  // is replayed rather than a toggle: the player's state may have moved
  // during the recognition window, and a stale absolute command is a no-op
  // against it while a toggle would fight it.
  const tap = createMediaKeyTap(
    {
      schedule: (fn, ms) => {
        const id = window.setTimeout(fn, ms);
        return () => window.clearTimeout(id);
      },
    },
    {
      single: (kind) => usePlayer.getState().setPlaying(kind === "play"),
      multi: () => usePlayer.getState().next(true),
    },
  );
  set("play", () => tap.press("play"));
  set("pause", () => tap.press("pause"));
  // A pending single press belongs to the pre-skip context; applying it after
  // the user already moved (or seeked) elsewhere would stop what they chose.
  set("previoustrack", () => {
    tap.cancelPending();
    usePlayer.getState().prev();
  });
  set("nexttrack", () => {
    tap.cancelPending();
    usePlayer.getState().next(true);
  });
  set("seekbackward", () => {
    tap.cancelPending();
    const s = usePlayer.getState();
    s.seek(Math.max(0, s.position - 10));
  });
  set("seekforward", () => {
    tap.cancelPending();
    const s = usePlayer.getState();
    s.seek(s.position + 10);
  });
  set("seekto", (details) => {
    tap.cancelPending();
    if (details.seekTime != null) usePlayer.getState().seek(details.seekTime);
  });
  // Windows: the flyout and media keys talk to ByTune's own session
  // (electron/media-controls.ts) and land on these same handlers.
  window.bytune?.onMediaAction((a) =>
    actions.get(a.action)?.({ action: a.action, seekTime: a.seekTime } as MediaSessionActionDetails)
  );
  window.setInterval(syncPositionState, 1000);
}

/**
 * Pause when the output the listener is hearing disappears.
 *
 * Chromium re-routes live audio to the new Windows default endpoint on its
 * own — that's why audio used to fall back to the PC speakers when a
 * headset was unplugged mid-song. There is no removal event; `devicechange`
 * fires and enumeration tells us whether the previous default's backing
 * device is still connected (the logic lives in audio-output.ts). Every
 * other case — connecting a device, intentional switching while both stay
 * alive, an unrelated microphone leaving — leaves the old default's group
 * in the list and playback untouched.
 *
 * The pause goes through setPlaying(false): the same path as the UI button,
 * so an in-flight crossfade freezes cleanly with it and resume stays valid.
 */
function setupAudioOutputWatch(): void {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
  // WebKitGTK lists no audio outputs and can't pick one (no setSinkId), so there is nothing to watch —
  // yet enumerating starts GStreamer's device monitor in the renderer (cameras, capture cards, a
  // PipeWire portal connection that can time out) and keeps it running for `devicechange`.
  if (typeof (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId !== "function") return;
  const md = navigator.mediaDevices;
  let prev: OutputSnapshot | null = null;
  let running = false;
  let rerun = false;
  const refresh = async (): Promise<void> => {
    // Serialize: overlapping enumerations could apply an older view last.
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      do {
        rerun = false;
        // "The output the listener is hearing" is the user's chosen sink when
        // one is set, else the system default — see snapshotOutputs.
        const sink = useSettings.getState().audioSinkId;
        const snap = snapshotOutputs(await md.enumerateDevices(), sink);
        // Playing is read after the await — it may have moved while enumerating.
        if (outputChangeAction(prev, snap, usePlayer.getState().playing, sink) === "pause") {
          // In a room only this computer stops; the room plays on.
          stopHere({ until: "play" }, () => usePlayer.getState().setPlaying(false));
          if (sink) {
            // The chosen device is gone; fall back to the system default so
            // the next resume is audible instead of routing into the void.
            useSettings.getState().setAudioSinkId("");
          }
        }
        // Re-assert the chosen sink after any device-list change — Windows
        // hands a reconnecting Bluetooth device a NEW endpoint id, which
        // quietly invalidates the previously-applied sink.
        applySink();
        prev = snap;
      } while (rerun);
    } catch {
      /* enumeration is best-effort; keep the last snapshot */
    } finally {
      running = false;
    }
  };
  md.addEventListener("devicechange", () => void refresh());
  void refresh();
}
