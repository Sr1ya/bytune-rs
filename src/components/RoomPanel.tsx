/**
 * Rooms, in the right panel. Outside a room: start one, or join with a code (an invite link pasted
 * in works too). Inside: the code and its invite link, who's here (the host, who's away), who
 * controls the music, what happened lately, and Leave. What plays is in the Queue view as ever;
 * in a room that queue is everyone's.
 */
import { useState } from "react";
import { Copy, Crown, LogOut, MoreHorizontal, Users, X } from "lucide-react";
import { Btn, IconBtn, Switch } from "./primitives";
import { joinRoom, leaveRoom, startRoom } from "../lib/rooms";
import { inviteLink, roomCodeIn } from "../lib/roomSync";
import { useSession } from "../lib/session";
import { ipcMessage } from "../lib/spotify";
import { requireBridge } from "../lib/bridge";
import { useRoom } from "../stores/room";
import { useUI } from "../stores/ui";
import type { RoomView } from "../types";

/** Not heard from (the 30 s ping) for this long: away. */
const AWAY_MS = 75_000;

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

const copy = (text: string, what: string): void => {
  void navigator.clipboard
    .writeText(text)
    .then(() => useUI.getState().toast(`${what} copied`))
    .catch(() => useUI.getState().toast(`Couldn't copy the ${what.toLowerCase()}`, "error"));
};

/** A host-only action; the room's answer comes back as a room:state. */
function hostAction(run: () => Promise<RoomView>): void {
  void run().catch((err: unknown) => useUI.getState().toast(ipcMessage(err, "The room didn't take that"), "error"));
}

function Lobby() {
  const busy = useRoom((s) => s.busy);
  const [code, setCode] = useState("");
  const valid = roomCodeIn(code);
  const join = (): void => {
    if (valid) void joinRoom(valid);
    else useUI.getState().toast("A room code is 6 letters and numbers, like K7M2QX", "error");
  };
  return (
    <div className="space-y-6">
      <div>
        <div className="w-12 h-12 rounded-2xl bg-ink-hi/[0.06] grid place-items-center mb-3">
          <Users className="w-6 h-6 text-ink-hi/70" />
        </div>
        <h3 className="text-[17px] font-bold tracking-[-0.2px] text-ink-hi">Listen together</h3>
        <p className="text-[13px] text-ink-dim mt-1.5 leading-relaxed">
          Everyone in a room hears the same song at the same moment, and anyone can pick what plays next.
        </p>
      </div>
      <Btn variant="white" size="md" className="w-full" disabled={busy} onClick={() => void startRoom()}>
        Start a room
      </Btn>
      <div>
        <label htmlFor="room-code" className="micro-label text-ink-hi/55">
          Or join one
        </label>
        <div className="flex gap-2 mt-2">
          <input
            id="room-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") join();
            }}
            placeholder="Room code"
            maxLength={100}
            spellCheck={false}
            autoComplete="off"
            className="flex-1 min-w-0 h-10 px-3.5 rounded-xl bg-ink-hi/[0.06] border border-ink-hi/10 text-sm text-ink tracking-[0.18em] uppercase placeholder:normal-case placeholder:tracking-normal placeholder:text-ink-ghost outline-none focus:border-accent/60 transition-colors"
          />
          <Btn variant="glass" size="md" disabled={busy || !code.trim()} onClick={join}>
            Join
          </Btn>
        </div>
      </div>
      <p className="text-[12px] text-ink-faint leading-relaxed">
        What you're playing is set aside while you're in a room and comes back when you leave. Songs from this computer can't play in a room.
      </p>
    </div>
  );
}

