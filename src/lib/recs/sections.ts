/**
 * Section builder — turns the taste profile + candidate bundles into an
 * ordered Home feed. This is the only place that decides WHAT appears on
 * Home, in WHICH order, under WHICH title.
 *
 * Pipeline (per the engine's contract):
 *   descriptors (priority from real signals) → learned boost (the rows you
 *   play from rise; stores/homeEngagement) → sort → build sequentially
 *   against shared dedup pools → diversity pass (no same-anchor neighbours,
 *   per-artist caps) → cap → Home feed.
 *
 * The shape of Home, top to bottom: what you were just playing (Jump back
 * in), playlists picked for your taste (the crate), your mixes — one per side
 * of your taste (sides.ts) — then what's in heavy rotation, more like the
 * artists you're into lately, fresh releases from your artists, old
 * favourites to dust off, and slower-moving rows below. Familiar rows and
 * discovery rows alternate; every mix is about three parts familiar to one
 * part new.
 *
 * Determinism: priorities and item picks are pure functions of the profile;
 * the only seed is the day bucket, so equal-scored items rotate daily and
 * never per-render. Inclusion is honest — a section only exists when the
 * data behind its title exists (no "More like X" without X).
 */
import type { Album, Artist, HomeShelf, PlaylistCard, Track } from "../../types";
import type { ArtistBundle } from "./candidates";
import type { ArtistSignal, TasteProfile } from "./profile";
import type { PlaySource } from "./playback";
import { hash32, seededShuffle } from "./seeded";
import { findSides } from "./sides";
import { artistKeyOf, artistsInLine, rankByTaste } from "./taste";

/* ------------------------------------------------------------------ types */

export type SectionLayout = "tiles" | "row" | "circles" | "mixes" | "radios" | "yt-shelf" | "moods" | "crate" | "list";

export type SectionItem =
  /** `note`: a list row's side line ("6 plays lately") */
  | { style: "track"; track: Track; note?: string }
  | { style: "album"; album: Album }
  | { style: "artist"; artist: Artist }
  | { style: "mix"; id: string; name: string; thumb: string | null; caption: string; source: PlaySource }
  | { style: "radio"; id: string; name: string; thumb: string | null; caption: string; source: PlaySource }
  /** one side of your taste as a mix: its letter, artists and cover collage */
  | { style: "side"; id: string; letter: string; caption: string; thumbs: string[]; count: number; fresh: number; source: PlaySource };

export interface HomeSection {
  /** stable identity — "more-like-<artistId>", "stations", … */
  id: string;
  /** the row's kind ("more-like", "heavy-rotation", …) — what Home's learned order counts taps on */
  kind: string;
  title: string;
  subtitle?: string;
  /** eyebrow header card ("More like / The Weeknd") for artist-anchored rows */
  eyebrow?: { label: string; name: string; thumb: string | null; artistId: string };
  /** the artist this section leans on — diversity pass keeps these apart */
  anchorKey?: string;
  layout: SectionLayout;
  priority: number;
  items: SectionItem[];
  /** layout "yt-shelf" passthrough */
  shelf?: HomeShelf;
  /** layout "moods" chip labels */
  moods?: string[];
  /** layout "crate" records */
  playlists?: PlaylistCard[];
}

interface BuildCtx {
  profile: TasteProfile;
  bundles: Map<string, ArtistBundle>;
  usedTracks: Set<string>;
  usedAlbums: Set<string>;
  /** "Not interested" songs: never on Home */
  hidden: ReadonlySet<string>;
}

/* ---------------------------------------------------------------- helpers */

function takeTracks(
  ctx: BuildCtx,
  pool: Track[],
  opts: { count: number; maxPerArtist?: number; unplayedOnly?: boolean }
): Track[] {
  const maxPerArtist = opts.maxPerArtist ?? 3;
  const perArtist = new Map<string, number>();
  const out: Track[] = [];
  for (const t of pool) {
    if (out.length >= opts.count) break;
    if (ctx.usedTracks.has(t.id) || ctx.hidden.has(t.id)) continue;
    if (opts.unplayedOnly && ctx.profile.playedTrackIds.has(t.id)) continue;
    const key = t.artist.trim().toLowerCase();
    const n = perArtist.get(key) ?? 0;
    if (n >= maxPerArtist) continue;
    perArtist.set(key, n + 1);
    ctx.usedTracks.add(t.id);
    out.push(t);
  }
  return out;
}

