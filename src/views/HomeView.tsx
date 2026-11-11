/**
 * Home — a personalized feed, not a fixed page.
 *
 * This view holds no recommendation logic of its own: sections come from
 * lib/recs (profile → candidates → section builder → feed hook), and each
 * section self-describes its title, subtitle, layout and items. The view's
 * whole job is to render whatever the engine chose — new section types and
 * reorderings appear without touching this file.
 *
 * Visual language follows the reference layouts: quick-resume tiles, square
 * album/track cards, circular artist cards, mix cards with name bands, and
 * pastel radio tiles with contextual "reason" subtitles.
 */
import { Play } from "lucide-react";
import { AlbumCard, ArtistCard, HomeShelfView, TrackCard } from "../components/Cards";
import { Crate } from "../components/Crate";
import { EyebrowHeader, MixCard, RadioCard, SideCard, TrackColumns, homeTrackMenu } from "../components/recCards";
import { Artwork, Shelf, ShelfScroller, ShelfSkeleton } from "../components/primitives";
import { FitText } from "../components/FitText";
import { shortTitle } from "../lib/format";
import { useHomeFeed } from "../lib/recs/feed";
import { useDrag } from "../lib/dnd";
import { historyMenuItems } from "../lib/trackActions";
import type { HomeSection } from "../lib/recs/sections";
import { useHomeEngagement } from "../stores/homeEngagement";
import { usePlayer } from "../stores/player";
import { tintHoverHandlers, useUI } from "../stores/ui";
import type { Track } from "../types";

/** Quick-resume tiles — the compact 2×3 grid straight from history. Hovering
    a tile shows its artwork in the panel's glow (components/CoverGlow), and
    every tile is a drag source for the library. */
function QuickTile({ track }: { track: Track }) {
  const playQueue = usePlayer((s) => s.playQueue);
  const drag = useDrag({ track });
  const open = (): void => playQueue([track], 0);
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
        e.preventDefault();
        useUI.getState().openContextMenu(e.clientX, e.clientY, historyMenuItems(track));
      }}
      {...tintHoverHandlers(track.thumb)}
      {...drag.props}
      className={`fit-host group flex items-center gap-3 h-16 pr-3 rounded-lg bg-ink-hi/[0.03] text-left hover:bg-ink-hi/[0.08] transition-all overflow-hidden cursor-pointer select-none ${
        drag.dragging ? "opacity-40" : ""
      }`}
    >
      <Artwork src={track.thumb} className="h-16 w-16 rounded-none shrink-0" iconClassName="w-5 h-5" alt="" />
      <div className="min-w-0 flex-1">
        <FitText
          lines={2}
          text={shortTitle(track.title)}
          full={track.title}
          className="text-[13px] font-medium leading-[1.3] text-ink group-hover:text-ink-hi transition-colors"
        />
        <FitText text={track.artist} className="text-xs text-ink-faint mt-0.5" />
      </div>
      <span className="w-9 h-9 rounded-full bg-primary text-on-primary grid place-items-center shadow-elev opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
        <Play className="w-4 h-4 fill-current ml-0.5" />
      </span>
    </div>
  );
}

/** Cold-start browse chips — the honest fallback while taste is unknown. */
function MoodChips({ moods }: { moods: string[] }) {
  const setQuery = useUI((s) => s.setSearchQuery);
  const navigate = useUI((s) => s.navigate);
  return (
    <div className="flex flex-wrap gap-2">
      {moods.map((mood) => (
        <button
          key={mood}
          onClick={() => {
            setQuery(mood);
            navigate({ name: "search" });
          }}
          className="px-4 py-2 rounded-full bg-ink-hi/[0.05] text-[13px] font-medium text-ink hover:bg-ink-hi/[0.09] hover:text-ink-hi transition-colors duration-150"
        >
          {mood}
        </button>
      ))}
    </div>
  );
}

/**
 * Renders one section however it asks to be rendered. Adding a new section
 * type = a new entry in the builder + (only if genuinely new) a new case here.
 */
function SectionView({ section }: { section: HomeSection }) {
  const navigate = useUI((s) => s.navigate);

  const eyebrow = section.eyebrow;
  const openArtist = eyebrow ? () => navigate({ name: "artist", param: eyebrow.artistId }) : undefined;

  if (section.layout === "yt-shelf" && section.shelf) {
    return <HomeShelfView shelf={section.shelf} />;
  }
  if (section.layout === "crate" && section.playlists) {
    return <Crate title={section.title} playlists={section.playlists} className="animate-slide-up" />;
  }

  const body = (() => {
    if (section.layout === "tiles") {
      const tileTracks = section.items.flatMap((it) => (it.style === "track" ? [it.track] : []));
      return (
        <div className="tile-host">
          <div className="tile-grid">
            {tileTracks.map((t) => (
              <QuickTile key={t.id} track={t} />
            ))}
          </div>
        </div>
      );
    }
    if (section.layout === "moods") {
      return <MoodChips moods={section.moods ?? []} />;
    }
    if (section.layout === "list") {
      return <TrackColumns items={section.items.flatMap((it) => (it.style === "track" ? [it] : []))} />;
    }
    return (
      <ShelfScroller>
        {section.items.map((item, i) => {
          const key = `${section.id}-${item.style}-${i}`;
          switch (item.style) {
            case "track":
              return <TrackCard key={key} track={item.track} menu={() => homeTrackMenu(item.track)} />;
            case "album":
              return <AlbumCard key={key} album={item.album} />;
            case "artist":
              return <ArtistCard key={key} artist={item.artist} />;
            case "mix":
              return <MixCard key={key} item={item} />;
            case "side":
              return <SideCard key={key} item={item} />;
            case "radio":
              return <RadioCard key={key} item={item} />;
            default:
              return null;
          }
        })}
      </ShelfScroller>
    );
  })();

  return (
    <section className="animate-slide-up">
      {eyebrow ? (
        <>
          <EyebrowHeader eyebrow={eyebrow} onOpen={openArtist as () => void} />
          {body}
        </>
      ) : (
        <Shelf title={section.title} subtitle={section.subtitle}>
          {body}
        </Shelf>
      )}
    </section>
  );
}

export function HomeView() {
  const { sections, profile } = useHomeFeed();
  // The glow at the top of the pane is global (components/CoverGlow): at rest
  // it shows the playing track's cover, and hovering any card on any view
  // shows that card's artwork instead.

  return (
    <div className="relative">
      {/* No greeting: Home opens straight on your music. The heading stays for screen readers. */}
      <h1 className="sr-only">Home</h1>
      <div className="relative space-y-10">

        {sections.map((section) => (
          // A press inside a row counts for its kind: the rows you play from rise on your next visit.
          <div
            key={section.id}
            onClickCapture={(e) => {
              if ((e.target as HTMLElement).closest("button, [role='button'], a")) useHomeEngagement.getState().tap(section.kind);
            }}
          >
            <SectionView section={section} />
          </div>
        ))}

        {/* Stats still loading on a cold app launch — hold the layout. */}
        {!profile && (
          <div className="space-y-10">
            <ShelfSkeleton />
            <ShelfSkeleton />
          </div>
        )}
      </div>
    </div>
  );
}
