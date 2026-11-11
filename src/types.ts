/** Shared data types used by both the Electron main process and the renderer. */

export interface Track {
  /** YouTube video id */
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  album?: string;
  albumId?: string;
  /** duration in seconds (0 = unknown) */
  duration: number;
  /** best available thumbnail url */
  thumb: string;
  /** catalogue explicit-content flag (YouTube Music) */
  explicit?: boolean;
  /** the artist's own photo, off the artist page (≠ song artwork) */
  artistImage?: string;
  /** set for local-library tracks (local origin flag; playback resolves via the id) */
  localPath?: string;
  /** a podcast episode — kept out of Replay, recommendations and AutoPlay */
  episode?: boolean;
}

export interface Album {
  id: string;
  title: string;
  artist: string;
  year?: string;
  thumb: string;
  /** "Album" / "Single" / "EP", off the release page header. */
  releaseType?: string;
  /** YouTube's editorial blurb — the "About the album" section. */
  description?: string | null;
  /** The release's artist page, when the header linked one. */
  artistId?: string;
}

export interface Artist {
  id: string;
  name: string;
  thumb: string;
  subtitle?: string;
}

export interface PlaylistCard {
  id: string;
  title: string;
  thumb: string;
  count?: number;
  /** "Playlist • YouTube Music • 33 songs" style line, where the shelf carries one. */
  subtitle?: string;
}

export type SearchFilter = "all" | "songs" | "videos" | "albums" | "artists" | "playlists" | "podcasts";

export interface SearchResults {
  songs: Track[];
  videos: Track[];
  albums: Album[];
  artists: Artist[];
  playlists: PlaylistCard[];
  /** YouTube's own "Top result" card — the best match for a partial query. */
  top?: TopResult | null;
  /** Other songs by the top result's artist (Spotify's "more by" row). */
  related?: Track[];
}

/* ---------------- Mobile-faithful search ---------------- */

/** What kind of page a non-track search result opens — YouTube's own pageType. */
export type BrowseType = "album" | "artist" | "playlist" | "podcast" | "other";

/** A non-track search row: album, artist, playlist or profile/podcast. */
export interface BrowseItem {
  browseId: string;
  title: string;
  /** YouTube's own line — "Album • Lana Del Rey • 2012", "Artist • 332M monthly audience". */
  subtitle: string;
  thumb: string;
  type: BrowseType;
}

/**
 * One search row, classified exactly as BitChord mobile classifies it: the
 * promoted card ("top"), an ordinary track row, or a browsable page row.
 */
export type SearchRow =
  | { kind: "top"; song: Track }
  | { kind: "track"; song: Track }
  /** top: the promoted result on the "All" tab (an artist, album or playlist card) */
  | { kind: "browse"; item: BrowseItem; top?: boolean };

/** One page of search rows, plus the token for the next page (null when done). */
export interface SearchPageResult {
  rows: SearchRow[];
  continuation: string | null;
}

/** A song from YouTube Music's radio, with what kind of upload it is. */
export interface RadioTrack extends Track {
  /** song = catalogue audio (ATV), video = official music video (OMV),
      upload = user upload (UGC), episode = podcast episode */
  videoType: "song" | "video" | "upload" | "episode";
}

/** One page of a song's radio — the endless AutoPlay source. */
export interface RadioPage {
  tracks: RadioTrack[];
  /** Token for the next page, or null when the radio has no more. */
  next: string | null;
  /** The seed song's own credits (search rows often lack them). */
  seed: { artist: string; artistId?: string } | null;
}

/** The kind-aware "Top result" card (YouTube's MusicCardShelf). */
export interface TopResult {
  kind: "track" | "album" | "artist";
  track?: Track;
  album?: Album;
  artist?: Artist;
}

/** A type-ahead search suggestion from YouTube Music: a text completion, or a rich row. */
export interface SearchSuggestion {
  /** the completion, or a rich row's title */
  text: string;
  thumb?: string;
  /** YouTube's own line — "Song • Charlie Puth • 3B plays", "Artist • 103M monthly audience" */
  subtitle?: string;
  /** a rich row's id: the videoId of a playable hit, the browseId of a page */
  id?: string;
  /** rich rows only — text completions carry none */
  kind?: "song" | "video" | "episode" | Exclude<BrowseType, "other">;
  /** what a song, video or episode row plays */
  track?: Track;
  /** what an album, artist, playlist or podcast row opens */
  browse?: BrowseItem;
}

export type HomeItemKind = "track" | "album" | "artist" | "playlist";

export interface HomeItem {
  kind: HomeItemKind;
  track?: Track;
  album?: Album;
  artist?: Artist;
  playlist?: PlaylistCard;
}

export interface HomeShelf {
  title: string;
  items: HomeItem[];
}

/** A moods & genres category page (Explore → a card): its title and every shelf, in the page's order. */
export interface MoodPage {
  title: string;
  shelves: HomeShelf[];
}

/** Extended artist page — the BitChord mobile artist screen's data. */
export interface ArtistPageData {
  artist: Artist;
  /** "About the artist" editorial blurb. */
  description?: string | null;
  /** "18.9M subscribers", off the page header. */
  subscriberCount?: string | null;
  /** "332M monthly listeners", off the page header. */
  monthlyListeners?: string | null;
  /** The "Top songs" shelf rows. */
  songs: Track[];
  /** Albums / Singles & EPs / Featured on / Playlists by X / Fans might also like, in YouTube's own order. */
  shelves: HomeShelf[];
}

