/**
 * Liked Songs: a wall of the covers of the songs you liked; how many, how long, and who you like most;
 * then the songs, each lit by its own cover as the pointer passes. A song dropped on the page is liked
 * (App's panel drop).
 */
import { Heart, Play, Shuffle } from "lucide-react";
import { CollectionHero, HERO_PLAY } from "../components/CollectionHero";
import { HERO_ROUND } from "../components/PlaylistHero";
import { TrackList } from "../components/TrackList";
import { Btn, EmptyState } from "../components/primitives";
import { collectionFacts } from "../lib/collection";
import { useLibrary } from "../stores/library";
import { usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";

export function LikedView() {
  const liked = useLibrary((s) => s.liked);
  const navigate = useUI((s) => s.navigate);
  const facts = collectionFacts(liked);
  const play = (shuffle: boolean): void => {
    if (!liked.length) return;
    if (shuffle) usePlayer.setState({ shuffle: true });
    usePlayer.getState().playQueue(liked, shuffle ? Math.floor(Math.random() * liked.length) : 0, "__liked__");
  };

  return (
    <div className="pb-16">
      <CollectionHero
        icon={Heart}
        kind="Liked by you"
        title="Liked Songs"
        covers={liked.map((t) => t.thumb)}
        facts={
          <>
            {[facts.songs, facts.length].filter(Boolean).join(" · ")}
            {facts.topArtist && (
              <>
                {" · Your most liked: "}
                <span className="font-semibold text-white">{facts.topArtist.name}</span>
              </>
            )}
          </>
        }
      >
        <button type="button" className={HERO_PLAY} aria-label="Play Liked Songs" disabled={!liked.length} onClick={() => play(false)}>
          <Play className="w-5 h-5 fill-current" />
          Play
        </button>
        <button type="button" className={HERO_ROUND} aria-label="Shuffle" title="Shuffle" disabled={!liked.length} onClick={() => play(true)}>
          <Shuffle className="w-5 h-5" />
        </button>
      </CollectionHero>

      <div className="mt-6">
        {liked.length ? (
          <TrackList tracks={liked} from="__liked__" showAlbum />
        ) : (
          <EmptyState
            icon={Heart}
            title="Songs you like will show up here"
            body="Click the heart on any song, in the player, a playlist or search, and it lands here. Its cover joins the wall above."
            action={
              <Btn variant="white" onClick={() => navigate({ name: "search" })}>
                Find something to like
              </Btn>
            }
          />
        )}
      </div>
    </div>
  );
}
