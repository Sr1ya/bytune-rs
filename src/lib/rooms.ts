/**
 * Rooms on the player's side. The room (electron/rooms.ts) is the authority on what plays: its state
 * is applied to the player here, and what the listener does while in one (another song, play, pause,
 * a seek, the queue) is sent to the room rather than just happening here. A start or a seek waits for
 * the room's answer, which anchors it 600 ms ahead, so it begins on everyone's computer at once.
 *
 * While in a room the listener's own queue is set aside (room:stash) and comes back on leaving;
 * crossfade, Automix, skip silence, playback speed and AutoPlay sit out (inRoom, read by lib/audio and
 * lib/autoplay), shuffle and repeat are off, and songs from this computer can't play.
 */
import { hasBridge, requireBridge } from "./bridge";
import { ipcMessage } from "./spotify";
import { MAX_ROOM_QUEUE, offBy, roomCodeIn, roomPosition } from "./roomSync";
import { usePlayer, type RepeatMode } from "../stores/player";
import { inRoom, stoppingHere, useRoom, type LocalStop } from "../stores/room";
import { useUI } from "../stores/ui";
import type { RoomChange, RoomView, Track } from "../types";

const isLocal = (t: Track | null | undefined): boolean => !!t && (t.id.startsWith("local:") || !!t.localPath);
const ids = (list: readonly Track[]): string => list.map((t) => t.id).join(" ");
const toast = (text: string, kind: "info" | "error" = "info"): void => useUI.getState().toast(text, kind);

/** What of the player's upcoming songs the room gets: none from this computer, and only as many as it holds. */
const roomQueue = (p: { queue: Track[]; index: number }): Track[] =>
  p.queue
    .slice(p.index + 1)
    .filter((t) => !isLocal(t))
    .slice(0, MAX_ROOM_QUEUE);

/** True while the room's state is being applied: those player changes are the room's, not the listener's. */
let applying = false;
/** Set while the room's start is still ahead: the player waits for it paused. */
let startTimer = 0;
/** This computer stopped on its own (stores/room stopHere): it follows the room quietly, not playing. */
let sittingOut: LocalStop | null = null;

function cancelStart(): void {
  window.clearTimeout(startTimer);
  startTimer = 0;
}

function quietly(change: () => void): void {
  applying = true;
  try {
    change();
  } finally {
    applying = false;
  }
}

/** Puts the player where the room is: its song, its queue, its moment, playing or not. */
function apply(view: RoomView): void {
  const s = view.state;
  if (!s) return;
  cancelStart();
  // A song this computer couldn't play is behind it once the room has moved on.
  if (sittingOut?.until === "next song" && sittingOut.song !== s.track?.id) sittingOut = null;
  const at = roomPosition(s, Date.now() + view.offsetMs);
  const playing = s.playing && !sittingOut;
  const startNow = playing && at.startsInMs === 0;
  quietly(() => {
    const p = usePlayer.getState();
    const current = p.queue[p.index];
    if (!s.track) {
      if (p.playing) p.setPlaying(false);
      return;
    }
    if (current?.id !== s.track.id) {
      // One change: the engine loads the song from `position` (its resume point), paused or playing.
      usePlayer.setState({
        queue: [s.track, ...s.queue],
        index: 0,
        position: at.ms / 1000,
        playing: startNow,
        error: null,
        autoplayCount: 0,
        awaitingAutoplay: false,
        contextId: p.contextId + 1,
        playingFrom: null,
        unshuffled: null,
      });
    } else {
      if (ids(p.queue.slice(p.index + 1)) !== ids(s.queue)) {
        usePlayer.setState({ queue: [...p.queue.slice(0, p.index + 1), ...s.queue], autoplayCount: 0 });
      }
      if (offBy(p.position * 1000, at.ms)) p.seek(at.ms / 1000);
      if (p.playing !== startNow) usePlayer.getState().setPlaying(startNow);
    }
  });
  // A start anchored ahead: everyone begins at the same moment.
  if (playing && at.startsInMs > 0) {
    startTimer = window.setTimeout(() => {
      startTimer = 0;
      if (useRoom.getState().view.state?.seq === s.seq && !sittingOut) quietly(() => usePlayer.getState().setPlaying(true));
    }, at.startsInMs);
  }
}

