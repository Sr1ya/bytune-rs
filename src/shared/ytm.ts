/**
 * Raw InnerTube (YouTube Music) calls + a faithful port of BitChord mobile's
 * InnertubeParser (app/src/main/java/com/music/bitchord/data/innertube/InnertubeParser.kt).
 *
 * The mobile app reads the raw `musicResponsiveListItemRenderer` /
 * `musicCardShelfRenderer` JSON rather than youtubei.js's parsed classes, and
 * classifies every row on the way out — that is what makes its search results
 * (order, count, sections, subtitles) YouTube's own. This module reproduces
 * that exactly, so the desktop's search page is the same list the phone shows.
 *
 * Search filters use YouTube Music's own params, the same byte strings the
 * mobile app pins in `SearchFilter` (Models.kt).
 */
import type {
  Album,
  Artist,
  BrowseItem,
  HomeItem,
  HomeShelf,
  MoodPage,
  PodcastEpisode,
  PodcastPage,
  PodcastShelf,
  RadioPage,
  RadioTrack,
  RemotePlaylistPage,
  SearchPageResult,
  SearchRow,
  SearchSuggestion,
  Track,
} from "../types";
import { bestThumbUrl } from "./artwork";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** YouTube Music search filter chips — BitChord mobile's SearchFilter.params (Models.kt). */
export const SEARCH_FILTER_PARAMS: Record<string, string | null> = {
  all: null,
  songs: "EgWKAQIIAWoKEAkQChAFEAMQBA==",
  videos: "EgWKAQIQAWoKEAkQChAFEAMQBA==",
  albums: "EgWKAQIYAWoKEAkQChAFEAMQBA==",
  artists: "EgWKAQIgAWoKEAkQChAFEAMQBA==",
  playlists: "EgWKAQIoAWoKEAkQChAFEAMQBA==",
  podcasts: "EgWKAQJQAWoKEAkQChAFEAMQBA==",
};

/* ---------------- raw endpoint calls ---------------- */

export async function callSearch(yt: any, query: string, params: string | null): Promise<any> {
  const res = await yt.actions.execute("search", {
    query,
    ...(params ? { params } : {}),
    client: "YTMUSIC",
  });
  return res?.data ?? null;
}

export async function callSearchContinuation(yt: any, token: string): Promise<any> {
  const res = await yt.actions.execute("search", {
    continuation: token,
    client: "YTMUSIC",
  });
  return res?.data ?? null;
}

/** YouTube Music's typeahead, raw: text completions plus a few rich rows. */
export async function callSearchSuggestions(yt: any, query: string): Promise<any> {
  const res = await yt.actions.execute("/music/get_search_suggestions", {
    input: query,
    client: "YTMUSIC",
  });
  return res?.data ?? null;
}

/** The next page of a browse result (a long playlist or album shelf). */
export async function callBrowseContinuation(yt: any, token: string): Promise<any> {
  const res = await yt.actions.execute("browse", {
    continuation: token,
    client: "YTMUSIC",
  });
  return res?.data ?? null;
}

export async function callBrowse(yt: any, browseId: string, params?: string | null): Promise<any> {
  const res = await yt.actions.execute("browse", {
    browseId,
    ...(params ? { params } : {}),
    client: "YTMUSIC",
  });
  return res?.data ?? null;
}

/* ---------------- tiny JSON navigation (null-safe, never throws) ---------------- */

function o(node: any, key: string): any {
  const v = node && typeof node === "object" && !Array.isArray(node) ? node[key] : null;
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}

function a(node: any, key: string): any[] | null {
  return node && typeof node === "object" && Array.isArray(node[key]) ? node[key] : null;
}

function s(node: any, key: string): string | null {
  const v = node && typeof node === "object" ? node[key] : null;
  // Width/height and counts arrive as JSON numbers — primitives, like strings.
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : null;
}

/** {runs:[{text}]} | {simpleText} | string — joined, the Kotlin `runs()` helper. */
function text(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v.simpleText === "string") return v.simpleText;
  if (Array.isArray(v.runs)) return v.runs.map((r: any) => s(r, "text") ?? "").join("");
  return "";
}

function firstRunText(node: any): string | null {
  const runs = a(node, "runs");
  return runs && runs.length ? (s(runs[0], "text") ?? null) : null;
}

/** Depth-first collection of a named renderer, preserving document order. */
export function collectRenderers(root: any, name: string): any[] {
  const out: any[] = [];
  const visit = (node: any): void => {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node[name] && typeof node[name] === "object") out.push(node[name]);
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") visit(value);
    }
  };
  visit(root);
  return out;
}

/**
 * YTM Charts page (browseId FEmusic_charts) → home shelves. The region comes
 * from the session's `gl` — this is the provider's own per-market popularity
 * ranking ("Top songs", "Top artists", …), not a hand-built list. Song rows
 * are responsive list items (both carousel shelves and the page's main
 * musicShelf); artist rows are two-row cards; video uploads are excluded
 * under the same music-only rule the home shelves apply (a video breaks
 * playback sync). Shelves with fewer than 3 usable rows are dropped.
 */
export function parseChartsShelves(res: any): Array<{
  title: string;
  items: Array<
    | { kind: "artist"; artist: { id: string; name: string; thumb: string; subtitle?: string } }
    | { kind: "album"; album: { id: string; title: string; artist: string; thumb: string } }
    | { kind: "track"; track: Track }
  >;
}> {
  const out: Array<any> = [];
  const harvest = (title: string, rows: any[]): void => {
    const items: any[] = [];
    for (const renderer of rows) {
      const card = parseBrowseItem(renderer);
      if (card) {
        if (card.type === "artist") {
          items.push({
            kind: "artist",
            artist: { id: card.browseId, name: card.title, thumb: card.thumb, subtitle: card.subtitle },
          });
        } else if (card.type === "album") {
          items.push({
            kind: "album",
            album: {
              id: card.browseId,
              title: card.title,
              artist: card.subtitle.split(" • ")[1]?.trim() || "Unknown artist",
              thumb: card.thumb,
            },
          });
        }
        if (items.length >= 24) break;
        continue;
      }
      const song = parseResponsiveListItem(renderer);
      if (song && !song.isVideo && song.id && song.title) {
        // ParsedSong is Track-shaped (id/title/artist/duration/thumb) — the
        // exact object the feed's track cards render and the player streams.
        items.push({ kind: "track", track: song });
      }
      if (items.length >= 24) break;
    }
    if (items.length >= 3) out.push({ title: title.trim() || "Charts", items });
  };

  // Carousel shelves ("Top artists", "Video charts", …) carry their title in
  // a basic header; the page's main song list is a musicShelfRenderer with
  // its own header.
  for (const shelf of collectRenderers(res, "musicCarouselShelfRenderer")) {
    harvest(text(shelf?.header?.musicCarouselShelfBasicHeaderRenderer?.title) || "Charts",
      (Array.isArray(shelf?.contents) ? shelf.contents : [])
        .map((node: any) => node?.musicResponsiveListItemRenderer ?? node?.musicTwoRowItemRenderer)
        .filter(Boolean));
  }
  for (const shelf of collectRenderers(res, "musicShelfRenderer")) {
    harvest(text(shelf?.title) || text(shelf?.header?.musicHeaderRenderer?.title) || "Charts",
      (Array.isArray(shelf?.contents) ? shelf.contents : [])
        .map((node: any) => node?.musicResponsiveListItemRenderer)
        .filter(Boolean));
  }
  return out.slice(0, 4);
}

