import { useEffect, useMemo, useState, type CSSProperties, type SyntheticEvent } from "react";
import { Sparkles } from "lucide-react";
import { requireBridge } from "../lib/bridge";
import { useCovers } from "../lib/exploreCovers";
import { useUI } from "../stores/ui";
import { FALLBACK_MOODS, type MoodEntry } from "../shared/moods";
import { loadPodcasts } from "./PodcastsView";

/**
 * Explore — the provider's own per-market moods & genres, under the moods
 * page's own headings ("Moods & moments", "Genres") and in its order, with
 * one Podcasts card on top. Every card wears its category's color and, once
 * it scrolls into view, the category's first playlist cover as a record
 * sleeve with its record sliding out (exploreCovers.ts). Tapping a card opens
 * the category's own page (MoodView); the Podcasts card opens the podcasts
 * page, and offline fallback cards run a search. The list follows
 * the device market (the session's `gl`); when the provider is unreachable a
 * neutral global set stands in.
 */

const MOODS_TTL_MS = 24 * 3_600_000;
let moodCache: { moods: MoodEntry[]; at: number } | null = null;

/** Every category page's browse id; a category is told apart by its params. */
export const MOOD_BROWSE_ID = "FEmusic_moods_and_genres_category";

/** The card a category page was opened from, while Explore's list is in memory. */
export function moodByParams(params: string): MoodEntry | undefined {
  return moodCache?.moods.find((m) => m.params === params);
}

async function loadMoods(): Promise<MoodEntry[]> {
  if (moodCache && Date.now() - moodCache.at < MOODS_TTL_MS) return moodCache.moods;
  try {
    const moods = (await requireBridge().getMoods()) as MoodEntry[];
    const usable = moods.filter((m) => m.browseId.includes("moods_and_genres_category"));
    if (usable.length >= 6) {
      moodCache = { moods: usable, at: Date.now() };
      return usable;
    }
  } catch {
    /* offline / no bridge — neutral global fallback below */
  }
  return moodCache?.moods ?? FALLBACK_MOODS;
}

/** The page's headings in its own order; a mood without one joins "Moods & genres". */
function bySection(moods: MoodEntry[]): Array<[string, MoodEntry[]]> {
  const groups = new Map<string, MoodEntry[]>();
  for (const m of moods) {
    const title = m.section || "Moods & genres";
    groups.set(title, [...(groups.get(title) ?? []), m]);
  }
  return [...groups];
}

/** Podcasts' own color: the theme accent can be a grey, which leaves the card flat. */
const PODCASTS_COLOR = "#6d5dfc";

/** The color a card's gradients and record grooves mix from. */
export const tone = (color: string): CSSProperties => ({ ["--xc" as string]: color });

/** A category's covers as a record sleeve, its record sliding out with the second cover on its label. */
export function SleeveArt({ covers, onError }: { covers: string[]; onError: (e: SyntheticEvent<HTMLImageElement>) => void }) {
  if (!covers.length) return null;
  return (
    <span className="xc-art" aria-hidden>
      <span className="xc-disc">
        <span className="xc-label">
          <img src={covers[1] ?? covers[0]} alt="" draggable={false} onError={onError} />
        </span>
      </span>
      <img className="xc-sleeve" src={covers[0]} alt="" draggable={false} onError={onError} />
    </span>
  );
}

function MoodCard({ mood }: { mood: MoodEntry }) {
  const setQuery = useUI((s) => s.setSearchQuery);
  const navigate = useUI((s) => s.navigate);
  const params = mood.params ?? "";
  const key = params && mood.browseId === MOOD_BROWSE_ID ? `mood:${MOOD_BROWSE_ID}|${params}` : "";
  const { ref, covers, onError } = useCovers<HTMLButtonElement>(key, () => requireBridge().getMoodCovers(mood.browseId, params));

  return (
    <button
      ref={ref}
      onClick={() => {
        if (key) return navigate({ name: "mood", param: params });
        setQuery(mood.title);
        navigate({ name: "search" });
      }}
      className="xc-card"
      style={tone(mood.color ?? "#5b4bd6")}
    >
      <span className="xc-title font-display">{mood.title}</span>
      <SleeveArt covers={covers} onError={onError} />
    </button>
  );
}

/** One card for all of podcasts: the region's first shows fanned out; opens the podcasts page. */
function PodcastsCard() {
  const navigate = useUI((s) => s.navigate);
  const { ref, covers, onError } = useCovers<HTMLButtonElement>("podcasts", async () =>
    (await loadPodcasts())
      .flatMap((shelf) => shelf.shows.map((show) => show.thumb))
      .filter(Boolean)
      .slice(0, 3)
  );
  const shows = covers.slice(0, 3);

  return (
    <button ref={ref} onClick={() => navigate({ name: "podcasts" })} className="xc-card xc-banner" style={tone(PODCASTS_COLOR)}>
      <span className="xc-banner-text">
        <span className="xc-title font-display">Podcasts</span>
        <span className="xc-sub">Popular shows and episodes in your region</span>
      </span>
      {shows.length > 0 && (
        <span className="xc-fan" aria-hidden>
          {shows.map((url, i) => (
            // The last cover sits in front: with fewer than three, they take the front places.
            <img key={url} className={`xc-show xc-show-${i + 3 - shows.length}`} src={url} alt="" draggable={false} onError={onError} />
          ))}
        </span>
      )}
    </button>
  );
}

export function ExploreView() {
  const [moods, setMoods] = useState<MoodEntry[]>(moodCache?.moods ?? FALLBACK_MOODS);
  const sections = useMemo(() => bySection(moods), [moods]);

  useEffect(() => {
    if (moodCache && Date.now() - moodCache.at < MOODS_TTL_MS) return;
    let alive = true;
    void loadMoods().then((m) => {
      if (alive) setMoods(m);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="pt-2">
      <h1 className="font-display text-[34px] font-extrabold tracking-[-0.03em] text-ink-hi flex items-center gap-3">
        <Sparkles className="w-7 h-7 text-ink-hi/80" />
        Explore
      </h1>
      <p className="text-[13px] text-ink-dim mt-1 mb-6">Picked for your region by YouTube Music</p>

      <PodcastsCard />

      {sections.map(([title, list]) => (
        <section key={title} className="tile-host mt-9">
          <h2 className="section-title text-[21px] mb-4 flex items-baseline gap-2">
            {title}
            <span className="text-[14px] font-medium text-ink-faint tabular-nums">{list.length}</span>
          </h2>
          <div className="mood-grid">
            {list.map((m) => (
              <MoodCard key={`${m.title}-${m.params ?? ""}`} mood={m} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
