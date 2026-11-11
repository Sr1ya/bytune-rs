import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { Play, Shuffle } from "lucide-react";
import { ArtistCard } from "../components/Cards";
import { Crate } from "../components/Crate";
import { Artwork, Btn, EqBars, ShelfScroller, ShelfSkeleton } from "../components/primitives";
import { requireBridge } from "../lib/bridge";
import { useExploreCovers } from "../lib/exploreCovers";
import { fmtTime, shortTitle } from "../lib/format";
import { FitText } from "../components/FitText";
import { buildMix } from "../lib/moodMix";
import { browseMenuItems, trackMenuItems } from "../lib/trackActions";
import { usePlayer } from "../stores/player";
import { useUI, type MenuItem } from "../stores/ui";
import type { Album, Artist, MoodPage, PlaylistCard, Track } from "../types";
import { MOOD_BROWSE_ID, moodByParams, tone } from "./ExploreView";

/**
 * A mood or genre's own page (Explore → a card), ByTune's way. YouTube
 * supplies the category's playlists and albums; the page is ours:
 * - a turntable header that plays the category's own ByTune mix (moodMix.ts:
 *   songs from its top playlists in turns, one of each, no video uploads),
 *   its record spinning while the mix plays;
 * - the mix's first songs, as a tracklist;
 * - the category's playlists as a record crate to flip through;
 * - its albums as a wall of records.
 */

const TTL_MS = 3_600_000;
/** The mix draws on the category's first playlists: YouTube's own featured ones. */
const MIX_SOURCES = 3;
const UP_FIRST = 10;
const WALL_FIRST = 15;
const pages = new Map<string, { page: MoodPage; at: number }>();
const mixes = new Map<string, { tracks: Track[]; at: number }>();

/** The category's page; null when it can't be had (an older copy stands in). */
async function loadPage(params: string): Promise<MoodPage | null> {
  const hit = pages.get(params);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.page;
  try {
    const page = await requireBridge().getMoodPage(MOOD_BROWSE_ID, params);
    if (page.shelves.length) pages.set(params, { page, at: Date.now() });
    return page;
  } catch {
    return hit?.page ?? null;
  }
}

/** The category's ByTune mix: its own songs first, then its top playlists' songs, in turns. */
async function loadMix(params: string, songs: Track[], playlists: PlaylistCard[]): Promise<Track[]> {
  const hit = mixes.get(params);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.tracks;
  const lists = await Promise.all(
    playlists.slice(0, MIX_SOURCES).map((p) =>
      requireBridge()
        .getPlaylistPage(p.id)
        .then((r: { tracks?: Track[] }) => r.tracks ?? [], () => [] as Track[])
    )
  );
  const tracks = buildMix(songs.length ? [songs, ...lists] : lists);
  if (tracks.length) mixes.set(params, { tracks, at: Date.now() });
  return tracks;
}

function uniqueById<T extends { id: string }>(list: T[]): T[] {
  const seen = new Set<string>();
  return list.filter((x) => !seen.has(x.id) && !!seen.add(x.id));
}

const menuAt = (e: MouseEvent, items: MenuItem[]): void => {
  if (!items.length) return;
  e.preventDefault();
  useUI.getState().openContextMenu(e.clientX, e.clientY, items);
};

/** The header: the category's colour, and a turntable whose record plays the mix. */
function Turntable({ title, section, color, cover, mix, mixing }: { title: string; section?: string | null; color: string; cover?: string; mix: Track[]; mixing: boolean }) {
  const playQueue = usePlayer((s) => s.playQueue);
  const ids = useMemo(() => new Set(mix.map((t) => t.id)), [mix]);
  const spinning = usePlayer((s) => s.playing && ids.has(s.queue[s.index]?.id ?? ""));
  const shuffle = (): void => {
    usePlayer.setState({ shuffle: true });
    playQueue(mix, Math.floor(Math.random() * mix.length));
  };

  return (
    <header className="tt" style={tone(color)}>
      <div className="tt-text">
        {section && <span className="tt-eyebrow">{section}</span>}
        <h1 className="tt-title font-display">{title}</h1>
        <p className="tt-meta">
          {mix.length > 0 ? `A ByTune mix from its top playlists · ${mix.length} songs` : mixing ? "Mixing its top playlists…" : ""}
        </p>
        {mix.length > 0 && (
          <div className="flex gap-2.5">
            <Btn variant="white" icon={Play} onClick={() => playQueue(mix, 0)}>
              Play mix
            </Btn>
            <Btn variant="glass" icon={Shuffle} onClick={shuffle}>
              Shuffle
            </Btn>
          </div>
        )}
      </div>
      <div className={`tt-deck ${spinning ? "is-spinning" : ""}`} aria-hidden>
        <div className="tt-record">
          {cover && (
            <span className="tt-label">
              <img key={cover} src={cover} alt="" draggable={false} onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
            </span>
          )}
        </div>
        <div className="tt-arm">
          <span className="tt-rod" />
          <span className="tt-head" />
          <span className="tt-pivot" />
        </div>
      </div>
    </header>
  );
}