/**
 * YTM Explore page (browseId FEmusic_explore) → the provider's own per-region
 * moods & genres catalog ("Chill", "Workout", "Bollywood", "Country &
 * Americana", …). The list follows the session's `gl`, so each market gets
 * its own suggestions — real provider data, never a hardcoded list. Every
 * entry carries its mood-page endpoint (browseId + params) for deep linking
 * and the accent color the provider assigns (ARGB int → #RRGGBB).
 */
export interface ParsedMood {
  title: string;
  browseId: string;
  params: string | null;
  /** provider accent color (#RRGGBB), or null when the button carries none */
  color: string | null;
  /** the moods page heading it sits under ("Moods & moments", "Genres"); null off Explore's carousel */
  section: string | null;
}

export function parseMoods(res: any): ParsedMood[] {
  const out: ParsedMood[] = [];
  const seen = new Set<string>();
  const add = (button: any, section: string | null): void => {
    const title = text(button?.buttonText);
    const endpoint = o(o(button, "clickCommand"), "browseEndpoint");
    const browseId = s(endpoint, "browseId");
    if (!title.trim() || !browseId || seen.has(title)) return;
    seen.add(title);
    // leftStripeColor is an ARGB int (e.g. 4294951424 → #FFC200).
    const argb = button?.solid?.leftStripeColor;
    let color: string | null = null;
    if (typeof argb === "number" && Number.isFinite(argb) && argb >= 0) {
      color = "#" + (argb & 0xffffff).toString(16).padStart(6, "0");
    }
    out.push({ title: title.trim(), browseId, params: s(endpoint, "params"), color, section });
  };
  // The moods page heads each grid ("Moods & moments", "Genres"); Explore's
  // carousel holds the same buttons without headings.
  const sectionOf = new Map<any, string>();
  for (const grid of collectRenderers(res, "gridRenderer")) {
    const heading = text(o(o(grid, "header"), "gridHeaderRenderer")?.title).trim();
    if (!heading) continue;
    for (const item of a(grid, "items") ?? []) if (item?.musicNavigationButtonRenderer) sectionOf.set(item.musicNavigationButtonRenderer, heading);
  }
  for (const button of collectRenderers(res, "musicNavigationButtonRenderer")) add(button, sectionOf.get(button) ?? null);
  return out;
}

/** A mood or genre page's first playlist covers: the art on its Explore card. */
export function parseMoodCovers(res: any, max = 2): string[] {
  const out: string[] = [];
  for (const item of collectRenderers(res, "musicTwoRowItemRenderer")) {
    const url = bestThumbUrl(item?.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails);
    if (url && !out.includes(url)) out.push(url);
    if (out.length >= max) break;
  }
  return out;
}

/** Token for the next page, or null — both continuation shapes YouTube ships. */
export function continuationToken(root: any): string | null {
  const item = collectRenderers(root, "continuationItemRenderer")[0];
  const token = s(o(o(item, "continuationEndpoint"), "continuationCommand"), "token");
  if (token) return token;
  const legacy = collectRenderers(root, "nextContinuationData")[0];
  return s(legacy, "continuation");
}

/** The music pageType a browse endpoint opens — "MUSIC_PAGE_TYPE_ALBUM", etc. */
function pageTypeOf(endpoint: any): string {
  return (
    s(
      o(o(endpoint, "browseEndpointContextSupportedConfigs"), "browseEndpointContextMusicConfig"),
      "pageType"
    ) ?? ""
  );
}

