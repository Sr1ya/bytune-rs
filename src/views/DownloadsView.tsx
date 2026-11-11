/**
 * Downloads: a wall of the covers of the songs saved for offline; how many and how long, what's still
 * on the way and what failed; Play, Shuffle and the folder they're saved in. A song's cover stays grey
 * until it's saved, filling with its colour from the bottom as it downloads; each row is lit by its own
 * cover as the pointer passes, and a saved song plays on click.
 */
import type { CSSProperties } from "react";
import { AlertCircle, Check, Clock3, Download, FolderOpen, Play, RotateCcw, Shuffle, X } from "lucide-react";
import { downloadMenuItems } from "../lib/trackActions";
import { useDrag } from "../lib/dnd";
import { useLibrary, type DownloadItem } from "../stores/library";
import { usePlayer } from "../stores/player";
import { useSettings } from "../stores/settings";
import { tintHoverHandlers, useUI } from "../stores/ui";
import { cancelDownload, startDownload } from "../lib/downloads";
import { collectionFacts } from "../lib/collection";
import { fmtTime, shortTitle } from "../lib/format";
import { upgradeArtwork } from "../lib/artwork";
import { Artwork, EmptyState, IconBtn } from "../components/primitives";
import { FitText } from "../components/FitText";
import { CollectionHero, HERO_PLAY } from "../components/CollectionHero";
import { HERO_ROUND } from "../components/PlaylistHero";
import { PlayingLight, useRowLight } from "../components/RowLight";
import type { Track } from "../types";

/** The cover: grey until the song is saved, filling with its colour from the bottom as it comes in. */
function DownloadCover({ item }: { item: DownloadItem }) {
  const pct = Math.round(item.progress * 100);
  return (
    <span className={`dl-cover ${item.status}`} style={{ "--fill": `${item.status === "downloading" ? pct : 0}%` } as CSSProperties}>
      <Artwork src={item.track.thumb} className="w-[52px] h-[52px] rounded-lg" iconClassName="w-4 h-4" alt="" />
      {item.status === "downloading" && (
        <>
          {item.track.thumb && (
            <span aria-hidden className="dl-fill" style={{ backgroundImage: `url(${JSON.stringify(upgradeArtwork(item.track.thumb))})` }} />
          )}
          <span className="dl-pct">{pct}%</span>
        </>
      )}
      {item.status === "done" && (
        <span aria-hidden className="dl-badge ok">
          <Check className="w-3 h-3" strokeWidth={3} />
        </span>
      )}
      {item.status === "failed" && (
        <span aria-hidden className="dl-badge fail">
          <AlertCircle className="w-3 h-3" strokeWidth={3} />
        </span>
      )}
      {item.status === "queued" && (
        <span aria-hidden className="dl-badge wait">
          <Clock3 className="w-3 h-3" strokeWidth={3} />
        </span>
      )}
    </span>
  );
}

function StatusText({ item }: { item: DownloadItem }) {
  if (item.status === "downloading") return <span className="text-accent">Downloading · {Math.round(item.progress * 100)}%</span>;
  if (item.status === "queued") return <span className="text-ink-dim">Waiting to download</span>;
  if (item.status === "failed") return <span className="text-red-400">Couldn't download</span>;
  return <span className="text-ink-faint">Saved</span>;
}

/** One download: a drag source like every other list row; a saved one plays on click. */
function DownloadRow({
  item,
  onPlay,
  onOpenMenu,
  onRemove,
  onHover,
}: {
  item: DownloadItem;
  onPlay?: () => void;
  onOpenMenu: (x: number, y: number) => void;
  onRemove: (id: string) => void;
  onHover: (row: HTMLElement, thumb: string) => void;
}) {
  const drag = useDrag({ track: item.track });
  const tint = tintHoverHandlers(item.track.thumb);
  const isCurrent = usePlayer((s) => s.queue[s.index]?.id === item.track.id);
  const busy = item.status === "downloading" || item.status === "queued";
  return (
    <div
      {...drag.props}
      onMouseEnter={(e) => {
        tint.onMouseEnter();
        onHover(e.currentTarget, item.track.thumb);
      }}
      onMouseLeave={tint.onMouseLeave}
      onClick={onPlay}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpenMenu(e.clientX, e.clientY);
      }}
      className={`tl-row fit-host group flex items-center gap-3.5 h-[66px] px-3 rounded-lg select-none ${onPlay ? "cursor-pointer" : ""} ${
        isCurrent ? "bg-ink-hi/[0.06]" : "hover:bg-ink-hi/[0.04]"
      } ${drag.dragging ? "opacity-40" : ""}`}
    >
      {isCurrent && <PlayingLight thumb={item.track.thumb} />}
      <DownloadCover item={item} />
      <div className="flex-1 min-w-0">
        <FitText text={shortTitle(item.track.title)} full={item.track.title} className="text-[16px] font-semibold tracking-[-0.2px] text-ink-hi" />
        <FitText text={item.track.artist} className="text-[14px] text-ink-dim mt-0.5" />
      </div>
      <div className="w-44 shrink-0 text-[13px] tabular-nums">
        <StatusText item={item} />
      </div>
      {/* While a song is on the way, Cancel stays in reach; otherwise the actions show on hover. */}
      <div
        onClick={(e) => e.stopPropagation()}
        className={`w-24 shrink-0 flex items-center justify-end gap-0.5 transition-opacity ${
          busy ? "" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100"
        }`}
      >
        {item.status === "failed" && (
          <IconBtn icon={RotateCcw} title="Retry download" onClick={() => void startDownload(item.track)} size="sm" />
        )}
        {busy && <IconBtn icon={X} title="Cancel download" danger onClick={() => cancelDownload(item.track.id)} size="sm" />}
        {item.status === "done" && item.path && (
          <IconBtn icon={FolderOpen} title="Show in folder" onClick={() => window.bytune?.revealPath(item.path!)} size="sm" />
        )}
        {!busy && <IconBtn icon={X} title="Remove from list" danger onClick={() => onRemove(item.track.id)} size="sm" />}
      </div>
      <div className="w-11 shrink-0 text-right text-xs text-ink-faint tabular-nums">
        {item.track.duration > 0 ? fmtTime(item.track.duration) : "—"}
      </div>
    </div>
  );
}

