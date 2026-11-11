/**
 * Song analysis, scaled to what a browser can do honestly: analyseTrack makes
 * one decode per song (22.05 kHz; 11.025 kHz past 10 min) and finds its silent
 * edges, music onset, integrated loudness (BS.1770) and beat grids at the
 * intro and outro (onset-energy autocorrelation, then a comb fit of period and
 * phase). Skip silence, Automix, leveling and lyrics timing all read it. No
 * vocal mask or mel spectrogram — those need native DSP and are not faked.
 *
 * decodeAudioData runs off the main thread, and the analysis runs on it in
 * slices of a few milliseconds with background-priority yields between them,
 * so the crossfade's 25 ms tick, input and frames keep their pace. One song is
 * analysed at a time and only the newest few wait, so skipping through songs
 * never piles up work.
 */

const MAX_CACHE = 400;

async function fetchAudio(trackId: string, localPath?: string, maxBytes = Infinity): Promise<ArrayBuffer | null> {
  const ctl = new AbortController();
  try {
    const { requireBridge } = await import("./bridge");
    const { useSettings } = await import("../stores/settings");
    const bridge = requireBridge();
    // Local files analyse through the same proxy route the element plays.
    const url = localPath || trackId.startsWith("local:")
      ? await bridge.localTrackUrl(trackId)
      : await bridge.getStreamUrl(trackId, false, useSettings.getState().streamingQuality);
    if (!url) return null;
    // A ranged request, like the media element's: googlevideo throttles a plain GET to playback speed.
    const res = await fetch(url, { headers: { Range: "bytes=0-" }, signal: ctl.signal });
    if (!res.ok || !res.body) return null;
    // Give up before downloading: the whole file is decoded in memory.
    if (Number(res.headers.get("content-length")) > maxBytes) return null;
    // ...and while downloading, when no length (or a wrong one) was announced.
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      size += r.value.byteLength;
      if (size > maxBytes) return null;
      parts.push(r.value);
    }
    const all = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      all.set(part, at);
      at += part.byteLength;
    }
    return all.buffer;
  } catch {
    return null;
  } finally {
    ctl.abort(); // ends a download given up on; a no-op once it completed
  }
}

async function decode(buf: ArrayBuffer, rate = 44100): Promise<AudioBuffer | null> {
  try {
    // decodeAudioData resamples to the context's rate.
    const ctx = new OfflineAudioContext(1, 1, rate);
    return await ctx.decodeAudioData(buf);
  } catch {
    return null;
  }
}

/** The first two channels: everything here analyses L/R only. */
function channelsOf(audio: AudioBuffer): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < Math.min(2, audio.numberOfChannels); c++) out.push(audio.getChannelData(c));
  return out;
}

/**
 * Onset strength of the L/R mix over samples [from, to): energy envelope
 * (window = 2 hops) + half-wave-rectified difference, one value per hop.
 * Value f is the rise into frame f+1, i.e. the hop of samples starting at
 * from + (f + 2) * hop. Null under 64 frames.
 */
function onsetEnvelope(chans: Float32Array[], from: number, to: number, hop: number): Float32Array | null {
  const win = hop * 2;
  const frames = Math.floor((to - from - win) / hop);
  if (frames < 64) return null;
  const left = chans[0];
  const right = chans.length > 1 ? chans[1] : null;
  const onset = new Float32Array(frames - 1);
  let prev = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const base = from + f * hop;
    for (let i = base; i < base + win; i++) {
      const v = right ? (left[i] + right[i]) / 2 : left[i];
      sum += v * v;
    }
    const energy = Math.sqrt(sum / win);
    if (f > 0) onset[f - 1] = Math.max(0, energy - prev);
    prev = energy;
  }
  return onset;
}

