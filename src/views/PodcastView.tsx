/**
 * A podcast show: who makes it, what it is about, and its episodes, newest
 * first. Episodes play like songs, but stay out of Replay, recommendations and
 * AutoPlay (they carry `episode: true`).
 */
import { useEffect, useState } from "react";
import { Mic, MoreHorizontal, Play } from "lucide-react";
import { Artwork, EqBars, ErrorState, HeroSkeleton, ListSkeleton } from "../components/primitives";
import { FitText } from "../components/FitText";
import { PAGE_TITLE_SIZE, titleStep } from "../lib/format";
import { trackMenuItems } from "../lib/trackActions";
import { usePlayer, useTrackPlayback } from "../stores/player";
import { useUI } from "../stores/ui";
import type { PodcastEpisode, PodcastPage } from "../types";

function EpisodeRow({ episode }: { episode: PodcastEpisode }) {
  const state = useTrackPlayback(episode.id);
  const play = (): void => usePlayer.getState().playQueue([episode], 0);
  const menu = (x: number, y: number): void => useUI.getState().openContextMenu(x, y, trackMenuItems(episode));
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={play}
      onKeyDown={(e) => {
        if (e.key === "Enter") play();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        menu(e.clientX, e.clientY);
      }}
      className={`group flex gap-4 p-3 rounded-xl cursor-pointer select-none transition-colors ${
        state ? "bg-ink-hi/[0.08]" : "hover:bg-ink-hi/[0.05]"
      }`}
    >
      <span className="relative shrink-0">
        <Artwork src={episode.thumb} className="w-24 h-24 rounded-lg" iconClassName="w-6 h-6" alt="" />
        {state === "playing" && (
          <span className="absolute inset-0 grid place-items-center rounded-lg bg-black/50">
            <EqBars />
          </span>
        )}
      </span>
      <div className="min-w-0 flex-1">
        <FitText lines={2} text={episode.title} className="text-[15px] font-semibold text-ink-hi leading-snug" />
        {episode.published && <div className="text-[12.5px] text-ink-dim mt-1">{episode.published}</div>}
        {episode.description && <p className="text-[13px] text-ink-hi/60 mt-1.5 line-clamp-2">{episode.description}</p>}
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          menu(e.clientX, e.clientY);
        }}
        title="More options"
        aria-label={`More options for ${episode.title}`}
        className="self-start p-1.5 rounded-md text-ink-faint hover:text-ink-hi hover:bg-ink-hi/[0.07] transition-colors"
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>
    </div>
  );
}

export function PodcastView({ id }: { id: string }) {
  const [page, setPage] = useState<PodcastPage | null>(null);
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setPage(null);
    setError(false);
    window.bytune
      ?.getPodcast(id)
      .then((p) => alive && setPage(p))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, [id, nonce]);

  if (error) return <ErrorState title="This podcast didn't load" body="Give it another try." onRetry={() => setNonce((n) => n + 1)} />;
  if (!page) {
    return (
      <div className="space-y-6">
        <HeroSkeleton />
        <ListSkeleton />
      </div>
    );
  }

  const latest = page.episodes[0];
  return (
    <div className="space-y-6 pb-12">
      <header className="flex flex-col sm:flex-row gap-6 items-start animate-slide-up">
        <Artwork src={page.thumb} className="w-44 h-44 rounded-2xl shadow-elev shrink-0" iconClassName="w-10 h-10" alt="" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.14em] text-ink-dim">
            <Mic className="w-3.5 h-3.5" /> Podcast
          </div>
          <h1 className={`font-display ${PAGE_TITLE_SIZE[titleStep(page.title)]} leading-[1.2] font-extrabold tracking-[-0.03em] text-ink-hi mt-1 break-words`}>
            {page.title}
          </h1>
          {page.author && <div className="text-[14px] text-ink-hi/75 mt-1">{page.author}</div>}
          {page.description && <p className="text-[13px] text-ink-dim mt-3 line-clamp-3 max-w-2xl">{page.description}</p>}
          {latest && (
            <button
              onClick={() => usePlayer.getState().playQueue([latest], 0)}
              className="mt-4 inline-flex items-center gap-2 h-10 px-5 rounded-full bg-primary text-on-primary text-[14px] font-semibold hover:brightness-110 transition-all active:scale-[0.98]"
            >
              <Play className="w-4 h-4 fill-current" />
              Play latest episode
            </button>
          )}
        </div>
      </header>
      <section>
        <h2 className="section-title text-[21px] mb-2">Episodes</h2>
        {page.episodes.length ? (
          <div className="space-y-1">
            {page.episodes.map((ep) => (
              <EpisodeRow key={ep.id} episode={ep} />
            ))}
          </div>
        ) : (
          <p className="text-[13px] text-ink-dim">No episodes to play yet.</p>
        )}
      </section>
    </div>
  );
}
