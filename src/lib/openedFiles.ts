/**
 * Audio files opened with ByTune (Open with, a double-click, a second launch,
 * or dropped on the window) play at once: the first right away, the others
 * after it, then the queue as it was.
 */
import { usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";
import { localToTrack } from "./localTrack";

/** Local Music listens for this to refresh its Opened files list. */
export const OPENED_FILES_EVENT = "bytune:opened-files-updated";

export function listenForOpenedFiles(): () => void {
  const bridge = window.bytune;
  if (!bridge?.takeOpenedFiles) return () => undefined;
  const take = async (): Promise<void> => {
    for (const { tracks, unplayable } of await bridge.takeOpenedFiles()) {
      if (tracks.length) {
        const songs = tracks.map(localToTrack);
        const player = usePlayer.getState();
        if (!player.queue.length) {
          player.addToQueue(songs);
          usePlayer.getState().setPlaying(true);
        } else {
          player.addToQueue(songs, true);
          usePlayer.getState().next(true);
        }
        window.dispatchEvent(new Event(OPENED_FILES_EVENT));
      }
      if (unplayable.length) {
        useUI.getState().toast(`ByTune can't play ${[...new Set(unplayable)].join(" or ")} files`, "warning");
      }
    }
  };
  const off = bridge.onFilesOpened(() => void take());
  void take();
  return off;
}