/** Coarse tempo from an onset envelope's autocorrelation, folded into 85..180 BPM. */
function autocorrTempo(env: Float32Array, fps: number): { bpm: number; confidence: number } | null {
  let onsetMean = 0;
  for (let f = 0; f < env.length; f++) onsetMean += env[f];
  onsetMean = onsetMean / Math.max(1, env.length) || 1e-9;
  const onset = env.map((v) => v - onsetMean);

  // Autocorrelation over lags matching 50..220 BPM.
  const minLag = Math.floor((60 / 220) * fps);
  const maxLag = Math.ceil((60 / 50) * fps);
  let bestLag = 0;
  let bestVal = 0;
  let sumSq = 0;
  for (let f = 0; f < onset.length; f++) sumSq += onset[f] * onset[f];
  if (sumSq <= 0) return null;
  for (let lag = minLag; lag <= maxLag && lag < onset.length; lag++) {
    let dot = 0;
    for (let f = 0; f + lag < onset.length; f++) dot += onset[f] * onset[f + lag];
    const norm = dot / Math.sqrt(sumSq * sumSq) * onset.length;
    // Prefer multiples near 90–180 BPM (octave disambiguation).
    let bpm = (60 * fps) / lag;
    while (bpm < 85) bpm *= 2;
    while (bpm > 180) bpm /= 2;
    const octaveWeight = bpm >= 85 && bpm <= 180 ? 1 : 0.55;
    const val = norm * octaveWeight;
    if (val > bestVal) {
      bestVal = val;
      bestLag = lag;
    }
  }
  if (!bestLag) return null;
  let bpm = (60 * fps) / bestLag;
  while (bpm < 85) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  const confidence = Math.min(1, Math.max(0, bestVal));
  if (confidence < 0.08) return null;
  return { bpm, confidence };
}

/** detectMusicOnset over raw channels; null when no sustained music shows up. */
function musicOnset(chans: Float32Array[], sr: number, limitSec = 75): number | null {
  const win = Math.floor(sr * 0.5);
  const total = Math.min(chans[0].length, Math.floor(sr * limitSec));
  const windows = Math.floor(total / win);
  if (windows < 8) return null;
  const threshold = 0.055;
  const need = 4; // 2s of consecutive loud windows
  let run = 0;
  const data = chans[0];
  const data2 = chans.length > 1 ? chans[1] : null;
  for (let w = 0; w < windows; w++) {
    let sum = 0;
    const base = w * win;
    for (let i = 0; i < win; i += 2) {
      const v = data2 ? (data[base + i] + data2[base + i]) / 2 : data[base + i];
      sum += v * v;
    }
    const rms = Math.sqrt((sum * 2) / win);
    if (rms > threshold) {
      run += 1;
      if (run >= need) return Math.max(0, (w - need + 1) * win) / sr;
    } else {
      run = 0;
    }
  }
  return null;
}

/**
 * ITU-R BS.1770-4 integrated loudness (LKFS ≈ LUFS) — the same measurement
 * Spotify and YouTube use, so local files normalise on identical terms to
 * streams. K-weighting is two biquad stages whose coefficients are computed
 * from the standard's analogue parameters for the buffer's sample rate
 * (exactly how libebur128 does it); loudness is then the gated mean-square of
 * 400ms blocks with 75% overlap (absolute gate -70 LUFS, relative gate -10 LU).
 * At 48 kHz the stages equal the standard's published coefficients, and a
 * 1 kHz sine at amplitude 0.2 measures -14.0 LUFS (theoretical -13.98). (The
 * RBJ cookbook shelf with these parameters reads ~0.26 dB low at 1 kHz.)
 */
function highShelfCoefs(f0: number, dbGain: number, q: number, fs: number): number[] {
  const k = Math.tan((Math.PI * f0) / fs);
  const vh = Math.pow(10, dbGain / 20);
  const vb = Math.pow(vh, 0.4996667741545416);
  const a0 = 1 + k / q + k * k;
  return [
    (vh + (vb * k) / q + k * k) / a0,
    (2 * (k * k - vh)) / a0,
    (vh - (vb * k) / q + k * k) / a0,
    (2 * (k * k - 1)) / a0,
    (1 - k / q + k * k) / a0,
  ];
}

