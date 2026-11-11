/**
 * The onboarding's 3D piece, in ByTune's own language: the collection walls' drifting rows of
 * covers wrapped round into a drum (lib/coverDrum), set with songs most people know on sight. Five
 * rings turn slowly against each other. Grab one and spin it, or roll it with two fingers on a
 * trackpad (or the mouse wheel), and it coasts back to its pace; the ring under the pointer stops,
 * so a cover stays put while you look at it. The cover facing you on the middle ring lights the
 * page with its own colours (a blurred copy of it behind the drum, the way a collection page is
 * lit); hovering another cover lifts it and lights that one instead. Each step turns every ring a
 * notch; while `busy` they spin. Turning, lifting and shading are CSS 3D (index.css, .ob-drum);
 * this keeps the angles. With reduced motion it holds still. Without animation frames (tests) it
 * renders, still.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { DRUM, PER_RING, RINGS, STEP, frontTile, type DrumCover } from "../lib/coverDrum";

/** Each ring's own pace, degrees a second, alternating like the walls' rows (one per ring). */
const PACE = [4.2, -3.1, 3.6, -2.7, 3.9];
/** The ring whose front cover lights the page. */
const MID = Math.floor(RINGS / 2);
/** Rings start half a place apart, like bricks. */
const START = (r: number): number => (r % 2) * (STEP / 2);

const bg = (src: string): CSSProperties => ({ backgroundImage: `url(${JSON.stringify(src)})` });