/** Shuffle a pool deterministically per day so equal-scored picks rotate. */
function dailyRotation<T>(items: readonly T[], seedKey: string, daySeed: number): T[] {
  return seededShuffle(items, hash32(seedKey) ^ daySeed);
}

function artistsWithIds(artists: readonly ArtistSignal[]): ArtistSignal[] {
  return artists.filter((a) => a.artistId);
}

function bundleFor(ctx: BuildCtx, artist: ArtistSignal): ArtistBundle | null {
  return (artist.artistId ? ctx.bundles.get(artist.artistId) : undefined) ?? null;
}

function captionWith(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `With ${names[0]}`;
  if (names.length === 2) return `With ${names[0]} and ${names[1]}`;
  return `With ${names[0]}, ${names[1]} and ${names[2]}`;
}

/** "A", "A & B", "A, B & C" */
function namesLine(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} & ${names[names.length - 1]}`;
}

function hourAwareTodayTitle(now: number): string {
  const h = new Date(now).getHours();
  if (h < 5) return "Late night picks";
  if (h < 12) return "Picks for your morning";
  if (h < 17) return "Recommended for today";
  if (h < 22) return "Recommended for tonight";
  return "Late night picks";
}

/** Unplayed songs surfaced by an artist's related-artists shelf. */
function relatedSongPool(ctx: BuildCtx, bundle: ArtistBundle): Track[] {
  const pool: Track[] = [];
  for (const rel of bundle.related) {
    const relBundle = ctx.bundles.get(rel.id);
    if (relBundle) pool.push(...relBundle.topSongs);
  }
  return pool;
}

/**
 * An artist page bills its own releases "2026" or "Single • 2025" — the
 * card parser files that line as the artist. Read the year and kind out of
 * it and put the artist's name back.
 */
function asRelease(album: Album, artistName: string): Album {
  const parts = album.artist.split("•").map((p) => p.trim()).filter(Boolean);
  const year = album.year ?? parts.find((p) => /^\d{4}$/.test(p));
  const kind = album.releaseType ?? parts.find((p) => /^(album|single|ep)$/i.test(p));
  const credit = parts.filter((p) => !/^\d{4}$/.test(p) && !/^(album|single|ep)$/i.test(p)).join(", ");
  return { ...album, artist: credit || artistName, ...(year ? { year } : {}), ...(kind ? { releaseType: kind } : {}) };
}

/** A crate needs a few records to flip through. */
const CRATE_MIN = 6;

/** The market's playlists for Home's crate, each once: YouTube Music's own (RDCLAK5uy_ ids) ahead of community uploads. */
function cratePlaylists(market: HomeShelf[] | null | undefined): PlaylistCard[] {
  const seen = new Set<string>();
  const all = (market ?? []).flatMap((s) =>
    s.items.flatMap((i) => (i.playlist && !seen.has(i.playlist.id) && !!seen.add(i.playlist.id) ? [i.playlist] : []))
  );
  const own = (p: PlaylistCard): boolean => p.id.includes("RDCLAK5uy_");
  return [...all.filter(own), ...all.filter((p) => !own(p))];
}

/** Each artist you play, 0..1 by score — split out of "A & B" credits so a playlist's artist line can match it. */
function tasteAffinity(artists: readonly ArtistSignal[]): Map<string, number> {
  const top = Math.max(1e-9, ...artists.map((a) => a.score));
  const out = new Map<string, number>();
  for (const a of artists) {
    if (a.score <= 0) continue;
    for (const key of artistsInLine(a.name)) out.set(key, Math.max(out.get(key) ?? 0, a.score / top));
  }
  return out;
}

const SIDE_LETTERS = ["A", "B", "C", "D"];
const MIX_LENGTH = 30;

/**
 * One side of your taste as a mix: your own songs by its artists first, then
 * their best-known songs, with one new song (from artists next to the side,
 * never played) in every four. A mix is a queue description, so it doesn't
 * spend the visible rows' dedup pool.
 */
function sideMix(ctx: BuildCtx, members: ArtistSignal[], letter: string): Extract<SectionItem, { style: "side" }> | null {
  const keys = new Set(members.map((m) => m.key));
  const memberIds = new Set(members.flatMap((m) => (m.artistId ? [m.artistId] : [])));
  const seed = `side-${[...keys].sort().join("+")}`;
  const ofSide = (t: Track): boolean => artistsInLine(t.artist).some((k) => keys.has(k)) || keys.has(artistKeyOf(t.artist));

  const yours = dailyRotation(
    [...ctx.profile.heavyRotation.map((r) => r.track), ...ctx.profile.recentlyPlayed, ...ctx.profile.liked].filter(ofSide),
    `${seed}-yours`,
    ctx.profile.daySeed
  );
  const theirs = dailyRotation(members.flatMap((m) => bundleFor(ctx, m)?.topSongs ?? []), `${seed}-theirs`, ctx.profile.daySeed);
  const neighbours = members
    .flatMap((m) => bundleFor(ctx, m)?.related ?? [])
    .filter((r) => !memberIds.has(r.id))
    .flatMap((r) => ctx.bundles.get(r.id)?.topSongs ?? [])
    .filter((t) => !ctx.profile.playedTrackIds.has(t.id));
  const fresh = dailyRotation(neighbours, `${seed}-new`, ctx.profile.daySeed);

  const familiar = [...yours, ...theirs];
  const seen = new Set<string>();
  const perArtist = new Map<string, number>();
  const take = (pool: Track[]): Track | null => {
    while (pool.length) {
      const t = pool.shift() as Track;
      const who = artistKeyOf(t.artist);
      if (seen.has(t.id) || ctx.hidden.has(t.id) || (perArtist.get(who) ?? 0) >= 4) continue;
      seen.add(t.id);
      perArtist.set(who, (perArtist.get(who) ?? 0) + 1);
      return t;
    }
    return null;
  };
  const mix: Track[] = [];
  let newOnes = 0;
  while (mix.length < MIX_LENGTH) {
    const wantNew = mix.length % 4 === 3;
    const first = wantNew ? fresh : familiar;
    let t = take(first);
    if (t && wantNew) newOnes++;
    if (!t) {
      t = take(wantNew ? familiar : fresh);
      if (t && !wantNew) newOnes++;
    }
    if (!t) break;
    mix.push(t);
  }
  if (mix.length < 10) return null;

  const thumbs = [...new Set(mix.map((t) => t.thumb).filter(Boolean))].slice(0, 4);
  return {
    style: "side",
    id: `${seed}-${letter}`,
    letter,
    caption: namesLine(members.slice(0, 3).map((m) => m.name)),
    thumbs,
    count: mix.length,
    fresh: newOnes,
    source: { type: "tracks", tracks: mix, label: `Side ${letter}` },
  };
}

function monthYear(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: "short", year: "numeric" });
}

/* -------------------------------------------------------------- descriptors */

interface Descriptor {
  id: string;
  kind: string;
  priority: number;
  anchorKey?: string;
  /** sections with fewer live items than this are dropped (default 3) */
  minItems?: number;
  build: (ctx: BuildCtx) => Omit<HomeSection, "kind"> | null;
}

/** Rows that keep their place whatever you tap: what you just played, the crate, and the cold-start chips. */
const PINNED = new Set(["jump-back-in", "playlists-for-you", "browse"]);

/** Up to +10 for the rows you play from (taps fade over ~10 days); never past the pinned rows. */
function learnedBoost(taps: number): number {
  return 10 * (1 - Math.exp(-taps / 2));
}

function describeFeed(
  profile: TasteProfile,
  ytShelves: HomeShelf[] | null,
  now: number,
  moods?: string[],
  market?: HomeShelf[] | null
): Descriptor[] {
  const list: Descriptor[] = [];
  const top = artistsWithIds(profile.artists).slice(0, 6);
  const maxScore = top[0]?.score ?? 1;
  // Who the artist rows lean on: the artists you're into lately first, then your long-term favourites.
  const lately = artistsWithIds(profile.lately);
  const anchors = [...lately, ...top.filter((a) => !lately.some((l) => l.key === a.key))];

  /* ---- jump back in — the tiles, straight from history ---- */
  if (profile.recentlyPlayed.length >= 4) {
    const lastAt = profile.artists.reduce((m, a) => Math.max(m, a.lastPlayedAt ?? 0), 0);
    const hoursSince = lastAt ? (now - lastAt) / 3_600_000 : Infinity;
    list.push({
      id: "jump-back-in",
      kind: "jump-back-in",
      priority: 95 + (hoursSince < 8 ? 5 : 0),
      build: (ctx) => ({
        id: "jump-back-in",
        title: "Jump back in",
        layout: "tiles",
        priority: 0,
        // "Not interested" means off Home, the tiles included.
        items: ctx.profile.recentlyPlayed
          .filter((t) => !ctx.hidden.has(t.id))
          .slice(0, 6)
          .map((track) => ({ style: "track", track })),
      }),
    });
  }

  /* ---- playlists for you — the market's playlists as a crate, right under
          the tiles, whatever the maturity; the ones whose artists you play
          come first ---- */
  const crate = rankByTaste(cratePlaylists(market), tasteAffinity(profile.artists));
  const crated = crate.length >= CRATE_MIN;
  if (crated) {
    list.push({
      id: "playlists-for-you",
      kind: "playlists-for-you",
      priority: 94,
      minItems: 0, // content rides the `playlists` field, not `items`
      build: () => ({
        id: "playlists-for-you",
        title: "Playlists for you",
        layout: "crate",
        priority: 0,
        items: [],
        playlists: crate,
      }),
    });
  }

  /* ---- cold start: browse chips + YouTube's own feed ---- */
  // The chips are the provider's own per-market moods & genres (passed in by
  // the feed once known). No moods yet → no chips yet: they arrive with the
  // next paint rather than flashing a hardcoded/fallback list.
  if (profile.maturity === "cold" && moods && moods.length > 0) {
    list.push({
      id: "browse",
      kind: "browse",
      priority: 90,
      minItems: 0, // content rides the `moods` field, not `items`
      build: () => ({
        id: "browse",
        title: "Browse",
        subtitle: "Common searches to get you started",
        layout: "moods",
        priority: 0,
        items: [],
        moods: moods.slice(0, 8),
      }),
    });
  }

  /* ---- your mixes — one per side of your taste, topped up with artist mixes ---- */
  if (top.length >= 2) {
    list.push({
      id: "your-mixes",
      kind: "your-mixes",
      priority: 88,
      minItems: 2,
      build: (ctx) => {
        const sides = findSides(ctx.profile.artists.slice(0, 8), (id) => ctx.bundles.get(id)?.related.map((r) => r.id), ctx.profile.pairs);
        const items: SectionItem[] = [];
        for (const members of sides) {
          const item = sideMix(ctx, members, SIDE_LETTERS[items.length]);
          if (item) items.push(item);
        }
        const inSide = new Set(sides.flat().map((a) => a.key));
        for (const a of top) {
          if (items.length >= 4) break;
          if (inSide.has(a.key)) continue;
          const b = bundleFor(ctx, a);
          const relNames = b?.related.slice(0, 3).map((r) => r.name) ?? [];
          items.push({
            style: "mix",
            id: `${a.artistId}-mix`,
            name: `${a.name} Mix`,
            thumb: b?.thumb ?? a.thumb,
            caption: relNames.length ? captionWith(relNames) : a.name,
            source: { type: "artist-mix", artistId: a.artistId as string, name: `${a.name} Mix` },
          });
        }
        const sided = items.some((i) => i.style === "side");
        return items.length >= 2
          ? {
              id: "your-mixes",
              title: "Your mixes",
              subtitle: sided ? "One for each side of your taste, with a few new songs in each" : undefined,
              layout: "mixes",
              priority: 0,
              items,
            }
          : null;
      },
    });
  }

  /* ---- heavy rotation — the songs you keep coming back to right now ---- */
  if (profile.heavyRotation.length >= 4) {
    list.push({
      id: "heavy-rotation",
      kind: "heavy-rotation",
      priority: 84,
      minItems: 4,
      build: (ctx) => {
        const items: SectionItem[] = ctx.profile.heavyRotation
          .filter((r) => !ctx.hidden.has(r.track.id))
          .slice(0, 16)
          .map((r) => ({ style: "track", track: r.track, note: `${r.listens} ${r.listens === 1 ? "play" : "plays"} lately` }));
        return { id: "heavy-rotation", title: "Heavy rotation", subtitle: "What you keep coming back to", layout: "list", priority: 0, items };
      },
    });
  }

  /* ---- your favorite artists — ranked purely by behavior ---- */
  if (top.length >= 3) {
    list.push({
      id: "favorite-artists",
      kind: "favorite-artists",
      priority: 64 + (profile.maturity === "strong" ? 6 : 0),
      build: (ctx) => {
        const items = top.slice(0, 8).map((a) => ({
          style: "artist" as const,
          artist: {
            id: a.artistId as string,
            name: a.name,
            thumb: bundleFor(ctx, a)?.thumb ?? a.thumb ?? "",
          },
        }));
        return {
          id: "favorite-artists",
          title: "Your favorite artists",
          layout: "circles",
          priority: 0,
          items,
        };
      },
    });
  }

  /* ---- more like [artist] — the artists you're into lately lead ---- */
  anchors.slice(0, 2).forEach((anchor, i) => {
    list.push({
      id: `more-like-${anchor.key}`,
      kind: "more-like",
      anchorKey: anchor.key,
      priority: 56 + 24 * Math.min(1, Math.max(0, anchor.score) / maxScore) - i * 4,
      build: (ctx) => {
        const b = bundleFor(ctx, anchor);
        if (!b) return null;
        const items: SectionItem[] = [];
        const relNames = b.related.slice(0, 3).map((r) => r.name);
        items.push({
          style: "radio",
          id: `${b.artistId}-radio`,
          name: anchor.name,
          thumb: b.thumb ?? anchor.thumb,
          caption: relNames.length ? captionWith(relNames) : "Radio",
          source: { type: "artist-radio", artistId: b.artistId as string, name: `${anchor.name} Radio` },
        });
        for (const rel of b.related.slice(0, 3)) {
          items.push({ style: "artist", artist: rel });
        }
        const album = b.albums.find((al) => !ctx.usedAlbums.has(al.id));
        if (album) {
          ctx.usedAlbums.add(album.id);
          items.push({ style: "album", album: asRelease(album, b.name) });
        }
        if (items.length < 3) return null;
        return {
          id: `more-like-${anchor.key}`,
          title: anchor.name,
          eyebrow: { label: "More like", name: anchor.name, thumb: b.thumb ?? anchor.thumb, artistId: b.artistId as string },
          anchorKey: anchor.key,
          layout: "row",
          priority: 0,
          items,
        };
      },
    });
  });

  /* ---- recommended [morning/today/tonight/late-night] — new songs next to
          the artists you're into lately ---- */
  if (anchors.length >= 1) {
    list.push({
      id: "recommended-today",
      kind: "recommended-today",
      priority: 62 + Math.round(8 * profile.hourEnergy),
      build: (ctx) => {
        const pools = anchors
          .slice(0, 6)
          .map((a) => bundleFor(ctx, a))
          .filter((b): b is ArtistBundle => !!b)
          .map((b, i) => dailyRotation(relatedSongPool(ctx, b), `today-${b.artistId}`, ctx.profile.daySeed + i));
        const picked = takeTracks(ctx, pools.flat(), { count: 12, maxPerArtist: 2, unplayedOnly: true });
        if (picked.length < 4) return null;
        return {
          id: "recommended-today",
          title: hourAwareTodayTitle(now),
          subtitle: "New to you, close to what you're playing lately",
          layout: "row",
          priority: 0,
          items: picked.map((track) => ({ style: "track", track })),
        };
      },
    });
  }

  /* ---- new from your artists — this year's and last year's releases ---- */
  if (anchors.length >= 1) {
    list.push({
      id: "new-from-your-artists",
      kind: "new-from-your-artists",
      priority: 66,
      build: (ctx) => {
        const since = new Date(now).getFullYear() - 1;
        const found: Album[] = [];
        for (const a of anchors.slice(0, 8)) {
          const b = bundleFor(ctx, a);
          if (!b) continue;
          for (const raw of b.albums) {
            const album = asRelease(raw, b.name);
            if (!(Number(album.year) >= since) || ctx.usedAlbums.has(album.id) || found.some((f) => f.id === album.id)) continue;
            found.push(album);
          }
        }
        // Newest first; within a year, the order your artists rank in.
        const items = found.sort((x, y) => Number(y.year) - Number(x.year)).slice(0, 10);
        for (const al of items) ctx.usedAlbums.add(al.id);
        return items.length >= 3
          ? {
              id: "new-from-your-artists",
              title: "New from your artists",
              subtitle: "Fresh releases from the artists you play",
              layout: "row",
              priority: 0,
              items: items.map((album) => ({ style: "album", album })),
            }
          : null;
      },
    });
  }

  /* ---- dust these off — old favourites you haven't played in weeks ---- */
  if (profile.dustOff.length >= 4) {
    list.push({
      id: "dust-off",
      kind: "dust-off",
      priority: 58,
      minItems: 4,
      build: (ctx) => {
        const items: SectionItem[] = ctx.profile.dustOff
          .filter((d) => !ctx.hidden.has(d.track.id))
          .slice(0, 16)
          .map((d) => ({ style: "track", track: d.track, note: `Last played ${monthYear(d.lastAt)}` }));
        return { id: "dust-off", title: "Dust these off", subtitle: "Songs you loved and haven't played in a while", layout: "list", priority: 0, items };
      },
    });
  }

  /* ---- recommended stations ---- */
  if (top.length >= 2 && profile.maturity !== "light") {
    list.push({
      id: "stations",
      kind: "stations",
      priority: 50,
      minItems: 2,
      build: (ctx) => {
        const items: SectionItem[] = top.slice(0, 4).map((a) => {
          const b = bundleFor(ctx, a);
          const relNames = b?.related.slice(0, 3).map((r) => r.name) ?? [];
          return {
            style: "radio" as const,
            id: `${a.artistId}-station`,
            name: a.name,
            thumb: b?.thumb ?? a.thumb,
            caption: relNames.length ? captionWith(relNames) : "Radio",
            source: { type: "artist-radio", artistId: a.artistId as string, name: `${a.name} Radio` },
          };
        });
        return {
          id: "stations",
          title: "Recommended stations",
          subtitle: "Non-stop music based on your favorite songs and artists.",
          layout: "radios",
          priority: 0,
          items,
        };
      },
    });
  }

  /* ---- albums featuring songs you like ---- */
  if (top.length >= 2) {
    list.push({
      id: "albums-for-you",
      kind: "albums-for-you",
      priority: 46,
      build: (ctx) => {
        const items: SectionItem[] = [];
        const seen = new Set<string>();
        for (const a of top) {
          const b = bundleFor(ctx, a);
          if (!b) continue;
          for (const album of b.albums) {
            if (seen.has(album.id) || ctx.usedAlbums.has(album.id) || items.length >= 8) continue;
            seen.add(album.id);
            ctx.usedAlbums.add(album.id);
            items.push({ style: "album", album: asRelease(album, b.name) });
          }
          if (items.length >= 8) break;
        }
        return items.length >= 4
          ? { id: "albums-for-you", title: "Albums featuring songs you like", layout: "row", priority: 0, items }
          : null;
      },
    });
  }

  /* ---- because you listened to [third anchor] ---- */
  const becauseAnchor = anchors[2] ?? anchors[1];
  if (becauseAnchor && anchors.length >= 3) {
    list.push({
      id: `because-${becauseAnchor.key}`,
      kind: "because",
      anchorKey: becauseAnchor.key,
      priority: 42,
      build: (ctx) => {
        const b = bundleFor(ctx, becauseAnchor);
        if (!b) return null;
        const pool = dailyRotation(relatedSongPool(ctx, b), `because-${b.artistId}`, ctx.profile.daySeed);
        const picked = takeTracks(ctx, pool, { count: 8, maxPerArtist: 2, unplayedOnly: true });
        if (picked.length < 4) return null;
        return {
          id: `because-${becauseAnchor.key}`,
          title: `Because you listened to ${becauseAnchor.name}`,
          eyebrow: {
            label: "Because you listened to",
            name: becauseAnchor.name,
            thumb: b.thumb ?? becauseAnchor.thumb,
            artistId: b.artistId as string,
          },
          anchorKey: becauseAnchor.key,
          layout: "row",
          priority: 0,
          items: picked.map((track) => ({ style: "track", track })),
        };
      },
    });
  }

  /* ---- Market shelves (regional charts + YTM's regional feed) — the
          cold-start mixture and the long-tail filler for thin feeds. Cold
          and light users get an extra slot: with little personal data yet,
          market popularity is the honest content they have. ---- */
  if (ytShelves) {
    const slots = profile.maturity === "cold" || profile.maturity === "light" ? 3 : 2;
    // With the crate on Home, a shelf of playlists would only repeat it.
    const rows = crated ? ytShelves.filter((s) => !s.items.every((i) => i.kind === "playlist")) : ytShelves;
    rows.slice(0, slots).forEach((shelf, i) => {
      list.push({
        id: `yt-${i}-${shelf.title}`,
        kind: "market",
        priority: profile.maturity === "cold" ? 60 - i : 24 - i,
        minItems: 0, // content rides the `shelf` field, not `items`
        build: () => ({
          id: `yt-${i}-${shelf.title}`,
          title: shelf.title,
          layout: "yt-shelf",
          priority: 0,
          items: [],
          shelf,
        }),
      });
    });
  }

  return list;
}

/* ------------------------------------------------------------------- build */

const MAX_SECTIONS = 10;

export function buildHomeSections(args: {
  profile: TasteProfile;
  bundles: Map<string, ArtistBundle>;
  ytShelves: HomeShelf[] | null;
  /** provider's per-market mood titles for the cold-start Browse chips */
  moods?: string[];
  /** every market shelf whatever the maturity: the crate's playlists (ytShelves is only the filler rows) */
  market?: HomeShelf[] | null;
  /** taps per row kind, faded (stores/homeEngagement tapsNow) — the rows you play from rise */
  taps?: Readonly<Record<string, number>>;
  /** "Not interested" songs (stores/homeEngagement hiddenNow) */
  hidden?: ReadonlySet<string>;
  now?: number;
}): HomeSection[] {
  const { profile, bundles, ytShelves, moods, market, taps = {}, hidden = new Set<string>(), now = Date.now() } = args;
  const ctx: BuildCtx = { profile, bundles, usedTracks: new Set(), usedAlbums: new Set(), hidden };

  const descriptors = describeFeed(profile, ytShelves, now, moods, market)
    .map((d) => (PINNED.has(d.kind) ? d : { ...d, priority: Math.min(93, d.priority + learnedBoost(taps[d.kind] ?? 0)) }))
    .sort((a, b) => b.priority - a.priority);

  const sections: HomeSection[] = [];
  for (const d of descriptors) {
    if (sections.length >= MAX_SECTIONS) break;
    const built = d.build(ctx);
    if (built && built.items.length >= (d.minItems ?? 3)) sections.push({ ...built, kind: d.kind });
  }

  // Diversity pass: never two sections leaning on the same artist back to back.
  for (let i = 1; i < sections.length; i++) {
    const anchor = sections[i].anchorKey;
    if (!anchor || anchor !== sections[i - 1].anchorKey) continue;
    for (let j = i + 1; j < sections.length; j++) {
      if (sections[j].anchorKey !== anchor) {
        const [moved] = sections.splice(i, 1);
        sections.splice(j, 0, moved);
        break;
      }
    }
  }

  return sections;
}

/** Cards' pastel treatments (mix bands / radio tiles) — picked by stable id hash. */
export const CARD_PASTELS = [
  ["#a7baf5", "#8ea7ef"],
  ["#c99bf2", "#b57fee"],
  ["#f2a98e", "#ec9377"],
  ["#a9e3c3", "#8fd7ae"],
  ["#d8e07c", "#cbd45f"],
  ["#f3b8cf", "#eda0bd"],
  ["#f0cf8e", "#e9bd6e"],
  ["#9fd8f0", "#7fc7e8"],
] as const;

export function pastelFor(id: string): (typeof CARD_PASTELS)[number] {
  return CARD_PASTELS[hash32(id) % CARD_PASTELS.length];
}

/** Rank helper exposed for tests/QA: how strongly a section deserves its slot. */
export function sectionPriorities(profile: TasteProfile, ytShelves: HomeShelf[] | null, now?: number): Array<{ id: string; priority: number }> {
  return describeFeed(profile, ytShelves, now ?? Date.now())
    .sort((a, b) => b.priority - a.priority)
    .map((d) => ({ id: d.id, priority: Math.round(d.priority) }));
}