function seenAdd(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

/* ---------------- shared parse vocabulary (mobile constants) ---------------- */

/** "3:43", "61:23" or "1:02:33" — hour-long mixes print three fields. */
const DURATION = /^\d+(?::\d{2}){1,2}$/;
const YEAR = /^\d{4}$/;
/** A counted quantity rather than a name — "12.4M plays", "13 songs". Narrow
 * enough to leave "21 Savage" and "50 Cent" alone, as in the mobile app. */
const TALLY = /[\d.,]+\s*[KMB]?\s+(plays|views|likes|songs|tracks|subscribers|hours?|minutes?|seconds?)\b.*/i;
const TYPE_WORDS = new Set(["song", "video", "album", "single", "ep", "artist", "playlist", "podcast", "episode"]);
const RELEASE_WORDS = new Set(["album", "single", "ep"]);
const HEADER_RENDERERS = ["musicResponsiveHeaderRenderer", "musicDetailHeaderRenderer"];
const HEADER_CREDIT_LINES = ["straplineTextOne", "subtitle"];
/** Flags a browse card as video content — "50 videos", "Daily Top Music Videos". */
const VIDEO_WORD = /\bvideos?\b/i;

function hasExplicitBadge(node: any): boolean {
  if (node == null) return false;
  if (typeof node === "string") return node === "MUSIC_EXPLICIT_BADGE";
  if (typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(hasExplicitBadge);
  return Object.values(node).some(hasExplicitBadge);
}

/**
 * The largest offered rendition, at original quality.
 *
 * Rows only carry small placeholders (usually `=w60-h60` / `=w120-h120`); the
 * size parameters are dynamic resize instructions, so the same photo serves
 * up to 1200px — taking the URL verbatim upscales a 60px image into every
 * hero and card.
 */
function bestThumb(thumbnails: any): string {
  return bestThumbUrl(thumbnails);
}

function rowThumbnails(renderer: any): any {
  return o(o(o(renderer, "thumbnail"), "musicThumbnailRenderer"), "thumbnail")?.thumbnails ?? null;
}

/** Catalogue art is square; a music-video upload's thumbnail is widescreen. */
function isNotSquare(thumbnails: any): boolean {
  const last = Array.isArray(thumbnails) ? thumbnails[thumbnails.length - 1] : null;
  const width = Number(s(last, "width"));
  const height = Number(s(last, "height"));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
  return !(width / height >= 0.85 && width / height <= 1.15);
}

/* ---------------- credits ---------------- */

export interface Credits {
  artistId?: string;
  artistName?: string;
  albumId?: string;
  albumName?: string;
}

/** The artist / album pages a run list links out to, and their names. */
function creditsOf(runs: any[]): Credits {
  const credits: Credits = {};
  for (const run of runs ?? []) {
    const browse = o(o(run, "navigationEndpoint"), "browseEndpoint");
    const id = s(browse, "browseId");
    if (!id) continue;
    const pageType = pageTypeOf(browse);
    if (pageType.includes("ARTIST") && !credits.artistId) {
      credits.artistId = id;
      credits.artistName = s(run, "text") ?? undefined;
    } else if (pageType.includes("ALBUM") && !credits.albumId) {
      credits.albumId = id;
      credits.albumName = s(run, "text") ?? undefined;
    }
  }
  return credits;
}

/* ---------------- row parsers (mobile parseResponsiveListItem) ---------------- */

function parseDurationText(v: string | null | undefined): number {
  if (!v || !DURATION.test(v.trim())) return 0;
  const parts = v.trim().split(":").map((p) => parseInt(p, 10));
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export interface ParsedSong extends Track {
  /** row's own kind word / widescreen-art verdict — mobile Song.isVideo */
  isVideo: boolean;
}

/**
 * One track row. `fallback` is what the page it came from is billed to — used
 * only where the row itself says nothing.
 */
export function parseResponsiveListItem(renderer: any, fallback: Credits = {}): ParsedSong | null {
  if (!renderer || typeof renderer !== "object") return null;
  // playlistItemData carries the id on playlist/library rows; on search and
  // album rows it hides in the overlay's play endpoint instead.
  const playOverlay = o(
    o(o(o(renderer, "overlay"), "musicItemThumbnailOverlayRenderer"), "content"),
    "musicPlayButtonRenderer"
  );
  const videoId =
    s(o(renderer, "playlistItemData"), "videoId") ??
    s(o(o(playOverlay, "playNavigationEndpoint"), "watchEndpoint"), "videoId");
  if (!videoId) return null;

  const columns = a(renderer, "flexColumns") ?? [];
  const title = text(o(o(columns[0], "musicResponsiveListItemFlexColumnRenderer"), "text"));
  if (!title.trim()) return null;

  const subtitle = text(o(o(columns[1], "musicResponsiveListItemFlexColumnRenderer"), "text"));
  const parts = subtitle
    .split(" • ")
    .map((p) => p.trim())
    .filter(Boolean);
  // A search row states its runtime in the subtitle; an album's own rows do
  // not — there the duration sits in a fixedColumns entry off to the right.
  // The runtime is the subtitle's last segment; an album or artist named like
  // a clock ("4:44") earlier in the line must not be read as one.
  const last = parts[parts.length - 1] ?? "";
  let duration = DURATION.test(last) ? last : "";
  if (!duration) {
    for (const column of a(renderer, "fixedColumns") ?? []) {
      const t = text(o(o(column, "musicResponsiveListItemFixedColumnRenderer"), "text")).trim();
      if (DURATION.test(t)) {
        duration = t;
        break;
      }
    }
  }
  // On the "All" tab the first segment is the row type ("Song", "Video"), not
  // the artist; a tally segment is a play count, not a credit either.
  const rowType = parts.find((p) => TYPE_WORDS.has(p.toLowerCase()));
  const artist = parts.find((p) => !DURATION.test(p) && !TYPE_WORDS.has(p.toLowerCase()) && !TALLY.test(p)) ?? "";

  // The artist/album names in the subtitle carry browse endpoints; pull them
  // out so rows can link to those pages. The runs live under the column's
  // `text` (reading the renderer's own `runs` found nothing, so search and
  // chart rows never got an artist or album id).
  const credits = creditsOf(
    (columns ?? []).flatMap((column: any) => {
      const flex = o(column, "musicResponsiveListItemFlexColumnRenderer");
      return a(o(flex, "text"), "runs") ?? a(flex, "runs") ?? [];
    })
  );

  const thumbnails = rowThumbnails(renderer);

  return {
    id: videoId,
    title,
    // The subtitle segment keeps every credited artist ("A & B"); the linked
    // run is only the first, so it is the fallback, not the display name.
    artist: artist || credits.artistName || fallback.artistName || "Unknown artist",
    artistId: credits.artistId ?? fallback.artistId,
    albumId: credits.albumId ?? fallback.albumId,
    album: credits.albumName ?? fallback.albumName,
    duration: parseDurationText(duration),
    thumb: bestThumb(thumbnails),
    explicit: hasExplicitBadge(renderer.subtitleBadges) || undefined,
    // The row-type word is the clean signal ("All" tab); otherwise widescreen
    // art gives a music-video upload away where catalogue art is square.
    isVideo: rowType === "video" || isNotSquare(thumbnails),
  };
}

/**
 * A search/browse row that opens a page rather than playing: album/artist/
 * playlist/other (mobile parseBrowseItem).
 */
export function parseBrowseItem(renderer: any): BrowseItem | null {
  const endpoint = o(o(renderer, "navigationEndpoint"), "browseEndpoint");
  const browseId = s(endpoint, "browseId");
  if (!browseId) return null;
  const pageType = pageTypeOf(endpoint);

  // List rows keep their words in flex columns; two-line cards (Explore,
  // carousels) carry title/subtitle and a thumbnailRenderer of their own.
  const columns = a(renderer, "flexColumns") ?? [];
  const title = text(o(o(columns[0], "musicResponsiveListItemFlexColumnRenderer"), "text")) || text(o(renderer, "title"));
  if (!title.trim()) return null;
  const subtitle = text(o(o(columns[1], "musicResponsiveListItemFlexColumnRenderer"), "text")) || text(o(renderer, "subtitle"));
  // A release billed as a video compilation would drop every row downstream —
  // skip the dead-end card rather than link to an empty page (mobile's rule).
  if (VIDEO_WORD.test(title) || VIDEO_WORD.test(subtitle)) return null;

  return {
    browseId,
    title,
    subtitle,
    thumb: bestThumb(
      rowThumbnails(renderer) ?? o(o(o(renderer, "thumbnailRenderer"), "musicThumbnailRenderer"), "thumbnail")?.thumbnails ?? null
    ),
    type: pageType.includes("PODCAST")
      ? "podcast"
      : pageType.includes("ALBUM")
      ? "album"
      : pageType.includes("ARTIST")
        ? "artist"
        : pageType.includes("PLAYLIST")
          ? "playlist"
          : "other",
  };
}

/* ---------------- search (mobile parseSearchPage) ---------------- */

/** The promoted result at the head of an unfiltered search — a MusicCardShelf. */
function parseCardShelfSong(renderer: any): ParsedSong | null {
  const videoId = s(o(o(renderer, "onTap"), "watchEndpoint"), "videoId");
  if (!videoId) return null;
  const title = text(o(renderer, "title"));
  if (!title.trim()) return null;

  const subtitleRuns = a(o(renderer, "subtitle"), "runs") ?? [];
  const subtitle = subtitleRuns.map((run) => s(run, "text") ?? "").join("");
  const parts = subtitle
    .split(" • ")
    .map((p) => p.trim())
    .filter(Boolean);
  const lastPart = parts[parts.length - 1] ?? "";
  const duration = DURATION.test(lastPart) ? lastPart : "";
  const rowType = parts.find((p) => TYPE_WORDS.has(p.toLowerCase()));
  const credits = creditsOf(subtitleRuns);
  const artist = parts.find((p) => !DURATION.test(p) && !TYPE_WORDS.has(p.toLowerCase()) && !TALLY.test(p)) ?? "";
  const thumbnails =
    o(o(o(renderer, "thumbnail"), "musicThumbnailRenderer"), "thumbnail")?.thumbnails ?? null;

  return {
    id: videoId,
    title,
    artist: credits.artistName || artist || "Unknown artist",
    artistId: credits.artistId,
    albumId: credits.albumId,
    album: credits.albumName,
    duration: parseDurationText(duration),
    thumb: bestThumb(thumbnails),
    explicit: hasExplicitBadge(renderer.subtitleBadges) || undefined,
    isVideo: rowType === "video" || isNotSquare(thumbnails),
  };
}

/** Artist, album and playlist cards use the same promoted container as a song. */
function parseCardShelfBrowse(renderer: any): BrowseItem | null {
  const endpoint = o(o(renderer, "onTap"), "browseEndpoint");
  const browseId = s(endpoint, "browseId");
  if (!browseId) return null;
  const pageType = pageTypeOf(endpoint);
  const title = text(o(renderer, "title"));
  if (!title.trim()) return null;
  const subtitle = text(o(renderer, "subtitle"));
  if (VIDEO_WORD.test(title) || VIDEO_WORD.test(subtitle)) return null;

  return {
    browseId,
    title,
    subtitle,
    thumb:
      bestThumb(
        o(o(o(renderer, "thumbnail"), "musicThumbnailRenderer"), "thumbnail")?.thumbnails ?? null
      ),
    type: pageType.includes("PODCAST")
      ? "podcast"
      : pageType.includes("ALBUM")
      ? "album"
      : pageType.includes("ARTIST")
        ? "artist"
        : pageType.includes("PLAYLIST")
          ? "playlist"
          : "other",
  };
}

/**
 * One page of search rows, plus the token for the next page — the mobile app's
 * parseSearchPage, line for line. The "All" tab's promoted card lives on the
 * card shelf (not in a responsive row), so it is read first; then every
 * ordinary row is classified, browse rows before track rows (an album row also
 * carries a "play album" videoId in its overlay, so the track check would
 * misread every album as a song). `includeVideos` is true only for the Videos
 * filter — the mixed page stays music-only.
 */
export function parseSearchPage(response: any, includeVideos: boolean): SearchPageResult {
  // Songs listed under an artist card print only "Song • 3:51" — the card
  // itself says who they are by.
  const billedTo = new Map<any, Credits>();
  const topResults: SearchRow[] = includeVideos
    ? []
    : collectRenderers(response, "musicCardShelfRenderer").flatMap((card): SearchRow[] => {
        const song = parseCardShelfSong(card);
        // The mixed All page stays music-only; music-video uploads belong
        // exclusively to the dedicated Videos tab.
        if (song) return song.isVideo ? [] : [{ kind: "top", song }];
        const browse = parseCardShelfBrowse(card);
        if (browse?.type === "artist") {
          for (const row of a(card, "contents") ?? []) {
            const item = o(row, "musicResponsiveListItemRenderer");
            if (item) billedTo.set(item, { artistId: browse.browseId, artistName: browse.title });
          }
        }
        return browse ? [{ kind: "browse", item: browse, top: true }] : [];
      });

  const rows = collectRenderers(response, "musicResponsiveListItemRenderer");
  const seen = new Set<string>();
  const parsed: SearchRow[] = [];

  for (const result of topResults) {
    if (result.kind === "top") {
      if (seenAdd(seen, `v:${result.song.id}`)) parsed.push(result);
    } else if (result.kind === "browse" && seenAdd(seen, `b:${result.item.browseId}`)) {
      parsed.push(result);
    }
  }
  for (const renderer of rows) {
    // Browse rows are tested first — see the doc comment above.
    const browse = parseBrowseItem(renderer);
    if (browse) {
      if (seenAdd(seen, `b:${browse.browseId}`)) parsed.push({ kind: "browse", item: browse });
    } else {
      const song = parseResponsiveListItem(renderer, billedTo.get(renderer));
      if (song && song.isVideo === includeVideos && seenAdd(seen, `v:${song.id}`)) {
        parsed.push({ kind: "track", song });
      }
    }
  }
  return { rows: parsed, continuation: continuationToken(response) };
}

/* ---------------- type-ahead (search suggestions) ---------------- */

/** The dropdown's shape: a few completions, then up to 12 rich rows. */
const SUGGEST_TEXT_MAX = 3;
const SUGGEST_RICH_MAX = 12;

/** Case- and normal-form-blind: "Beyoncé" typed decomposed still matches. */
const foldText = (t: string): string => t.normalize("NFC").trim().toLowerCase();

/** A page row; profiles ("other") have no page on the desktop to open. */
function browseSuggestion(item: BrowseItem): SearchSuggestion | null {
  if (item.type === "other") return null;
  return { kind: item.type, text: item.title, subtitle: item.subtitle, thumb: item.thumb, id: item.browseId, browse: item };
}

function playSuggestion(track: Track, kind: "song" | "video" | "episode", subtitle: string): SearchSuggestion {
  return { kind, text: track.title, subtitle, thumb: track.thumb, id: track.id, track };
}

/** One rich typeahead row, classified like a search row: pages before tracks. */
function suggestionRow(renderer: any): SearchSuggestion | null {
  const browse = parseBrowseItem(renderer);
  if (browse) {
    // The typeahead's artist rows print only the audience; search rows lead with the kind.
    const bare = browse.type === "artist" && !TYPE_WORDS.has(browse.subtitle.split(" • ")[0].trim().toLowerCase());
    return browseSuggestion(bare ? { ...browse, subtitle: ["Artist", browse.subtitle].filter(Boolean).join(" • ") } : browse);
  }
  const song = parseResponsiveListItem(renderer);
  if (!song) return null;
  const subtitle = text(o(o((a(renderer, "flexColumns") ?? [])[1], "musicResponsiveListItemFlexColumnRenderer"), "text"));
  if (radioVideoType(renderer, rowThumbnails(renderer)) === "episode") {
    return playSuggestion({ ...song, episode: true }, "episode", subtitle);
  }
  return playSuggestion(song, song.isVideo ? "video" : "song", subtitle);
}

/** Rich rows appended once per id, up to the dropdown's 12. */
function addRich(items: SearchSuggestion[], rows: Array<SearchSuggestion | null>): SearchSuggestion[] {
  const out = [...items];
  // One recording can come back under two ids (its song and its video, or a
  // re-upload): one row per title and artist.
  const twin = (s: SearchSuggestion): string => (s.track ? `${foldText(s.track.title)}|${foldText(s.track.artist)}` : "");
  const seen = new Set(out.flatMap((s) => [s.id ?? "", twin(s)]));
  let rich = out.filter((s) => s.kind).length;
  for (const row of rows) {
    if (rich >= SUGGEST_RICH_MAX) break;
    if (!row?.id || seen.has(row.id) || (twin(row) && seen.has(twin(row)))) continue;
    seen.add(row.id);
    seen.add(twin(row));
    out.push(row);
    rich++;
  }
  return out;
}

/**
 * The typeahead endpoint's answer: up to 3 completions — never the typed
 * query itself, which the dropdown's first row already offers — then its
 * rich rows, parsed by the search page's own row parsers.
 */
export function parseSearchSuggestions(response: any, query: string): SearchSuggestion[] {
  const seen = new Set([foldText(query)]);
  const texts: SearchSuggestion[] = [];
  for (const r of collectRenderers(response, "searchSuggestionRenderer")) {
    if (texts.length >= SUGGEST_TEXT_MAX) break;
    const t = text(o(r, "suggestion")).trim();
    if (t && seenAdd(seen, foldText(t))) texts.push({ text: t });
  }
  return addRich(texts, collectRenderers(response, "musicResponsiveListItemRenderer").map(suggestionRow));
}

/**
 * The typeahead ships about five rich rows; the search page's own rows top
 * them up to 12. A search row keeps no YouTube line for a song, so its reads
 * "Song • Artist", as the typeahead prints one.
 */
export function withSearchRows(items: SearchSuggestion[], rows: SearchRow[]): SearchSuggestion[] {
  return addRich(
    items,
    rows.map((row) => {
      if (row.kind === "browse") return browseSuggestion(row.item);
      const kind = row.song.episode ? "episode" : "song"; // the All page is music-only
      return playSuggestion(row.song, kind, `${kind === "episode" ? "Episode" : "Song"} • ${row.song.artist}`);
    })
  );
}

/* ---------------- browse pages (mobile pageOf) ---------------- */

function firstHeader(root: any): any {
  return HEADER_RENDERERS.map((name) => collectRenderers(root, name)[0]).find(Boolean) ?? null;
}

/** What a release or playlist page calls itself (mobile parseBrowseHeader). */
export function parseBrowseHeader(root: any): { title: string; subtitle: string; thumb: string; artistId?: string } | null {
  const header = firstHeader(root);
  if (!header) return null;
  const title = text(o(header, "title"));
  if (!title.trim()) return null;
  // Current headers split artist ("strapline") and release details ("subtitle")
  // across two lines; older ones pack everything into one of the two.
  const lines = HEADER_CREDIT_LINES.map((key) => text(o(header, key))).filter((t) => t.trim());
  const subtitle = [...new Set(lines)].join(" • ");
  // The artist link lives on the runs of those lines.
  let artistId: string | undefined;
  for (const key of HEADER_CREDIT_LINES) {
    for (const run of a(o(header, key), "runs") ?? []) {
      const browse = o(o(run, "navigationEndpoint"), "browseEndpoint");
      const id = s(browse, "browseId");
      const pageType = pageTypeOf(browse);
      if (id && pageType.includes("ARTIST")) {
        artistId = id;
        break;
      }
    }
    if (artistId) break;
  }
  return {
    title,
    subtitle,
    thumb: bestThumb(o(collectRenderers(header, "musicThumbnailRenderer")[0], "thumbnail")?.thumbnails),
    artistId,
  };
}

/** Who a release page is billed to, off its own header (mobile pageCredit). */
export function pageCredit(root: any): Credits {
  const header = firstHeader(root);
  if (!header) return {};
  const lines = HEADER_CREDIT_LINES.map((key) => a(o(header, key), "runs") ?? []);
  const parts = lines.flatMap((line) =>
    line
      .map((run) => s(run, "text") ?? "")
      .join("")
      .split(" • ")
      .map((p) => p.trim())
  );
  if (!parts.some((p) => RELEASE_WORDS.has(p.toLowerCase()))) return {};
  const credits = creditsOf(lines.flat());
  if (credits.artistName) return credits;
  const name = parts.find(
    (p) => p && !TYPE_WORDS.has(p.toLowerCase()) && !TALLY.test(p) && !YEAR.test(p) && !DURATION.test(p)
  );
  return { ...credits, artistName: name };
}

/** Layout-agnostic walk for every row that carries a videoId (mobile collectSongsDeep). */
export function collectSongsDeep(root: any): ParsedSong[] {
  const out = new Map<string, ParsedSong>();
  const credit = pageCredit(root);
  const visit = (node: any): void => {
    if (node == null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node.musicResponsiveListItemRenderer) {
      const song = parseResponsiveListItem(node.musicResponsiveListItemRenderer, credit);
      if (song && !out.has(song.id)) out.set(song.id, song);
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") visit(value);
    }
  };
  visit(root);
  return [...out.values()];
}

/**
 * A playlist page's own tracks, scoped to the playlist shelf so YouTube's
 * "Suggestions" shelf never reads as songs the user added (mobile
 * parsePlaylistShelf). Null off a page with nothing playlist-shaped in scope.
 */
export function parsePlaylistShelf(root: any): { songs: ParsedSong[]; continuation: string | null } | null {
  const scope =
    o(root, "continuationContents") ??
    o(o(o(root, "contents"), "twoColumnBrowseResultsRenderer"), "secondaryContents");
  if (!scope) return null;
  const playlistScope =
    o(scope, "musicPlaylistShelfContinuation") ?? collectRenderers(scope, "musicPlaylistShelfRenderer")[0];
  if (!playlistScope) return null;
  const credit = pageCredit(root);
  const songs = collectRenderers(playlistScope, "musicResponsiveListItemRenderer")
    .map((r) => parseResponsiveListItem(r, credit))
    .filter((t): t is ParsedSong => !!t)
    .filter((t, i, list) => list.findIndex((x) => x.id === t.id) === i);
  return { songs, continuation: continuationToken(playlistScope) };
}

/**
 * A later page of a playlist/album shelf. YouTube answers in one of two
 * shapes: the legacy `continuationContents.musicPlaylistShelfContinuation`,
 * or `onResponseReceivedActions` → `appendContinuationItemsAction` whose last
 * item is a `continuationItemRenderer` carrying the next token. A later page
 * has no header, so `credit` is the first page's (album rows print no artist).
 */
export function parsePlaylistContinuation(
  response: any,
  credit: Credits = {}
): { songs: ParsedSong[]; continuation: string | null } {
  const scope = o(o(response, "continuationContents"), "musicPlaylistShelfContinuation") ?? response;
  const songs = collectRenderers(scope, "musicResponsiveListItemRenderer")
    .map((r) => parseResponsiveListItem(r, credit))
    .filter((t): t is ParsedSong => !!t);
  return { songs, continuation: continuationToken(scope) };
}

/** The editorial blurb — "About the artist" / "About the album" (mobile parseDescription). */
export function parseDescription(root: any): string | null {
  const shelf = text(o(collectRenderers(root, "musicDescriptionShelfRenderer")[0], "description"));
  if (shelf.trim()) return shelf;
  for (const name of [...HEADER_RENDERERS, "musicImmersiveHeaderRenderer"]) {
    const onHeader = text(o(collectRenderers(root, name)[0], "description"));
    if (onHeader.trim()) return onHeader;
  }
  return null;
}

/**
 * One browse page of an album or playlist: header + tracks + description, the
 * mobile app's pageOf. Playlist pages are scoped to their own shelf; anything
 * else falls back to the layout-agnostic walk.
 */
export function parseReleasePage(
  response: any,
  browseId: string
): {
  kind: "album" | "playlist" | "other";
  header: { title: string; subtitle: string; thumb: string; artistId?: string } | null;
  tracks: ParsedSong[];
  continuation: string | null;
  description: string | null;
} {
  const header = parseBrowseHeader(response);
  const shelf = parsePlaylistShelf(response);
  const playlist = Boolean(shelf) || browseId.startsWith("VL") || browseId.startsWith("PL");
  const tracks = (shelf ? shelf.songs : collectSongsDeep(response)).map((t) => ({
    ...t,
    // Rows on a release page carry no art of their own — the sleeve hangs on
    // the page header once (album rows are numbered and artless, exactly as on
    // mobile). Anything the player sees for these tracks — the bar, the full
    // screen, ambient — wears the page's cover, so backfill it here.
    thumb: t.thumb || header?.thumb || "",
  }));
  return {
    kind: playlist ? "playlist" : header ? "album" : "other",
    header,
    tracks,
    continuation: shelf ? shelf.continuation : continuationToken(response),
    // YouTube writes blurbs for its own catalogue releases, not user playlists.
    description: playlist ? null : parseDescription(response),
  };
}

/* ---------------- podcasts ---------------- */

/** Episode rows of a podcast page (or a later page of it). */
export function parsePodcastEpisodes(
  root: any,
  show: { title: string; author: string; thumb: string }
): { episodes: PodcastEpisode[]; continuation: string | null } {
  const episodes: PodcastEpisode[] = [];
  for (const r of collectRenderers(root, "musicMultiRowListItemRenderer")) {
    const videoId = s(o(o(r, "onTap"), "watchEndpoint"), "videoId");
    const title = text(o(r, "title"));
    if (!videoId || !title.trim()) continue;
    const subtitle = text(o(r, "subtitle"));
    const description = text(o(r, "description"));
    episodes.push({
      id: videoId,
      title,
      artist: show.author || show.title,
      album: show.title,
      thumb: bestThumb(rowThumbnails(r)) || show.thumb,
      duration: 0,
      episode: true,
      ...(subtitle ? { published: subtitle.split(" • ").pop()?.trim() } : {}),
      ...(description ? { description: description.slice(0, 500) } : {}),
    });
  }
  return { episodes, continuation: continuationToken(root) };
}

/** A podcast show page: header, blurb and its first page of episodes. */
export function parsePodcastPage(response: any, id: string): PodcastPage & { continuation: string | null } {
  const header = parseBrowseHeader(response);
  const show = { title: header?.title ?? "Podcast", author: header?.subtitle ?? "", thumb: header?.thumb ?? "" };
  const { episodes, continuation } = parsePodcastEpisodes(response, show);
  return { id, ...show, description: parseDescription(response), episodes, continuation };
}

/** "1 hr 36 min", "37 min", "8 min 58 sec" — an episode row's printed length. */
const SPOKEN_LENGTH = /^(?:(\d+) hr)? ?(?:(\d+) min)? ?(?:(\d+) sec)?$/;

/**
 * YouTube Music's podcasts page (browseId FEmusic_non_music_audio, the page
 * behind music.youtube.com/podcasts) → its shelves in the page's order:
 * show cards ("Popular shows") and episode rows ("Popular episodes" and the
 * topic shelves). Only cards that open an MPSP show page count as shows;
 * shelves left empty are dropped.
 */
export function parsePodcastShelves(res: any): PodcastShelf[] {
  const out: PodcastShelf[] = [];
  for (const carousel of collectRenderers(res, "musicCarouselShelfRenderer")) {
    const shelf: PodcastShelf = {
      title: text(o(o(o(carousel, "header"), "musicCarouselShelfBasicHeaderRenderer"), "title")).trim(),
      shows: [],
      episodes: [],
    };
    for (const item of a(carousel, "contents") ?? []) {
      const card = o(item, "musicTwoRowItemRenderer");
      const id = s(o(o(card, "navigationEndpoint"), "browseEndpoint"), "browseId");
      const title = text(o(card, "title"));
      if (id?.startsWith("MPSP") && title.trim()) {
        const thumbnails = o(o(o(card, "thumbnailRenderer"), "musicThumbnailRenderer"), "thumbnail")?.thumbnails;
        shelf.shows.push({ id, title, author: text(o(card, "subtitle")), thumb: bestThumb(thumbnails) });
      }
      const row = o(item, "musicMultiRowListItemRenderer");
      if (!row) continue;
      // The show page's own row parser, so these carry exactly its episode marks;
      // each row names its show (secondTitle) where a show page has one header.
      const [episode] = parsePodcastEpisodes(item, { title: text(o(row, "secondTitle")) || "Podcast", author: "", thumb: "" }).episodes;
      const printed = text(o(o(o(row, "playbackProgress"), "musicPlaybackProgressRenderer"), "durationText")).split("•").pop() ?? "";
      // shortcut: English unit words only; other display languages list 0 (the player learns the length on play) — add their words if a market needs listed lengths.
      const [, h = "0", m = "0", sec = "0"] = SPOKEN_LENGTH.exec(printed.trim()) ?? [];
      if (episode) shelf.episodes.push({ ...episode, duration: +h * 3600 + +m * 60 + +sec });
    }
    if (shelf.title && (shelf.shows.length || shelf.episodes.length)) out.push(shelf);
  }
  return out;
}

/* ---------------- artist page (mobile parseArtistPage) ---------------- */

function artistHeaderPiece(header: any): any {
  return o(header, "musicImmersiveHeaderRenderer") ?? o(header, "musicVisualHeaderRenderer") ?? null;
}

function artistThumbnail(header: any): string {
  if (!header) return "";
  const immersive = o(header, "musicImmersiveHeaderRenderer");
  const visual = o(header, "musicVisualHeaderRenderer");
  const renderer =
    o(o(immersive, "thumbnail"), "musicThumbnailRenderer") ??
    o(o(visual, "foregroundThumbnail"), "musicThumbnailRenderer") ??
    o(o(visual, "thumbnail"), "musicThumbnailRenderer") ??
    collectRenderers(header, "musicThumbnailRenderer")[0];
  return bestThumb(o(renderer, "thumbnail")?.thumbnails);
}

function artistNameOf(header: any): string | null {
  const name = text(o(artistHeaderPiece(header), "title"));
  return name.trim() ? name : null;
}

/** "3.4M monthly listeners", off the header. */
function monthlyListeners(header: any): string | null {
  return firstRunText(o(o(header, "musicImmersiveHeaderRenderer"), "monthlyListenerCount"));
}

/** "1.2M subscribers" — off the header's subscribe button, across both shapes. */
function subscriberCount(header: any): string | null {
  const immersive = o(header, "musicImmersiveHeaderRenderer");
  if (!immersive) return null;
  const button2 = o(o(immersive, "subscriptionButton2"), "subscribeButtonRenderer");
  const button1 = o(o(immersive, "subscriptionButton"), "subscribeButtonRenderer");
  return (
    text(o(button2, "subscriberCountWithSubscribeText")).trim() ||
    text(o(button1, "longSubscriberCountText")).trim() ||
    text(o(button1, "shortSubscriberCountText")).trim() ||
    null
  );
}

/** Home/carousel cards — mobile parseTwoRowItem. */
function parseTwoRowItem(renderer: any): { item: HomeItem; browseId: string | null } | null {
  if (!renderer) return null;
  const title = text(o(renderer, "title"));
  if (!title.trim()) return null;
  const endpoint = o(renderer, "navigationEndpoint");
  const rawBrowseId = s(o(endpoint, "browseEndpoint"), "browseId");
  // History-style cards for uncatalogued uploads carry MPED<videoId> as their
  // "browse" id — that's the actual video id, not a real browsable page.
  const videoId =
    s(o(endpoint, "watchEndpoint"), "videoId") ??
    (rawBrowseId && rawBrowseId.startsWith("MPED") ? rawBrowseId.slice("MPED".length) : null);
  const browseId = rawBrowseId && !rawBrowseId.startsWith("MPED") ? rawBrowseId : null;
  const thumbnails =
    o(o(o(renderer, "thumbnailRenderer"), "musicThumbnailRenderer"), "thumbnail")?.thumbnails ?? null;
  const subtitle = text(o(renderer, "subtitle"));
  // A playable card with widescreen art is a music video, not an album — drop
  // it; a browsable card with "videos" in its billing is a dead end — drop it.
  if (!browseId && videoId && isNotSquare(thumbnails)) return null;
  if (browseId && (VIDEO_WORD.test(title) || VIDEO_WORD.test(subtitle))) return null;

  const thumb = bestThumb(thumbnails);
  let item: HomeItem;
  if (browseId?.startsWith("UC")) {
    item = { kind: "artist", artist: { id: browseId, name: title, thumb, subtitle } };
  } else if (browseId?.startsWith("MPREb")) {
    item = { kind: "album", album: { id: browseId, title, artist: subtitle, thumb } };
  } else if (browseId) {
    item = { kind: "playlist", playlist: { id: browseId, title, thumb, subtitle } };
  } else if (videoId) {
    item = { kind: "track", track: { id: videoId, title, artist: subtitle || "Unknown artist", duration: 0, thumb } };
  } else {
    return null;
  }
  return { item, browseId };
}

/**
 * A moods & genres category page (Explore → a card): its title and every
 * shelf in the page's order — songs, playlists, albums, artists. Music videos
 * are dropped, as on every other page: ByTune plays songs.
 */
export function parseMoodPage(res: any): MoodPage {
  const title = text(o(o(o(res, "header"), "musicHeaderRenderer"), "title")).trim();
  const tabs = a(o(o(res, "contents"), "singleColumnBrowseResultsRenderer"), "tabs");
  const sections = a(o(o(o(tabs?.[0], "tabRenderer"), "content"), "sectionListRenderer"), "contents") ?? [];
  const shelves: HomeShelf[] = [];
  for (const section of sections) {
    const carousel = o(section, "musicCarouselShelfRenderer");
    const grid = o(section, "gridRenderer");
    const list = o(section, "musicShelfRenderer");
    const heading = text(
      carousel
        ? o(o(o(carousel, "header"), "musicCarouselShelfBasicHeaderRenderer"), "title")
        : grid
          ? o(o(o(grid, "header"), "gridHeaderRenderer"), "title")
          : o(list, "title")
    ).trim();
    const items: HomeItem[] = [];
    for (const row of a(list, "contents") ?? []) {
      const song = parseResponsiveListItem(o(row, "musicResponsiveListItemRenderer"));
      if (song) items.push({ kind: "track", track: song });
    }
    for (const card of (carousel ? a(carousel, "contents") : a(grid, "items")) ?? []) {
      const parsed = parseTwoRowItem(o(card, "musicTwoRowItemRenderer"));
      if (parsed) items.push(parsed.item);
    }
    if (heading && items.length) shelves.push({ title: heading, items });
  }
  return { title, shelves };
}

/** Artist landing page: "Top songs" shelf plus section carousels, in order. */
export function parseArtistPage(response: any): {
  name: string | null;
  thumb: string;
  description: string | null;
  subscriberCount: string | null;
  monthlyListeners: string | null;
  songs: ParsedSong[];
  shelves: HomeShelf[];
} {
  const tabs = a(o(o(response, "contents"), "singleColumnBrowseResultsRenderer"), "tabs");
  const sections =
    a(o(o(o(tabs?.[0], "tabRenderer"), "content"), "sectionListRenderer"), "contents") ?? [];

  const header = response?.header ?? null;
  // "Top songs" rows are billed by the page they sit on: the header is the credit.
  const credit: Credits = { artistName: artistNameOf(header) ?? undefined };

  const songs: ParsedSong[] = [];
  const shelves: HomeShelf[] = [];
  for (const section of sections) {
    const shelf = o(section, "musicShelfRenderer");
    if (shelf) {
      for (const row of a(shelf, "contents") ?? []) {
        const song = parseResponsiveListItem(o(row, "musicResponsiveListItemRenderer"), credit);
        if (song && !songs.some((x) => x.id === song.id)) songs.push(song);
      }
    }
    const carousel = o(section, "musicCarouselShelfRenderer");
    if (carousel) {
      const carouselHeader = o(o(carousel, "header"), "musicCarouselShelfBasicHeaderRenderer");
      const title = text(o(carouselHeader, "title"));
      if (VIDEO_WORD.test(title)) continue;
      const items: HomeItem[] = [];
      for (const card of a(carousel, "contents") ?? []) {
        const parsed = parseTwoRowItem(o(card, "musicTwoRowItemRenderer"));
        // The artist page's shelves are pages to open, not tracks to play —
        // the songs live in the shelf above.
        if (parsed && parsed.browseId) items.push(parsed.item);
      }
      if (title.trim() && items.length) shelves.push({ title, items });
    }
  }
  return {
    name: artistNameOf(header),
    thumb: artistThumbnail(header),
    description: parseDescription(response),
    subscriberCount: subscriberCount(header),
    monthlyListeners: monthlyListeners(header),
    songs,
    shelves,
  };
}

/* ---------------- remote playlist header (mobile DetailScreen header lines) ---------------- */

/** The curator's name off the header's avatar stack, when the page ships one. */
function facepileName(header: any): string | null {
  const name = o(o(header, "facepile"), "avatarStackViewModel")?.text?.content;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

/** A remote (YouTube) playlist page's header + track list. */
export function parseRemotePlaylistPage(response: any, playlistId: string, moreTracks: Track[] = []): RemotePlaylistPage {
  void playlistId;
  const header = firstHeader(response);
  const shelf = parsePlaylistShelf(response);
  const pageThumb = bestThumb(o(collectRenderers(header, "musicThumbnailRenderer")[0], "thumbnail")?.thumbnails);
  // Later pages (moreTracks) join the first so the count and every action
  // see the whole playlist, not its first ~100 songs.
  const seen = new Set<string>();
  const tracks = [...(shelf?.songs ?? collectSongsDeep(response)), ...moreTracks]
    .filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)))
    .map((t) => ({
      ...t,
      thumb: t.thumb || pageThumb,
    }));
  // The mobile DetailScreen splits the header's billing into two lines: the
  // credit ("Marie Liesegang, 105 views") and the uppercase metadata line
  // ("PLAYLIST • 7 TRACKS"). headerLines: year and the kind word drop out of
  // the credit; the meta is kind, year, track count.
  const parts = HEADER_CREDIT_LINES.flatMap((key) => text(o(header, key)).split("•"))
    .map((p) => p.trim())
    .filter(Boolean);
  const year = [...parts].reverse().find((p) => YEAR.test(p));
  const kind = parts.find((p) => p.toLowerCase() === "playlist") ?? "Playlist";
  let credit = parts.filter((p) => p !== year && p.toLowerCase() !== "playlist").join(", ");
  // Newer headers move the curator to the avatar stack and the counts to a
  // second subtitle ("105 views • 7 tracks • 28 minutes"); both say what the
  // old subtitle said, so they join the credit the same way.
  const curator = facepileName(header);
  if (curator && !credit.toLowerCase().includes(curator.toLowerCase())) {
    credit = credit ? `${curator}, ${credit}` : curator;
  }
  const views = text(o(header, "secondSubtitle"))
    .split("•")
    .map((p) => p.trim())
    .find((p) => /view/i.test(p));
  if (views && !credit.toLowerCase().includes(views.toLowerCase())) {
    credit = credit ? `${credit}, ${views}` : views;
  }
  const meta = [
    kind,
    year,
    tracks.length ? `${tracks.length} ${tracks.length === 1 ? "track" : "tracks"}` : "",
  ]
    .filter(Boolean)
    .join(" • ")
    .toUpperCase();
  return {
    title: text(o(header, "title")) || "Playlist",
    credit,
    meta,
    thumb: pageThumb,
    tracks,
  };
}

/* ---------------- track credits off the watch queue ---------------- */

/**
 * One track's full credits, read off its own row in the watch queue (`next`)
 * response — "Lana Del Rey • Born To Die • 2011 • 3:43", the line the player
 * is served regardless of how bare the row that queued it was. This is what
 * the lyrics lookup needs when a search row shipped no credit ("Unknown
 * artist", as the mixed All page prints), and what BitChord mobile's
 * parseWatchQueue reads from the same renderer.
 */
export function parseQueueCredits(
  response: any,
  videoId: string
): { artist: string; album?: string; durationSec: number } | null {
  const row = collectRenderers(response, "playlistPanelVideoRenderer").find((r) => s(r, "videoId") === videoId);
  if (!row) return null;
  const bylineRuns = a(o(row, "longBylineText"), "runs") ?? [];
  const byline = bylineRuns.map((run) => s(run, "text") ?? "");
  // The credit is everything before the first bullet; album and year follow.
  const firstBullet = byline.findIndex((t) => t.includes("•"));
  const artist = (
    firstBullet === -1 ? byline.join("") : byline.slice(0, firstBullet).join("")
  ).trim();
  const credits = creditsOf(bylineRuns);
  const album =
    credits.albumName ??
    (firstBullet !== -1
      ? byline
          .slice(firstBullet + 1)
          .join("")
          .split("•")
          .map((p) => p.trim())
          .find((p) => p && !YEAR.test(p) && !TALLY.test(p))
      : undefined);
  // "3:43" or "1:02:33".
  const lengthParts = text(o(row, "lengthText"))
    .trim()
    .split(":")
    .map((p) => parseInt(p, 10));
  const durationSec = lengthParts.length >= 2 && lengthParts.every(Number.isFinite)
    ? lengthParts.reduce((acc, p) => acc * 60 + p, 0)
    : 0;
  return {
    artist,
    album: album || undefined,
    durationSec,
  };
}

/* ---------------- song radio (endless AutoPlay) ---------------- */

/** "3:43" or "1:02:33" → seconds; 0 when it isn't a clock. */
function clockSeconds(v: string): number {
  const parts = v.trim().split(":").map((p) => parseInt(p, 10));
  return parts.length >= 2 && parts.every(Number.isFinite) ? parts.reduce((acc, p) => acc * 60 + p, 0) : 0;
}

/** The artist credit off a queue row's byline: everything before the first bullet. */
function bylineArtist(runs: any[]): string {
  const byline = runs.map((run) => s(run, "text") ?? "");
  const firstBullet = byline.findIndex((t) => t.includes("•"));
  return (firstBullet === -1 ? byline.join("") : byline.slice(0, firstBullet).join("")).trim();
}

function radioVideoType(row: any, thumbnails: any): RadioTrack["videoType"] {
  const type = s(
    o(
      o(o(o(row, "navigationEndpoint"), "watchEndpoint"), "watchEndpointMusicSupportedConfigs"),
      "watchEndpointMusicConfig"
    ),
    "musicVideoType"
  );
  if (type === "MUSIC_VIDEO_TYPE_ATV") return "song";
  if (type === "MUSIC_VIDEO_TYPE_UGC") return "upload";
  if (type === "MUSIC_VIDEO_TYPE_PODCAST_EPISODE") return "episode";
  if (type) return "video";
  return isNotSquare(thumbnails) ? "video" : "song";
}

function radioRow(row: any): RadioTrack | null {
  const videoId = s(row, "videoId") ?? s(o(o(row, "navigationEndpoint"), "watchEndpoint"), "videoId");
  const title = text(o(row, "title")).trim();
  if (!videoId || !title) return null;
  const runs = a(o(row, "longBylineText"), "runs") ?? [];
  const credits = creditsOf(runs);
  const thumbnails = o(row, "thumbnail")?.thumbnails ?? null;
  return {
    id: videoId,
    title,
    artist: bylineArtist(runs) || credits.artistName || "Unknown artist",
    artistId: credits.artistId,
    album: credits.albumName,
    albumId: credits.albumId,
    duration: clockSeconds(text(o(row, "lengthText"))),
    thumb: bestThumb(thumbnails),
    explicit: hasExplicitBadge(row.badges) || undefined,
    videoType: radioVideoType(row, thumbnails),
  };
}

/**
 * One page of a song's radio (`next` on playlist RDAMVM<id>, or a
 * continuation of it). Wrapper rows pair a song with its music video — the
 * song side is kept, so a recording never arrives twice. The seed row itself,
 * unplayable rows and the automix preview are left out.
 */
export function parseRadioPage(response: any, seedId: string): RadioPage {
  const panel =
    o(o(response, "continuationContents"), "playlistPanelContinuation") ??
    collectRenderers(response, "playlistPanelRenderer")[0] ??
    null;
  const tracks: RadioTrack[] = [];
  let seed: RadioPage["seed"] = null;
  for (const item of a(panel, "contents") ?? []) {
    let row = o(item, "playlistPanelVideoRenderer");
    const wrapper = o(item, "playlistPanelVideoWrapperRenderer");
    if (wrapper) {
      const sides = [
        o(o(wrapper, "primaryRenderer"), "playlistPanelVideoRenderer"),
        ...(a(wrapper, "counterpart") ?? []).map((c: any) =>
          o(o(c, "counterpartRenderer"), "playlistPanelVideoRenderer")
        ),
      ].filter(Boolean);
      row = sides.find((side: any) => radioRow(side)?.videoType === "song") ?? sides[0] ?? null;
    }
    if (!row || o(row, "unplayableText")) continue;
    const track = radioRow(row);
    if (!track) continue;
    if (row.selected === true || track.id === seedId) {
      seed ??= { artist: track.artist, artistId: track.artistId };
      continue;
    }
    tracks.push(track);
  }
  const continuation = (a(panel, "continuations") ?? [])[0];
  const next =
    s(o(continuation, "nextRadioContinuationData"), "continuation") ??
    s(o(continuation, "nextContinuationData"), "continuation");
  return { tracks, next, seed };
}

/* ---------------- cards from browse rows ---------------- */

/** "Single • Lana Del Rey • 2023" → an album card, the way the row shows it. */
export function browseToAlbum(item: BrowseItem): Album {
  const parts = item.subtitle.split("•").map((p) => p.trim());
  const year = parts.find((p) => YEAR.test(p));
  const credit = parts.filter((p) => p !== year && !RELEASE_WORDS.has(p.toLowerCase()) && p.toLowerCase() !== "playlist");
  return { id: item.browseId, title: item.title, artist: credit.join(", ") || "Unknown artist", year, thumb: item.thumb };
}

export function browseToArtist(item: BrowseItem): Artist {
  return { id: item.browseId, name: item.title, thumb: item.thumb, subtitle: item.subtitle };
}