export function CoverDrum({ turn, busy }: { turn: number; busy: boolean }) {
  /** The middle ring's front cover, and one the pointer rests on (it wins). */
  const [front, setFront] = useState<DrumCover>(() => DRUM[MID][frontTile(START(MID))]);
  const [hover, setHover] = useState<DrumCover | null>(null);
  const drumRef = useRef<HTMLDivElement>(null);
  const ringRefs = useRef<Array<HTMLDivElement | null>>([]);
  const live = useRef({ turn, busy, notch: 0, dragging: false, rollingUntil: 0, fingers: 1 });
  const leaving = useRef(0);
  const shown = hover ?? front;
  // Moving from one cover to the next shouldn't flash the light back to the front cover in between,
  // and covers sliding under a pointer that's spinning or rolling a ring don't take the light.
  const enter = (c: DrumCover): void => {
    window.clearTimeout(leaving.current);
    if (!live.current.dragging && performance.now() > live.current.rollingUntil) setHover(c);
  };
  const leave = (): void => {
    window.clearTimeout(leaving.current);
    leaving.current = window.setTimeout(() => setHover(null), 140);
  };
  useEffect(() => () => window.clearTimeout(leaving.current), []);

  // A step turns every ring a notch, the way the step went.
  useEffect(() => {
    live.current.notch += turn - live.current.turn;
    live.current.turn = turn;
  }, [turn]);
  useEffect(() => {
    live.current.busy = busy;
  }, [busy]);
  // Wheel deltas follow the OS scroll setting: where it moves content against the fingers, the roll
  // is turned round so the covers still go the way the fingers do.
  useEffect(() => {
    let off = false;
    window.bytune
      ?.naturalScrolling?.()
      .then((natural) => {
        if (!off) live.current.fingers = natural === false ? -1 : 1;
      })
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, []);

  // The glow crossfades between two layers, so a new cover never cuts in.
  const [glow, setGlow] = useState({ a: "", b: "", on: "a" as "a" | "b" });
  useEffect(() => {
    const src = shown.art;
    setGlow((g) => {
      if (src === (g.on === "a" ? g.a : g.b)) return g;
      return g.on === "a" ? { a: g.a, b: src, on: "b" } : { a: src, b: g.b, on: "a" };
    });
  }, [shown.art]);
  // The ways in on the left light up with the same cover (index.css, .ob-way).
  useEffect(() => {
    drumRef.current?.closest<HTMLElement>(".ob-root")?.style.setProperty("--ob-cover", `url(${JSON.stringify(shown.art)})`);
  }, [shown.art]);

  useEffect(() => {
    const drum = drumRef.current;
    const rings = ringRefs.current;
    if (!drum || typeof window.requestAnimationFrame !== "function") return;
    if (document.documentElement.classList.contains("reduce-motion") || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    const angle = Array.from({ length: RINGS }, (_, r) => START(r));
    const vel = [...PACE];
    /** Turns that glide in rather than jump: a step's notch, and a roll of the trackpad or wheel. */
    const notch = Array.from({ length: RINGS }, () => ({ at: 0, to: 0 }));
    const roll = Array.from({ length: RINGS }, () => ({ at: 0, to: 0 }));
    const total = (r: number): number => angle[r] + notch[r].at + roll[r].at;
    let drag: { ring: number; x: number; t: number; v: number } | null = null;
    /** The ring under the pointer slows to a stop, so a cover stays put while you look at it. */
    let held = -1;
    let rolled = -1;
    let aim = { x: 0, y: 0 };
    const ringOf = (e: Event): number => {
      const r = Number((e.target as Element | null)?.closest?.<HTMLElement>("[data-ring]")?.dataset.ring);
      return Number.isInteger(r) ? r : -1;
    };
    const onOver = (e: PointerEvent): void => {
      held = ringOf(e);
    };
    const onLeave = (): void => {
      held = -1;
    };
    const tilt = { x: 0, y: 0 };

    /** Degrees of turn for px of pointer travel across the front of the drum. */
    const degPerPx = (): number => {
      const tile = (drum.firstElementChild?.firstElementChild as HTMLElement | null)?.offsetWidth ?? 150;
      const radius = ((tile + 14) * PER_RING) / (2 * Math.PI);
      return 180 / (Math.PI * radius);
    };
    const onMove = (e: PointerEvent): void => {
      aim = { x: e.clientX / window.innerWidth - 0.5, y: e.clientY / window.innerHeight - 0.5 };
      if (!drag) return;
      const now = performance.now();
      const d = (e.clientX - drag.x) * degPerPx();
      angle[drag.ring] += d;
      const dt = Math.max(1, now - drag.t) / 1000;
      drag.v = drag.v * 0.6 + (d / dt) * 0.4;
      drag.x = e.clientX;
      drag.t = now;
    };
    const onDown = (e: PointerEvent): void => {
      const ring = ringOf(e);
      if (e.button !== 0 || ring < 0) return;
      e.preventDefault();
      drag = { ring, x: e.clientX, t: performance.now(), v: 0 };
      live.current.dragging = true;
      drum.classList.add("is-dragging");
    };
    const onUp = (): void => {
      if (!drag) return;
      vel[drag.ring] = Math.max(-400, Math.min(400, drag.v));
      drag = null;
      live.current.dragging = false;
      drum.classList.remove("is-dragging");
    };
    /** For a roll that starts between covers: the ring nearest the pointer's height, if it's on the drum's side. */
    const nearestRing = (x: number, y: number): number => {
      const stage = drum.closest(".ob-stage");
      if (!stage || x < stage.getBoundingClientRect().left) return -1;
      let best = -1;
      let gap = Infinity;
      for (let r = 0; r < RINGS; r++) {
        const tile = rings[r]?.children[frontTile(total(r))];
        if (!tile) continue;
        const box = tile.getBoundingClientRect();
        const d = Math.abs(box.top + box.height / 2 - y);
        if (d < gap) {
          gap = d;
          best = r;
        }
      }
      return best;
    };
    // Two fingers on a trackpad (or the mouse wheel) roll the ring under the pointer.
    const onWheel = (e: WheelEvent): void => {
      // A pinch zooms, a held ring is already turning, and over the words their column scrolls.
      if (e.ctrlKey || drag || (e.target as Element | null)?.closest?.(".ob-side, .app-drag")) return;
      const now = performance.now();
      const fresh = now > live.current.rollingUntil;
      // One gesture keeps the ring it started on, as covers slide away under the pointer.
      const ring = fresh ? (ringOf(e) >= 0 ? ringOf(e) : nearestRing(e.clientX, e.clientY)) : rolled;
      if (ring < 0) return;
      if (fresh) setHover(null);
      rolled = ring;
      live.current.rollingUntil = now + 200;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? window.innerHeight : 1;
      const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit;
      // A positive delta is content moving left: fingers moving left where content follows them.
      roll[ring].to -= d * degPerPx() * live.current.fingers;
    };
    drum.addEventListener("pointerdown", onDown);
    drum.addEventListener("pointerover", onOver);
    drum.addEventListener("pointerleave", onLeave);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
    window.addEventListener("wheel", onWheel, { passive: true });

    let last = performance.now();
    let lastFront = -1;
    let id = 0;
    const tick = (now: number): void => {
      const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
      last = now;
      const ease = (rate: number): number => 1 - Math.exp(-dt * rate);
      const state = live.current;
      if (state.notch) {
        for (let r = 0; r < RINGS; r++) notch[r].to += Math.sign(state.notch) * Math.sign(PACE[r]) * STEP;
        state.notch = 0;
      }
      for (let r = 0; r < RINGS; r++) {
        if (drag?.ring !== r) {
          // Back to its own pace (faster while the library comes back; still under the pointer).
          const pace = state.busy ? PACE[r] * 6 : r === held ? 0 : PACE[r];
          vel[r] += (pace - vel[r]) * ease(r === held ? 3 : 1.1);
          angle[r] += vel[r] * dt;
        }
        notch[r].at += (notch[r].to - notch[r].at) * ease(5);
        roll[r].at += (roll[r].to - roll[r].at) * ease(14);
        rings[r]?.style.setProperty("--a", `${total(r).toFixed(2)}deg`);
      }
      // The drum leans a little toward the pointer.
      tilt.x += (-aim.y * 7 - tilt.x) * ease(2.5);
      tilt.y += (aim.x * 9 - tilt.y) * ease(2.5);
      drum.style.setProperty("--tx", `${tilt.x.toFixed(2)}deg`);
      drum.style.setProperty("--ty", `${tilt.y.toFixed(2)}deg`);
      // The middle ring's front cover lights the page; it changes as the ring turns.
      const i = frontTile(total(MID));
      if (i !== lastFront) {
        lastFront = i;
        setFront(DRUM[MID][i]);
      }
      id = window.requestAnimationFrame(tick);
    };
    id = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(id);
      drum.removeEventListener("pointerdown", onDown);
      drum.removeEventListener("pointerover", onOver);
      drum.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onUp);
      window.removeEventListener("wheel", onWheel);
      drum.classList.remove("is-dragging");
    };
  }, []);

  return (
    <>
      <div aria-hidden className="ob-light">
        <span className={`ob-light-art${glow.on === "a" ? " is-on" : ""}`} style={glow.a ? bg(glow.a) : undefined} />
        <span className={`ob-light-art${glow.on === "b" ? " is-on" : ""}`} style={glow.b ? bg(glow.b) : undefined} />
        <div className="cover-glow-grain" />
      </div>
      <div aria-hidden className="ob-stage">
        <div className="ob-stage-in">
          <div ref={drumRef} className="ob-drum">
            {DRUM.map((ring, r) => (
              <div
                key={r}
                ref={(el) => {
                  ringRefs.current[r] = el;
                }}
                className="ob-drum-ring"
                style={{ ["--row" as string]: r - (RINGS - 1) / 2, ["--a" as string]: `${START(r)}deg` }}
              >
                {ring.map((c, i) => (
                  <span
                    key={i}
                    data-ring={r}
                    className={`ob-tile${c === shown ? " is-lit" : ""}`}
                    style={{ ["--i" as string]: i }}
                    onPointerEnter={() => enter(c)}
                    onPointerLeave={leave}
                  >
                    {/* Fades in once it's here; one that won't load leaves its place dark. */}
                    <img
                      className="ob-tile-art"
                      src={c.art}
                      alt=""
                      draggable={false}
                      decoding="async"
                      onLoad={(e) => e.currentTarget.classList.add("is-in")}
                      onError={(e) => {
                        e.currentTarget.style.visibility = "hidden";
                      }}
                    />
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