/* ---------------- what the listener does, sent to the room ---------------- */

/** `says`: what the listener is told when it goes (songs of theirs that stay out of the room). */
let intent: { lead: boolean; note: string; says: string[] } | null = null;
let sending: Promise<void> = Promise.resolve();
/** A change is on its way to the room: nothing may put the player back meanwhile. */
let inFlight = false;

/** Collects one action's changes (it may make several) and sends them once. */
function propose(lead: boolean, note: string, says: string[] = []): void {
  const first = !intent;
  intent = intent
    ? { lead: intent.lead || lead, note: note || intent.note, says: [...new Set([...intent.says, ...says])] }
    : { lead, note, says };
  if (first) queueMicrotask(() => (sending = sending.then(send)));
}

async function send(): Promise<void> {
  const want = intent;
  intent = null;
  const room = useRoom.getState().view;
  const s = room.state;
  if (!want || !s) return;
  if (s.hostOnly && room.me !== s.hostId) {
    toast("Only the host controls the music in this room");
    apply(room);
    return;
  }
  const p = usePlayer.getState();
  const track = p.queue[p.index] ?? null;
  if (isLocal(track)) {
    toast("Songs from this computer can't play in a room");
    apply(room);
    return;
  }
  // Said only for songs the listener added: one played from a playlist that has a few just leaves them out.
  for (const text of want.says) toast(text);
  const queue = roomQueue(p);
  // Stopped here only to wait for the room's common start, or on its own (stopHere): for the room
  // it's still playing.
  const playing = p.playing || (s.playing && (startTimer !== 0 || sittingOut !== null));
  // Nothing new for the room (none of the songs added could go in): the queue goes back to the room's.
  if (!want.lead && !want.note && track?.id === s.track?.id && playing === s.playing && ids(queue) === ids(s.queue)) {
    apply(room);
    return;
  }
  const change: RoomChange = {
    baseSeq: s.seq,
    track,
    positionMs: Math.round(p.position * 1000),
    playing,
    queue,
    lead: want.lead && playing,
    note: want.note,
  };
  // A start or a seek waits here for the room's moment, so it starts with everyone else.
  if (change.lead) quietly(() => usePlayer.getState().setPlaying(false));
  inFlight = true;
  try {
    const view = await requireBridge().roomUpdate(change);
    useRoom.setState({ view });
    inFlight = false;
    apply(view);
  } catch (err) {
    inFlight = false;
    toast(ipcMessage(err, "The room didn't take that"), "error");
    apply(useRoom.getState().view);
  }
}