function InRoom({ view }: { view: RoomView }) {
  const s = view.state!;
  const busy = useRoom((st) => st.busy);
  const iHost = view.me === s.hostId;
  const host = s.members.find((m) => m.userId === s.hostId);
  const now = Date.now() + view.offsetMs;
  const memberMenu = (e: React.MouseEvent, userId: string, name: string): void => {
    useUI.getState().openContextMenu(e.clientX, e.clientY, [
      { label: `Make ${name} the host`, action: () => hostAction(() => requireBridge().roomMakeHost(userId)) },
      {
        label: `Remove ${name}`,
        danger: true,
        action: () => hostAction(() => requireBridge().roomRemove(userId)),
      },
    ]);
  };
  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-ink-hi/[0.05] p-4">
        <div className="micro-label text-ink-hi/55">Room code</div>
        <div className="font-display text-[30px] font-extrabold tracking-[0.22em] text-ink-hi mt-1 select-all">{s.code}</div>
        <div className="flex gap-2 mt-3">
          <Btn variant="white" size="sm" icon={Copy} onClick={() => copy(inviteLink(s.code), "Invite link")}>
            Copy invite link
          </Btn>
          <Btn variant="glass" size="sm" onClick={() => copy(s.code, "Code")}>
            Copy code
          </Btn>
        </div>
      </div>

      <div>
        <div className="flex items-center gap-3">
          <h3 className="flex-1 text-[15px] font-bold tracking-[-0.2px] text-ink-hi">
            {s.members.length} {s.members.length === 1 ? "listener" : "listeners"}
          </h3>
        </div>
        <ul className="mt-2 space-y-0.5">
          {s.members.map((m) => {
            const away = now - m.lastSeenMs > AWAY_MS;
            const me = m.userId === view.me;
            return (
              <li key={m.userId} className="group flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-ink-hi/[0.04]">
                <span
                  aria-hidden
                  className={`w-8 h-8 rounded-full grid place-items-center text-[13px] font-bold uppercase ${away ? "bg-ink-hi/[0.05] text-ink-hi/40" : "bg-ink-hi/[0.12] text-ink-hi"}`}
                >
                  {m.name.slice(0, 1)}
                </span>
                <span className="flex-1 min-w-0">
                  <span className={`block text-[14px] font-semibold truncate ${away ? "text-ink-hi/50" : "text-ink-hi"}`}>
                    {m.name}
                    {me ? <span className="font-normal text-ink-hi/50"> (you)</span> : null}
                  </span>
                  <span className="block text-[12px] text-ink-hi/50">{m.userId === s.hostId ? "Host" : away ? "Away" : "Listening"}</span>
                </span>
                {m.userId === s.hostId && <Crown className="w-4 h-4 text-ink-hi/60 shrink-0" aria-label="Host" />}
                {iHost && !me && (
                  <IconBtn
                    icon={MoreHorizontal}
                    title={`Options for ${m.name}`}
                    size="sm"
                    onClick={(e) => memberMenu(e, m.userId, m.name)}
                    className="rounded-full text-ink-hi/55 hover:text-ink-hi opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                  />
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-[14px] text-ink-hi">Only the host controls the music</div>
          <div className="text-[12px] text-ink-dim mt-0.5">
            {s.hostOnly ? `${iHost ? "Only you" : `Only ${host?.name ?? "the host"}`} can play, skip or change the queue` : "Anyone in the room can play, skip or change the queue"}
          </div>
        </div>
        <Switch
          checked={s.hostOnly}
          disabled={!iHost}
          label="Only the host controls the music"
          onChange={(on) => hostAction(() => requireBridge().roomHostOnly(on))}
        />
      </div>

      {s.activity.length > 0 && (
        <div>
          <h3 className="text-[15px] font-bold tracking-[-0.2px] text-ink-hi">Lately</h3>
          <ul className="mt-2 space-y-1.5">
            {s.activity.slice(0, 8).map((a) => (
              <li key={`${a.atMs}-${a.text}`} className="flex gap-3 text-[13px]">
                <span className="flex-1 min-w-0 text-ink-hi/75">{a.text}</span>
                <span className="text-ink-hi/40 tabular-nums shrink-0">{ago(now - a.atMs)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Btn variant="ghost" size="md" icon={LogOut} className="w-full" disabled={busy} onClick={() => void leaveRoom()}>
        Leave room
      </Btn>
    </div>
  );
}

export function RoomPanel({ onClose }: { onClose: () => void }) {
  const signedIn = useSession((s) => s.mode) === "account";
  const view = useRoom((s) => s.view);
  return (
    <>
      <div className="h-14 shrink-0 flex items-center gap-3 px-5 border-b border-ink-hi/[0.08]">
        <h2 className="text-[15px] font-bold tracking-[-0.2px] text-ink-hi">Room</h2>
        <div className="ml-auto">
          <IconBtn icon={X} title="Close room panel" onClick={onClose} className="rounded-full text-ink-hi/55 hover:text-ink-hi" />
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-5">
        {view.state ? (
          <InRoom view={view} />
        ) : signedIn ? (
          <Lobby />
        ) : (
          <div className="space-y-4">
            <h3 className="text-[17px] font-bold tracking-[-0.2px] text-ink-hi">Listen together</h3>
            <p className="text-[13px] text-ink-dim leading-relaxed">
              Rooms let friends hear the same song at the same moment. They need a ByTune account, so a room knows who's in it.
            </p>
            <Btn variant="white" size="md" onClick={() => useUI.getState().openSettings("account")}>
              Sign in or create an account
            </Btn>
          </div>
        )}
      </div>
    </>
  );
}