function highPassCoefs(f0: number, q: number, fs: number): number[] {
  const k = Math.tan((Math.PI * f0) / fs);
  const a0 = 1 + k / q + k * k;
  // The standard's numerator is [1, -2, 1], unnormalised.
  return [1, -2, 1, (2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0];
}

export interface TrackAnalysis {
  head: number; // seconds of leading silence (song's own clock)
  tail: number; // seconds of trailing silence
  lufs: number | null; // integrated loudness (BS.1770, gated); null when silent/unmeasurable
  onset: number | null; // first musical onset, seconds
  intro: { bpm: number; at: number } | null; // beat grid over ~15 s after `head`; `at` = first beat at/after head
  outro: { bpm: number; at: number } | null; // beat grid over ~15 s before the end of sound; `at` = last beat before the end of sound
}

/** Samples of the main pass between yields: well under a millisecond. */
const BLOCK = 1 << 15;
/** Main-thread time an analysis slice may take before it yields. */
const SLICE_MS = 4;

/** One channel's K-weighting filter state, carried from one block to the next. */
interface Weighing {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  z1: number;
  z2: number;
  acc: number;
  k: number;
  j: number;
  dn: number;
}

/**
 * Samples [from, to) of one channel through both K-weighting stages into the
 * 100 ms sub-block energies, widening `edges` to the first and last sample
 * above the edge scan's threshold. `st` carries the filter between blocks.
 */
function weigh(
  d: Float32Array,
  from: number,
  to: number,
  f: number[],
  sub: number,
  energy: Float64Array,
  st: Weighing,
  edges: { first: number; last: number }
): void {
  const [b0, b1, b2, a1, a2, c0, c1, c2, d1, d2] = f;
  let { x1, x2, y1, y2, z1, z2, acc, k, j, dn } = st;
  let { first, last } = edges;
  for (let i = from; i < to; i++) {
    const s = d[i];
    if (s > 0.008 || s < -0.008) { // ≈ -42 dBFS, the edge scan's threshold
      if (i < first) first = i;
      if (i > last) last = i;
    }
    dn = -dn;
    const x0 = s + dn;
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    const z0 = c0 * y0 + c1 * y1 + c2 * y2 - d1 * z1 - d2 * z2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0; z2 = z1; z1 = z0;
    acc += z0 * z0;
    if (++k === sub) {
      energy[j++] += acc;
      acc = 0;
      k = 0;
    }
  }
  Object.assign(st, { x1, x2, y1, y2, z1, z2, acc, k, j, dn });
  Object.assign(edges, { first, last });
}

/**
 * Everything analyseTrack reports, from decoded channels (L/R used), as steps:
 * one pass per channel finds the silent edges and runs both K-weighting stages
 * into 100 ms sub-block energies, a block at a time; the onset and beat grids
 * then read only the first 75 s and two ~15 s windows.
 */
function* analysisSteps(channels: Float32Array[], sampleRate: number): Generator<void, TrackAnalysis, void> {
  const chans = channels.slice(0, 2);
  const sr = sampleRate;
  const n = chans[0].length;
  const f = [
    ...highShelfCoefs(1681.974450955533, 3.999843853973347, 0.7071752369554196, sr),
    ...highPassCoefs(38.13547087602444, 0.5003270373238773, sr),
  ];
  const sub = Math.floor(sr / 10);
  const energy = new Float64Array(Math.floor(n / sub)); // summed over channels: G = 1 for L/R
  const edges = { first: n, last: -1 };
  for (const d of chans) {
    // ±1e-20 at Nyquist keeps the filter state out of subnormal floats, which
    // run ~10x slower after every burst; it sits ~140 dB under the -70 gate.
    const st: Weighing = { x1: 0, x2: 0, y1: 0, y2: 0, z1: 0, z2: 0, acc: 0, k: 0, j: 0, dn: 1e-20 };
    for (let at = 0; at < n; at += BLOCK) {
      weigh(d, at, Math.min(n, at + BLOCK), f, sub, energy, st, edges);
      yield;
    }
  }
  const { first, last } = edges;

  // Edges keep the scan's 40 ms window as margin around the first/last loud sample.
  const margin = Math.max(1, Math.floor(sr * 0.04));
  const headAt = last < 0 ? 0 : Math.max(0, first - margin);
  const endAt = last < 0 ? n : Math.min(n, last + margin + 1);

  // 400 ms blocks are 4 sub-blocks (75% overlap); mean square over blocks above `floor`.
  const gatedMean = (floor: number): number => {
    let sum = 0;
    let count = 0;
    for (let b = 0; b + 4 <= energy.length; b++) {
      const z = (energy[b] + energy[b + 1] + energy[b + 2] + energy[b + 3]) / (4 * sub);
      if (z > floor) {
        sum += z;
        count++;
      }
    }
    return count ? sum / count : 0;
  };
  const absGate = Math.pow(10, (-70 + 0.691) / 10);
  const absMean = sr >= 8000 && n >= sr ? gatedMean(absGate) : 0;
  // The relative gate sits 10 LU under the absolute-gated loudness.
  const lufs = absMean > 0 ? -0.691 + 10 * Math.log10(gatedMean(Math.max(absGate, absMean / 10))) : null;

  const span = Math.round(15 * sr);
  const onset = musicOnset(chans, sr);
  yield;
  const intro = beatGrid(chans, sr, headAt, Math.min(endAt, headAt + span), headAt, true);
  yield;
  const outro = beatGrid(chans, sr, Math.max(headAt, endAt - span), endAt, endAt, false);
  return { head: headAt / sr, tail: (n - endAt) / sr, lufs, onset, intro, outro };
}

/** analyseTrack's measurements of decoded channels, in one go. */
export function analyseBuffer(channels: Float32Array[], sampleRate: number): TrackAnalysis {
  const steps = analysisSteps(channels, sampleRate);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

type PostTask = (callback: () => void, options: { priority: "background" }) => Promise<void>;

/** Lets everything else queued run first: due timers (the crossfade tick), input, frames. */
function breathe(): Promise<void> {
  // Not scheduler.yield(): its continuation runs ahead of timers and starved the 25 ms tick.
  const scheduler = (globalThis as { scheduler?: { postTask?: PostTask } }).scheduler;
  return scheduler?.postTask
    ? scheduler.postTask(() => undefined, { priority: "background" })
    : new Promise((resolve) => setTimeout(resolve, 0));
}

/** analyseBuffer in slices of about `sliceMs`, yielding to queued tasks between them. Same results. */
export async function analyseInSlices(channels: Float32Array[], sampleRate: number, sliceMs = SLICE_MS): Promise<TrackAnalysis> {
  const steps = analysisSteps(channels, sampleRate);
  for (;;) {
    const stop = performance.now() + sliceMs;
    for (;;) {
      const r = steps.next();
      if (r.done) return r.value;
      if (performance.now() >= stop) break;
    }
    await breathe();
  }
}

/**
 * Beat grid over samples [lo, hi): coarse tempo from the autocorrelation, then
 * period (±3% in 0.1% steps) and phase fitted together with a comb over the
 * onset envelope. `at` is the grid's first beat at/after `anchor` (or its last
 * beat before it), snapped to the envelope peak within ±2 frames.
 */
function beatGrid(chans: Float32Array[], sr: number, lo: number, hi: number, anchor: number, first: boolean): { bpm: number; at: number } | null {
  const hop = Math.round(sr / 86);
  // A few hops of slack so a beat right at either edge still registers.
  const from = Math.max(0, lo - 4 * hop);
  const env = onsetEnvelope(chans, from, Math.min(chans[0].length, hi + 4 * hop), hop);
  // In pure silence the autocorrelation's mean fallback would "find" a tempo.
  if (!env || !env.some((v) => v > 0)) return null;
  const fps = sr / hop;
  const coarse = autocorrTempo(env, fps);
  if (!coarse) return null;
  const p0 = (60 * fps) / coarse.bpm;
  let best = -1;
  let period = p0;
  let phase = 0;
  for (let step = -30; step <= 30; step++) {
    const p = p0 * (1 + step / 1000);
    for (let ph = 0; ph < p; ph++) {
      let sum = 0;
      let count = 0;
      for (let x = ph; x < env.length - 0.5; x += p) {
        sum += env[Math.round(x)];
        count++;
      }
      // Mean, not sum: a shorter period would otherwise win on beat count alone.
      if (sum / count > best) {
        best = sum / count;
        period = p;
        phase = ph;
      }
    }
  }
  // Envelope value f covers the hop starting at from + (f + 2) * hop; f maps to its middle.
  const a = (anchor - from) / hop - 2.5;
  // Half a frame of slack: the phase is whole frames, and a song can open on a beat.
  const beat = phase + (first ? Math.ceil((a - 0.5 - phase) / period) : Math.ceil((a - phase) / period) - 1) * period;
  // Snap to the strongest onset within ±2 frames; with none there (e.g. a beat
  // before the envelope's first frame) the grid's own position stands.
  let at = beat;
  let peak = 0;
  for (let f = Math.max(0, Math.round(beat) - 2); f <= Math.min(env.length - 1, Math.round(beat) + 2); f++) {
    if (env[f] > peak) {
      peak = env[f];
      at = f;
    }
  }
  return { bpm: (60 * fps) / period, at: Math.max(0, (from + (at + 2.5) * hop) / sr) };
}

/** What analyseTrack needs to know about a song. */
interface SongRef {
  id: string;
  duration?: number;
  localPath?: string;
}

interface Job {
  track: SongRef;
  promise: Promise<TrackAnalysis | null>;
  resolve: (result: TrackAnalysis | null) => void;
}

const MAX_WAITING = 3;
const MAX_BYTES = 150 * 1024 * 1024;
const results = new Map<string, TrackAnalysis>(); // LRU: most recently used last
const jobs = new Map<string, Job>(); // waiting or running, shared by concurrent callers
const waiting: Job[] = []; // oldest first
let draining = false;

/** Cached analysis, or null; never fetches. */
export function peekAnalysis(id: string): TrackAnalysis | null {
  const hit = results.get(id);
  if (!hit) return null;
  results.delete(id);
  results.set(id, hit);
  return hit;
}

/**
 * The song's shared analysis: one download, one decode. One runs at a time;
 * only the newest few requests wait (older ones resolve null). Failures are
 * not cached, so a later request retries.
 */
export function analyseTrack(track: SongRef): Promise<TrackAnalysis | null> {
  const hit = peekAnalysis(track.id);
  if (hit) return Promise.resolve(hit);
  // Only with a known length: the decode is held in memory, and hour-long mixes would cost hundreds of MB.
  const length = track.duration ?? 0;
  if (!(length >= 10 && length <= 20 * 60)) return Promise.resolve(null);
  const live = jobs.get(track.id);
  if (live) {
    // Asked again: it counts as new, so it outlives older waiting requests.
    const at = waiting.indexOf(live);
    if (at >= 0) waiting.push(...waiting.splice(at, 1));
    return live.promise;
  }
  let resolve!: (result: TrackAnalysis | null) => void;
  const promise = new Promise<TrackAnalysis | null>((r) => (resolve = r));
  const job: Job = { track, promise, resolve };
  jobs.set(track.id, job);
  waiting.push(job);
  while (waiting.length > MAX_WAITING) settleJob(waiting.shift()!, null);
  void drainJobs();
  return promise;
}

function settleJob(job: Job, result: TrackAnalysis | null): void {
  if (jobs.get(job.track.id) === job) jobs.delete(job.track.id);
  if (result) {
    results.set(job.track.id, result);
    if (results.size > MAX_CACHE) results.delete(results.keys().next().value!);
  }
  job.resolve(result);
}

async function drainJobs(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    while (waiting.length) {
      const job = waiting.shift()!;
      let result: TrackAnalysis | null = null;
      try {
        result = await runAnalysis(job.track);
      } catch {
        /* analysis is best-effort */
      }
      settleJob(job, result);
    }
  } finally {
    draining = false;
  }
}

async function runAnalysis(track: SongRef): Promise<TrackAnalysis | null> {
  const buf = await fetchAudio(track.id, track.localPath, MAX_BYTES);
  if (!buf) return null;
  // Past 10 min half the rate halves the decoded copy; beats and loudness survive it.
  const audio = await decode(buf, (track.duration ?? 0) > 600 ? 11025 : 22050);
  if (!audio || !audio.length) return null;
  return analyseInSlices(channelsOf(audio), audio.sampleRate);
}