export function DownloadsView() {
  const downloads = useLibrary((s) => s.downloads);
  const removeDownload = useLibrary((s) => s.removeDownload);
  const downloadDir = useSettings((s) => s.downloadDir);
  const openContextMenu = useUI((s) => s.openContextMenu);
  const toast = useUI((s) => s.toast);
  const rowLight = useRowLight();

  const items = Object.values(downloads).sort((a, b) => a.track.title.localeCompare(b.track.title));
  /** what's saved, in the page's order: what Play plays */
  const saved: Track[] = items.filter((i) => i.status === "done").map((i) => i.track);
  const failedCount = items.filter((i) => i.status === "failed").length;
  const activeCount = items.filter((i) => i.status === "downloading" || i.status === "queued").length;
  const facts = collectionFacts(saved);

  const play = (index: number, shuffle = false): void => {
    if (!saved.length) return;
    if (shuffle) usePlayer.setState({ shuffle: true });
    usePlayer.getState().playQueue(saved, index, "__downloads__");
  };

  const openFolder = (): void => {
    const b = window.bytune;
    if (!b) return;
    if (downloadDir) {
      void b.openPath(downloadDir);
    } else {
      void b
        .defaultDownloadDir()
        .then((dir) => b.openPath(dir))
        .catch(() => toast("Couldn't open the downloads folder", "error"));
    }
  };

  return (
    <div className="pb-14">
      <CollectionHero
        icon={Download}
        kind="Saved for offline"
        title="Downloads"
        covers={items.map((i) => i.track.thumb)}
        facts={
          <>
            {saved.length ? [facts.songs, facts.length].filter(Boolean).join(" · ") : "Nothing saved yet"}
            {activeCount > 0 && <span className="text-white"> · {activeCount} on the way</span>}
            {failedCount > 0 && <span className="text-red-300"> · {failedCount} couldn't download</span>}
          </>
        }
      >
        <button type="button" className={HERO_PLAY} aria-label="Play Downloads" disabled={!saved.length} onClick={() => play(0)}>
          <Play className="w-5 h-5 fill-current" />
          Play
        </button>
        <button
          type="button"
          className={HERO_ROUND}
          aria-label="Shuffle"
          title="Shuffle"
          disabled={!saved.length}
          onClick={() => play(Math.floor(Math.random() * saved.length), true)}
        >
          <Shuffle className="w-5 h-5" />
        </button>
        <button type="button" className={HERO_ROUND} aria-label="Open the downloads folder" title="Open folder" onClick={openFolder}>
          <FolderOpen className="w-5 h-5" />
        </button>
      </CollectionHero>

      {items.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={Download}
            title="No downloads yet"
            body='Right-click any song and choose "Download", or use the download arrow on a song row. Its cover joins the wall above once it starts.'
          />
        </div>
      ) : (
        <div className="relative mt-6" onMouseLeave={rowLight.leave}>
          {rowLight.light}
          {items.map((item) => (
            <DownloadRow
              key={item.track.id}
              item={item}
              onPlay={item.status === "done" ? () => play(saved.findIndex((t) => t.id === item.track.id)) : undefined}
              onOpenMenu={(x, y) => openContextMenu(x, y, downloadMenuItems(item.track, item.path))}
              onRemove={removeDownload}
              onHover={rowLight.hover}
            />
          ))}
        </div>
      )}
    </div>
  );
}
