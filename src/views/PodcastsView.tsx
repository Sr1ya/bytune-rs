import { useEffect, useState } from "react";
import { Mic } from "lucide-react";
import { Artwork, PlayOverlay, ShelfScroller, ShelfSkeleton } from "../components/primitives";
import { FitText } from "../components/FitText";
import { requireBridge } from "../lib/bridge";
import { trackMenuItems } from "../lib/trackActions";
import { usePlayer } from "../stores/player";
import { tintHoverHandlers, useUI } from "../stores/ui";
import type { PodcastEpisode, PodcastShelf } from "../types";

/**
 * Podcasts — YouTube Music's podcasts page for the device market, opened from
 * Explore's Podcasts card: popular shows, popular episodes and topic shelves.
 * A show card opens the show; an episode card plays it as an episode.
 */

/** The popular shelves move daily; an hour keeps revisits instant. */
const PODCASTS_TTL_MS = 3_600_000;
let podcastCache: { shelves: PodcastShelf[]; at: number } | null = null;

/** YouTube Music's podcasts page for the market; [] when it can't be had. */
export async function loadPodcasts(): Promise<PodcastShelf[]> {
  if (podcastCache && Date.now() - podcastCache.at < PODCASTS_TTL_MS) return podcastCache.shelves;
  try {
    const shelves = await requireBridge().getPodcasts();
    if (shelves.length) podcastCache = { shelves, at: Date.now() };
    return shelves;
  } catch {
    return podcastCache?.shelves ?? [];
  }
}

/** Home's shelf tile (Cards.tsx): a show opens its page; an episode plays, with the track menu. */
function PodcastCard({
  thumb,
  title,
  subtitle,
  open,
  episode,
}: {
  thumb: string;
  title: string;
  subtitle: string;
  open: () => void;
  episode?: PodcastEpisode;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      onContextMenu={(e) => {
        if (!episode) return;
        e.preventDefault();
        useUI.getState().openContextMenu(e.clientX, e.clientY, trackMenuItems(episode));
      }}
      {...tintHoverHandlers(thumb)}
      className="fit-host group w-[184px] shrink-0 text-left cursor-pointer select-none active:scale-[0.98] rounded-xl p-2 transition-colors duration-200 hover:bg-ink-hi/[0.08]"
    >
      <div className="relative overflow-hidden rounded-xl">
        <Artwork src={thumb} className="w-full aspect-square rounded-xl transition-transform duration-300 ease-out origin-top group-hover:scale-[1.05]" iconClassName="w-7 h-7" />
        {episode && <PlayOverlay onClick={open} />}
      </div>
      <div className="mt-2.5">
        <FitText lines={2} text={title} className="text-[15px] font-semibold text-ink-hi leading-snug" />
        <FitText text={subtitle} className="text-[13px] text-ink-dim mt-0.5" />
      </div>
    </div>
  );
}

export function PodcastsView() {
  // null while the podcasts page loads; [] when it couldn't be had.
  const [shelves, setShelves] = useState<PodcastShelf[] | null>(podcastCache?.shelves ?? null);
  const navigate = useUI((s) => s.navigate);
  const playQueue = usePlayer((s) => s.playQueue);

  useEffect(() => {
    let alive = true;
    void loadPodcasts().then((p) => {
      if (alive) setShelves(p);
    });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="pt-2">
      <h1 className="font-display text-[34px] font-extrabold tracking-[-0.03em] text-ink-hi flex items-center gap-3">
        <Mic className="w-7 h-7 text-ink-hi/80" />
        Podcasts
      </h1>
      <p className="text-[13px] text-ink-dim mt-1 mb-7">Popular in your region on YouTube Music</p>

      {shelves === null ? (
        <div className="space-y-8">
          <ShelfSkeleton />
          <ShelfSkeleton />
        </div>
      ) : shelves.length === 0 ? (
        <p className="text-[14px] text-ink-dim">Podcasts couldn't be loaded right now. Try again in a moment.</p>
      ) : (
        <div className="space-y-8">
          {shelves.map((shelf, i) => (
            <section key={`${shelf.title}-${i}`} className="animate-slide-up">
              <h2 className="section-title text-[19px] mb-3">{shelf.title}</h2>
              <ShelfScroller>
                {shelf.shows.map((show, j) => (
                  <PodcastCard
                    key={`${show.id}-${j}`}
                    thumb={show.thumb}
                    title={show.title}
                    subtitle={show.author || "Podcast"}
                    open={() => navigate({ name: "podcast", param: show.id })}
                  />
                ))}
                {shelf.episodes.map((ep, j) => (
                  // Just the episode, as Search plays a row: AutoPlay never follows an episode.
                  <PodcastCard
                    key={`${ep.id}-${j}`}
                    thumb={ep.thumb}
                    title={ep.title}
                    subtitle={ep.artist}
                    open={() => playQueue([ep], 0)}
                    episode={ep}
                  />
                ))}
              </ShelfScroller>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