function watchPlayer(): () => void {
  return usePlayer.subscribe((p, prev) => {
    if (applying || !inRoom()) return;
    const here = stoppingHere();
    if (here) {
      // Stopped on this computer only: the room plays on without it.
      if (prev.playing && !p.playing) sittingOut = here;
      return;
    }
    // Play, another song, next: the listener wants to hear the room again.
    if (p.playing && !prev.playing) sittingOut = null;
    const cur = p.queue[p.index];
    const before = prev.queue[prev.index];
    // Every computer reaches a song's end together: moving on (or stopping at the queue's end) needs
    // no common start, and nobody did it.
    const ended = !!before && prev.duration > 0 && prev.position >= prev.duration - 2;
    if (cur?.id !== before?.id) {
      propose(!ended, ended ? "" : `played ${cur?.title ?? "a song"}`);
    } else if (p.seekNonce !== prev.seekNonce) {
      propose(true, "");
    } else if (p.playing !== prev.playing) {
      const s = useRoom.getState().view.state;
      if (p.playing && s?.playing && s.track?.id === cur?.id) {
        // The room never stopped: play joins it again at its moment, without moving it.
        queueMicrotask(() => apply(useRoom.getState().view));
        return;
      }
      propose(p.playing, p.playing ? "pressed play" : ended ? "" : "paused");
    } else if (ids(p.queue.slice(p.index + 1)) !== ids(prev.queue.slice(prev.index + 1))) {
      // Named by what reaches the room: none from this computer, and only what fits in its queue.
      const had = new Set(prev.queue.slice(prev.index + 1).map((t) => t.id));
      const added = p.queue.slice(p.index + 1).filter((t) => !had.has(t.id));
      const shared = added.filter((t) => !isLocal(t));
      const fit = roomQueue(p).filter((t) => !had.has(t.id));
      const note = fit.length === 1 ? `added ${fit[0].title}` : fit.length > 1 ? `added ${fit.length} songs` : added.length ? "" : "changed the queue";
      const says: string[] = [];
      if (shared.length < added.length) says.push("Songs from this computer stay out of the room's queue");
      if (fit.length < shared.length) says.push(`The room's queue is full (${MAX_ROOM_QUEUE} songs)`);
      propose(false, note, says);
    }
  });
}

/** Past a song's end by this much with no computer saying so, the room moves on by itself. */
const END_GRACE_MS = 10_000;

/** Every few seconds: a computer that drifted (a slow load, a hiccup) seeks back to the room's moment. */
function watchDrift(): () => void {
  const timer = window.setInterval(() => {
    const view = useRoom.getState().view;
    const s = view.state;
    const p = usePlayer.getState();
    if (!s?.track || applying || intent || inFlight) return;
    const at = roomPosition(s, Date.now() + view.offsetMs);
    // It played on no computer (or everyone stepped out): on to the next song, as a song ending does.
    if (s.playing && s.track.duration > 0 && at.ms >= s.track.duration * 1000 + END_GRACE_MS) return moveOn(view);
    if (p.queue[p.index]?.id !== s.track.id) return apply(view);
    if (s.playing && at.startsInMs === 0 && p.playing && offBy(p.position * 1000, at.ms)) quietly(() => p.seek(at.ms / 1000));
  }, 5000);
  return () => window.clearInterval(timer);
}

/** The room's song is over and no computer said so: the next one, the way a song ending moves on. */
function moveOn(view: RoomView): void {
  const s = view.state;
  if (!s?.track) return;
  const [next, ...rest] = s.queue;
  const change: RoomChange = next
    ? { baseSeq: s.seq, track: next, positionMs: 0, playing: true, queue: rest, lead: false, note: "" }
    : { baseSeq: s.seq, track: s.track, positionMs: 0, playing: false, queue: [], lead: false, note: "" };
  inFlight = true;
  sending = sending.then(async () => {
    try {
      const answer = await requireBridge().roomUpdate(change);
      useRoom.setState({ view: answer });
      inFlight = false;
      apply(answer);
    } catch {
      inFlight = false;
      apply(useRoom.getState().view);
    }
  });
}

/* ---------------- entering and leaving ---------------- */

interface Snapshot {
  queue: Track[];
  index: number;
  position: number;
  shuffle: boolean;
  repeat: RepeatMode;
  playingFrom: string | null;
}

/** The listener's own queue goes aside while in a room. */
async function setAside(): Promise<void> {
  const p = usePlayer.getState();
  const snapshot: Snapshot = { queue: p.queue, index: p.index, position: p.position, shuffle: p.shuffle, repeat: p.repeat, playingFrom: p.playingFrom };
  await requireBridge().roomStash(snapshot);
}