/** A remote (YouTube) playlist page, as the mobile app's DetailScreen shows it. */
export interface RemotePlaylistPage {
  title: string;
  /** The credit line — "Marie Liesegang, 105 views". */
  credit: string;
  /** "PLAYLIST • 7 TRACKS" style metadata line. */
  meta: string;
  thumb: string;
  tracks: Track[];
}

/** A song from outside ByTune (a Spotify playlist, a CSV or pasted line), before it is matched to YouTube Music. */
export interface ImportSong {
  title: string;
  /** every credited artist, as the source writes them ("" = unknown) */
  artist: string;
  album?: string;
  /** seconds (0 = unknown) */
  duration: number;
  thumb?: string;
  explicit?: boolean;
  /** Spotify's track id, when the song came from Spotify */
  spotifyId?: string;
}

/** A playlist from outside ByTune, as read: its songs, and how many the source lists. */
export interface ImportedPlaylist {
  name: string;
  owner?: string;
  thumb?: string;
  songs: ImportSong[];
  /** songs the source lists; more than songs.length when it couldn't all be read */
  total: number;
}

/** A playlist in the connected Spotify library ("liked" = Liked Songs). */
export interface SpotifyPlaylistInfo {
  id: string;
  name: string;
  owner?: string;
  thumb?: string;
}

export interface SpotifyStatus {
  connected: boolean;
  /** the Spotify account's display name */
  name?: string;
  /** why the connection isn't working (expired session, Spotify changed something) */
  problem?: string;
}

/** A room: people listening to the same song at the same moment (supabase/migrations/0002-rooms.sql). */
export interface RoomState {
  id: string;
  /** what people type to join: 6 characters, no look-alikes */
  code: string;
  hostId: string;
  /** only the host may play, pause, skip, seek or change the queue */
  hostOnly: boolean;
  track: Track | null;
  /** where `track` is at `anchorMs` (the server's clock) */
  positionMs: number;
  anchorMs: number;
  playing: boolean;
  /** up next, at most 25 songs */
  queue: Track[];
  activity: { atMs: number; text: string }[];
  members: { userId: string; name: string; lastSeenMs: number }[];
  /** bumps on every change; an update names the seq it was based on */
  seq: number;
}

/** What the page knows of its room: the state, who it is, and this computer's clock offset to the server's. */
export interface RoomView {
  state: RoomState | null;
  /** the signed-in user's id */
  me: string | null;
  /** server clock − this computer's clock, ms */
  offsetMs: number;
  /** why the last room action failed, or why the room ended ("You were removed from the room") */
  problem?: string;
}

/** A change to what's playing, as the page asks for it. */
export interface RoomChange {
  /** the seq the change was based on */
  baseSeq: number;
  track: Track | null;
  positionMs: number;
  playing: boolean;
  queue: Track[];
  /** a start or a seek: everyone starts together, 600 ms from now */
  lead: boolean;
  /** "played Yellow", for the activity list ("" = no line) */
  note: string;
}

export interface DownloadProgress {
  id: string;
  downloaded: number;
  total: number;
}

/* ---------------- Lyrics ---------------- */

/** A word (or syllable group) with its own timing — Apple TTML / rich LRC. */
export interface SyncedLyricWord {
  /** seconds into the track */
  start: number;
  end: number;
  text: string;
}

export interface SyncedLyricLine {
  /** seconds into the track */
  time: number;
  text: string;
  /** per-word timings when the provider is word-synced */
  words?: SyncedLyricWord[];
  /** seconds the line stops singing, when known */
  end?: number;
  /** instrumental section marker (nobody sings here) */
  gap?: boolean;
  /** background vocals sung under this line, with their own timing */
  bg?: { text: string; words?: SyncedLyricWord[] };
  /** the provider's romanized reading of a non-Latin line */
  roman?: string;
}

/** A podcast episode: plays like a song, but stays out of Replay, recommendations and AutoPlay. */
export interface PodcastEpisode extends Track {
  episode: true;
  /** "2d ago", "Oct 12" … as YouTube Music prints it */
  published?: string;
  description?: string;
}

/** A podcast show page: who makes it and its episodes, newest first. */
export interface PodcastPage {
  id: string;
  title: string;
  author: string;
  thumb: string;
  description: string | null;
  episodes: PodcastEpisode[];
}

/** A show card off YouTube Music's podcasts page; its id opens the show page. */
export interface PodcastShow {
  /** MPSP… browse id */
  id: string;
  title: string;
  author: string;
  thumb: string;
}

/** One shelf of YouTube Music's podcasts page: show cards or episode rows, in its order. */
export interface PodcastShelf {
  title: string;
  shows: PodcastShow[];
  episodes: PodcastEpisode[];
}

export interface LyricsResult {
  /** time-synced lines when available (Spotify-style highlighting) */
  synced: SyncedLyricLine[] | null;
  plain: string | null;
  /** which provider answered */
  source?: string;
  /** true when the synced lines carry per-word timings */
  wordSynced?: boolean;
}
