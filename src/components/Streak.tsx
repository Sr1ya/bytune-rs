/**
 * Your listening streak, in the top bar: a cartoon flame and how many days
 * in a row you've played music — "0 days" beside a cold grey flame when
 * there's no streak. It counts what Replay counts (this device's stats), and
 * music playing now counts today straight away. Clicking it opens Replay.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { isoDay, streakNow } from "../lib/replayFormat";
import { usePlayer } from "../stores/player";
import { useUI } from "../stores/ui";

/**
 * The flame, cartoon-style: flat chunky shapes — an orange flame with three
 * licks, a yellow heart, a pale core and a shine. It pops alight with a
 * springy squash-and-stretch and a little burst ring, then keeps dancing:
 * its outlines swap between hand-drawn frames like animation cels, it rocks
 * on its base, and star sparkles pop off the top. Unlit it's a flat grey
 * shape; Reduce animation leaves it lit and still.
 */
export function FireMark({ lit }: { lit: boolean }) {
  return (
    <span className={`fire ${lit ? "is-lit" : ""}`} aria-hidden>
      <span className="fire-burst" />
      <svg viewBox="0 0 40 48">
        <g className="fire-body">
          <path
            className="fire-outer"
            d="M20 46C10 46 5 39 5 31C5 24 9 20 12 15C12.5 19 14 21 15.5 21.5C15 14 17 8 21 2C22 9 26 12 27.5 17C28.5 15 30 13.5 31 11C34 18 35 25 35 31C35 39 30 46 20 46Z"
          />
          <path
            className="fire-inner"
            d="M20 44C13.5 44 10.5 39.5 10.5 34C10.5 28 15 25 18 19C18.5 23 20 25 21.5 25.5C22.5 22 24 20.5 25 19C28 24 29.5 28.5 29.5 33.5C29.5 39.5 26 44 20 44Z"
          />
          <path className="fire-core" d="M20 42C16.5 42 15 39.5 15 37C15 33.5 17.5 31 20 27C22.5 31 25 33.5 25 37C25 39.5 23.5 42 20 42Z" />
          <ellipse className="fire-shine" cx="11.5" cy="31" rx="1.7" ry="3.2" transform="rotate(-18 11.5 31)" />
        </g>
        <g transform="translate(13 9)">
          <path
            className="fire-spark"
            d="M0 -3.2L0.9 -0.9L3.2 0L0.9 0.9L0 3.2L-0.9 0.9L-3.2 0L-0.9 -0.9Z"
            style={{ "--sx": "-7px", animationDelay: "calc(var(--fire-at) + 0.9s)" } as CSSProperties}
          />
        </g>
        <g transform="translate(28 7)">
          <path
            className="fire-spark"
            d="M0 -2.6L0.75 -0.75L2.6 0L0.75 0.75L0 2.6L-0.75 0.75L-2.6 0L-0.75 -0.75Z"
            style={{ "--sx": "7px", animationDelay: "calc(var(--fire-at) + 1.7s)" } as CSSProperties}
          />
        </g>
        <g transform="translate(21 4)">
          <circle className="fire-spark" r="1.6" style={{ "--sx": "2px", animationDelay: "calc(var(--fire-at) + 2.5s)" } as CSSProperties} />
        </g>
      </svg>
    </span>
  );
}

/** Your streak now, read again when music starts or stops, when the window comes back, and when the day turns. */
function useStreak(): { current: number; best: number } | null {
  const listeningNow = usePlayer((s) => s.playing && !s.queue[s.index]?.episode);
  const [days, setDays] = useState<{ date: string; ms: number }[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    window.bytune
      ?.statsSummary("all")
      .then((res) => {
        if (alive) setDays((res as { days: { date: string; ms: number }[] }).days);
      })
      .catch(() => {
        /* no stats, no flame — the rest of the bar is unaffected */
      });
    return () => {
      alive = false;
    };
  }, [listeningNow, tick]);
  useEffect(() => {
    const again = (): void => setTick((n) => n + 1);
    window.addEventListener("focus", again);
    // A new day can start a streak or end one.
    const now = new Date();
    const toMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5).getTime() - now.getTime();
    const timer = window.setTimeout(again, toMidnight);
    return () => {
      window.removeEventListener("focus", again);
      window.clearTimeout(timer);
    };
  }, [tick]);
  if (!days) return null;
  const now = new Date();
  // Music playing now counts today straight away; the stats catch up as it plays.
  const s = streakNow(listeningNow ? [...days, { date: isoDay(now), ms: 1 }] : days, now);
  return { current: s.current, best: s.best };
}

export function StreakChip() {
  const streak = useStreak();
  if (!streak) return null;
  const n = streak.current;
  return (
    <button
      onClick={() => useUI.getState().navigate({ name: "replay" })}
      title={n ? `${n}-day listening streak${streak.best > n ? ` · your longest is ${streak.best} days` : ""}` : "No streak right now — play something today to start one"}
      aria-label={`Listening streak: ${n} ${n === 1 ? "day" : "days"}. Open Replay`}
      className={`streak-chip ${n ? "" : "is-cold"}`}
    >
      <FireMark lit={n > 0} />
      <span key={n} className="streak-n">
        {n} {n === 1 ? "day" : "days"}
      </span>
    </button>
  );
}
