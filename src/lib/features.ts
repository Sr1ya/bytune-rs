/**
 * Features of ByTune that the Tauri + Rust port doesn't include yet.
 * Their UI stays in the codebase, switched off here, so porting them later is
 * a matter of implementing the backend and flipping a flag.
 */
/** Supabase accounts and cloud sync (src/cloud/). */
export const ACCOUNTS = true;
/** Listen-together Rooms (need accounts). */
export const ROOMS = true;
/** Connecting the listener's own Spotify account (public playlist links still import). */
export const SPOTIFY_CONNECT = false;
