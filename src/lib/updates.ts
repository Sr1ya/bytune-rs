/**
 * Updates on screen: the main process's update state (electron/updater.ts), live, for the top bar's
 * Update button and Settings › About. Outside the desktop shell there's no state, and nothing shows.
 */
import { useEffect, useState } from "react";
import { useLibrary } from "../stores/library";
import type { UpdateState } from "../shared/backend-types";

export type { UpdateState };

export function useUpdates(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    let live = true;
    window.bytune?.updateState?.().then((s) => live && setState(s)).catch(() => undefined);
    const off = window.bytune?.onUpdateState?.(setState);
    return () => {
      live = false;
      off?.();
    };
  }, []);
  return state;
}

/**
 * The pinned "update available" playlist that versions before the updater were sent through their
 * synced library. This version is that update, so it goes, and its deletion syncs like any other.
 */
export const UPDATE_NOTICE_ID = "bytune-update-notice";

export function watchUpdateNotice(): () => void {
  const drop = (s: ReturnType<typeof useLibrary.getState>): void => {
    if (s.playlists.some((p) => p.id === UPDATE_NOTICE_ID)) s.deletePlaylist(UPDATE_NOTICE_ID);
  };
  drop(useLibrary.getState());
  return useLibrary.subscribe(drop);
}
