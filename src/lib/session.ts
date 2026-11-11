/** Renderer-side session state — mirrors the main process's local profile. */
import { create } from "zustand";
import { hasBridge } from "./bridge";

export interface SessionInfo {
  mode: "guest" | "account" | null;
  userId: string | null;
  username: string | null;
  /** What people see (Rooms, the avatar). The username shows only in Settings. */
  displayName: string | null;
  /** Offered as the display name on the sign-up screens: a guest's own, or a new Google account's. */
  suggestedDisplayName?: string;
  freshInstall: boolean;
  /** Fresh Google sign-in still using the auto-generated username. */
  needsUsername?: boolean;
}

interface SessionState extends SessionInfo {
  loaded: boolean;
  refresh(): Promise<void>;
}

export const useSession = create<SessionState>((set) => ({
  mode: null,
  userId: null,
  username: null,
  displayName: null,
  suggestedDisplayName: undefined,
  freshInstall: false,
  needsUsername: false,
  loaded: false,
  refresh: async () => {
    try {
      const info = (await window.bytune?.authGetSession()) as SessionInfo | undefined;
      set({
        mode: info?.mode ?? null,
        userId: info?.userId ?? null,
        username: info?.username ?? null,
        displayName: typeof info?.displayName === "string" ? info.displayName : null,
        suggestedDisplayName: typeof info?.suggestedDisplayName === "string" ? info.suggestedDisplayName : undefined,
        freshInstall: info?.freshInstall === true,
        needsUsername: info?.needsUsername === true,
        loaded: true,
      });
    } catch {
      set({ loaded: true });
    }
  },
}));

/** The name shown for this person: their display name, else (an account without one yet) their username. */
export function shownName(s: Pick<SessionInfo, "mode" | "username" | "displayName">): string | null {
  return s.displayName?.trim() || (s.mode === "account" ? s.username?.trim() || null : null);
}

/** Subscribe once (App mount) so auth changes anywhere re-render the gate. */
export function watchSession(): () => void {
  if (!hasBridge()) return () => undefined;
  const off = window.bytune!.onAuthChanged(() => void useSession.getState().refresh());
  void useSession.getState().refresh();
  return off;
}