/** ...and comes back (paused) after leaving, or after a room ByTune quit in. */
async function bringBack(): Promise<void> {
  const s = (await requireBridge().roomUnstash().catch(() => null)) as Snapshot | null;
  if (!s || !Array.isArray(s.queue) || !s.queue.every((t) => t && typeof t.id === "string")) return;
  cancelStart();
  quietly(() =>
    usePlayer.setState({
      queue: s.queue,
      index: Math.min(Math.max(0, Number(s.index) || 0), Math.max(0, s.queue.length - 1)),
      position: Number(s.position) || 0,
      playing: false,
      shuffle: s.shuffle === true,
      repeat: s.repeat === "all" || s.repeat === "one" ? s.repeat : "off",
      playingFrom: typeof s.playingFrom === "string" ? s.playingFrom : null,
      unshuffled: null,
      autoplayCount: 0,
      contextId: usePlayer.getState().contextId + 1,
    })
  );
}

async function enter(open: () => Promise<RoomView>, starting: boolean): Promise<void> {
  if (useRoom.getState().busy) return;
  useRoom.setState({ busy: true });
  sittingOut = null;
  try {
    await setAside();
    const view = await open();
    useRoom.setState({ view });
    quietly(() => {
      usePlayer.getState().dropAutoplay();
      usePlayer.setState({ shuffle: false, repeat: "off", unshuffled: null });
    });
    const p = usePlayer.getState();
    const mine = p.queue[p.index];
    if (starting && view.state && !view.state.track && mine && !isLocal(mine)) {
      // A new room starts with what its host is playing.
      propose(false, `played ${mine.title}`);
    } else {
      apply(view);
    }
    useUI.setState({ rightPanel: "room" });
  } catch (err) {
    toast(ipcMessage(err, "Couldn't open the room"), "error");
    // Nothing of the player changed: the copy set aside just goes.
    if (!inRoom()) await requireBridge().roomUnstash().catch(() => undefined);
  } finally {
    useRoom.setState({ busy: false });
  }
}

export const startRoom = (): Promise<void> => enter(() => requireBridge().roomCreate(), true);
export const joinRoom = (code: string): Promise<void> => enter(() => requireBridge().roomJoin(code), false);

export async function leaveRoom(): Promise<void> {
  useRoom.setState({ busy: true });
  try {
    await requireBridge().roomLeave(); // the room:state that follows brings the queue back
  } finally {
    useRoom.setState({ busy: false });
  }
}

/** A room's change of state from main: applied, or (the room gone) the listener's own queue back. */
function received(view: RoomView): void {
  const was = inRoom();
  useRoom.setState({ view });
  if (view.state) {
    if (!intent && !inFlight) apply(view);
  } else if (was) {
    cancelStart();
    sittingOut = null;
    if (view.problem) toast(view.problem);
    void bringBack();
  }
}

/** An invite link (bytune://room/CODE): asks before joining. */
async function takeInvite(): Promise<void> {
  const code = await requireBridge().roomTakeInvite();
  if (!code || !roomCodeIn(code)) return;
  if (useRoom.getState().view.state?.code === code) {
    useUI.setState({ rightPanel: "room" });
    return;
  }
  useUI.getState().openDialog({
    title: `Join room ${code}?`,
    body: inRoom()
      ? "You'll leave the room you're in. What you were playing before stays aside until you leave this one."
      : "Everyone in a room hears the same song at the same moment. What you're playing is set aside and comes back when you leave.",
    confirmLabel: "Join",
    onConfirm: () => void joinRoom(code),
  });
}

/** Starts the room side of the player: once, at app start. */
export function listenForRooms(): () => void {
  if (!hasBridge()) return () => undefined;
  const bridge = requireBridge();
  const stops = [watchPlayer(), watchDrift(), bridge.onRoomState(received), bridge.onRoomInvite(() => void takeInvite())];
  void bridge
    .roomCurrent()
    .then((view) => {
      useRoom.setState({ view });
      if (view.state) apply(view);
      else return bringBack(); // a room ByTune quit or crashed in, or one left while the page was gone
    })
    .then(() => takeInvite())
    .catch(() => undefined);
  return () => {
    cancelStart();
    for (const stop of stops) stop();
  };
}