/** The mix's first songs, numbered down two columns; a click plays the mix from there. */
function UpFirst({ mix }: { mix: Track[] }) {
  const playQueue = usePlayer((s) => s.playQueue);
  const playingId = usePlayer((s) => (s.playing ? s.queue[s.index]?.id ?? null : null));
  return (
    <section className="mt-10">
      <h2 className="section-title text-[21px] mb-3">Up first in the mix</h2>
      <ol className="uf">
        {mix.slice(0, UP_FIRST).map((t, i) => (
          <li key={t.id}>
            <button className="uf-row fit-host" onClick={() => playQueue(mix, i)} onContextMenu={(e) => menuAt(e, trackMenuItems(t))}>
              <span className="uf-n text-ink-faint">{playingId === t.id ? <EqBars /> : String(i + 1).padStart(2, "0")}</span>
              <Artwork src={t.thumb} className="uf-art" iconClassName="w-4 h-4" />
              <span className="uf-t">
                <FitText text={shortTitle(t.title)} full={t.title} className="text-[14px] font-semibold text-ink-hi" />
                <FitText text={t.artist} className="text-[13px] text-ink-dim" />
              </span>
              <span className="uf-d text-ink-faint">{t.duration ? fmtTime(t.duration) : ""}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The category's albums as a wall of records, each sleeve with its record peeking out. */
function RecordWall({ albums }: { albums: Album[] }) {
  const navigate = useUI((s) => s.navigate);
  const [all, setAll] = useState(false);
  return (
    <section className="mt-10">
      <h2 className="section-title text-[21px] mb-4 flex items-baseline gap-2">
        Albums <span className="text-[14px] font-medium text-ink-faint tabular-nums">{albums.length}</span>
      </h2>
      <div className="rw">
        {(all ? albums : albums.slice(0, WALL_FIRST)).map((a) => (
          <button
            key={a.id}
            className="rw-item fit-host"
            onClick={() => navigate({ name: "album", param: a.id })}
            onContextMenu={(e) => menuAt(e, browseMenuItems({ browseId: a.id, title: a.title, subtitle: a.artist, thumb: a.thumb, type: "album" }))}
          >
            <span className="rw-art" aria-hidden>
              <span className="rw-disc">
                <span className="rw-label">
                  <img src={a.thumb} alt="" draggable={false} />
                </span>
              </span>
              <img className="rw-sleeve" src={a.thumb} alt="" draggable={false} />
            </span>
            <FitText lines={2} text={shortTitle(a.title)} full={a.title} className="mt-3 text-[14px] font-semibold text-ink-hi leading-snug" />
            <FitText text={a.artist} className="text-[13px] text-ink-dim" />
          </button>
        ))}
      </div>
      {albums.length > WALL_FIRST && (
        <Btn variant="glass" className="mt-6" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${albums.length}`}
        </Btn>
      )}
    </section>
  );
}

export function MoodView({ params }: { params: string }) {
  const mood = moodByParams(params);
  // undefined while the page loads; null when it couldn't be had.
  const [page, setPage] = useState<MoodPage | null | undefined>(() => pages.get(params)?.page);
  const [mix, setMix] = useState<Track[]>(() => mixes.get(params)?.tracks ?? []);
  const [mixing, setMixing] = useState(false);
  const saved = useExploreCovers((s) => s.byKey[`mood:${MOOD_BROWSE_ID}|${params}`]?.covers);

  useEffect(() => {
    let alive = true;
    setPage(pages.get(params)?.page);
    setMix(mixes.get(params)?.tracks ?? []);
    void loadPage(params).then((p) => {
      if (alive) setPage(p);
    });
    return () => {
      alive = false;
    };
  }, [params]);

  const items = useMemo(() => (page?.shelves ?? []).flatMap((s) => s.items), [page]);
  const playlists = useMemo(() => uniqueById(items.flatMap((i): PlaylistCard[] => (i.playlist ? [i.playlist] : []))), [items]);
  const albums = useMemo(() => uniqueById(items.flatMap((i): Album[] => (i.album ? [i.album] : []))), [items]);
  const artists = useMemo(() => uniqueById(items.flatMap((i): Artist[] => (i.artist ? [i.artist] : []))), [items]);
  const songs = useMemo(() => uniqueById(items.flatMap((i): Track[] => (i.track ? [i.track] : []))), [items]);

  useEffect(() => {
    if (!page || (!playlists.length && !songs.length)) return;
    let alive = true;
    setMixing(true);
    void loadMix(params, songs, playlists).then((m) => {
      if (!alive) return;
      setMix(m);
      setMixing(false);
    });
    return () => {
      alive = false;
    };
  }, [page, params, playlists, songs]);

  return (
    <div className="pt-2">
      <Turntable
        title={mood?.title ?? page?.title ?? ""}
        section={mood?.section}
        color={mood?.color ?? "#5b4bd6"}
        // The page's own link once it's here: Explore's saved one can be a signed link that has since died.
        cover={playlists[0]?.thumb ?? saved?.[0]}
        mix={mix}
        mixing={mixing}
      />

      {page === undefined ? (
        <div className="space-y-9 mt-10">
          <ShelfSkeleton />
          <ShelfSkeleton />
        </div>
      ) : page === null || !items.length ? (
        <p className="text-[14px] text-ink-dim mt-10">This page couldn't be loaded right now. Try again in a moment.</p>
      ) : (
        <>
          {mix.length > 0 && <UpFirst mix={mix} />}
          {playlists.length > 0 && <Crate title="Playlists" playlists={playlists} className="mt-10" />}
          {albums.length > 0 && <RecordWall albums={albums} />}
          {artists.length > 0 && (
            <section className="mt-10">
              <h2 className="section-title text-[21px] mb-4">Artists</h2>
              <ShelfScroller>
                {artists.map((a) => (
                  <ArtistCard key={a.id} artist={a} />
                ))}
              </ShelfScroller>
            </section>
          )}
        </>
      )}
    </div>
  );
}
