/**
 * Drag-to-reorder for a vertical list, by grabbing a row anywhere: the row
 * lifts and follows the pointer while the others slide out of its way, the
 * list scrolls when the pointer nears its edge, and on release the row glides
 * into its slot before the new order is committed (back home on Escape).
 * Alt+↑/↓ on a focused row moves it one step. Entries are the direct children
 * of `listRef`; a press on a button inside a row never starts a drag.
 *
 * Rows that are also native drag sources (a playlist's songs, dropped onto
 * other playlists or the queue) use `dragProps` instead: the same picture over
 * the browser's own drag, so one gesture can either reorder the list or carry
 * the song out of it. Over the list's column the copy shows a slot and a
 * release lands there; off it the copy shrinks to a card that whatever is
 * under the pointer takes.
 *
 * A finger picks a row up by holding still on it for a moment (TOUCH_HOLD_MS),
 * anywhere on it, its buttons and links included (a tap still presses them):
 * the row lifts at once, then follows the finger. Moving sooner scrolls the
 * list; letting go without moving puts the row back and leaves its long-press
 * menu to open. A finger moves a native row with the same in-list drag, since
 * a touch can't carry a native drag.
 */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";

interface Drag {
  from: number;
  target: number;
  /** layout at grab time, relative to the list's top */
  tops: number[];
  heights: number[];
  gap: number;
  /** the list as it was at grab time — a different list at commit time skips the commit */
  signature: string;
  /** gliding into place after release: the final offset */
  settleTo: number | null;
  /** a native (HTML) drag: a floating copy of the row follows the pointer */
  native?: boolean;
}

export interface SortableDragProps {
  onDragStart: (e: DragEvent<HTMLElement>) => void;
  onDragEnd: (e: DragEvent<HTMLElement>) => void;
  /** a finger's hold-to-drag; a mouse drags natively */
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: PointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
}

export interface SortableRowProps {
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: PointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onClickCapture: (e: MouseEvent<HTMLElement>) => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
}

const SETTLE_MS = 180;
const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const START_PX = 5;
/** How long a finger holds still on a row before moving it drags instead of scrolling the list. */
const TOUCH_HOLD_MS = 400;
/** A finger that strays this far before the hold is scrolling. */
const TOUCH_SLOP_PX = 10;
const EDGE_PX = 48;
/** How wide the floating copy gets once it leaves the list, on its way to another drop target. */
const COMPACT_PX = 320;
const LIFT = "0 10px 28px rgba(0, 0, 0, 0.5)";
/** Hides the browser's own drag picture, which would double the row we draw. */
const BLANK =
  typeof Image !== "undefined"
    ? Object.assign(new Image(), { src: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" })
    : null;
/** Where the dragged row's top sits, relative to the list, once it takes list slot `t`. */
const slotTop = (d: Drag, t: number): number => (t > d.from ? d.tops[t] + d.heights[t] - d.heights[d.from] : d.tops[t]);
const reduced = (): boolean =>
  document.documentElement.classList.contains("reduce-motion") ||
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function useSortable(opts: {
  /** changes whenever the entries change — a change mid-drag drops the drag */
  signature: string;
  listRef: RefObject<HTMLElement | null>;
  scrollRef: RefObject<HTMLElement | null>;
  /** where a row may land (e.g. your songs stay above the AutoPlay line) */
  clamp: (from: number, target: number) => number;
  canDrag: (index: number) => boolean;
  onCommit: (from: number, target: number) => void;
}): {
  styleFor: (index: number) => CSSProperties | undefined;
  rowProps: (index: number) => SortableRowProps;
  dragProps: (index: number) => SortableDragProps;
  /** the row being dragged or gliding home, so a list that builds only the rows in view keeps it */
  dragging: number | null;
} {
  const [drag, setDrag] = useState<Drag | null>(null);
  const live = useRef<Drag | null>(null);
  /** A press on a row; a finger's (`touch`) only drags once its hold has `armed` it. */
  const press = useRef<{ x: number; y: number; el: HTMLElement; touch: boolean; armed: boolean; undrag: boolean; timer: number } | null>(
    null,
  );
  const pointer = useRef({ startX: 0, startY: 0, startScroll: 0, x: 0, y: 0 });
  const row = useRef<HTMLElement | null>(null);
  /** the floating copy of a natively dragged row */
  const ghost = useRef<{ el: HTMLElement; rect: DOMRect; grabX: number; inside: boolean } | null>(null);
  const raf = useRef(0);
  const suppressClick = useRef(false);
  /** The lifted row has moved: a finger dragging it isn't asking for its long-press menu. */
  const shifted = useRef(false);
  const o = useRef(opts);
  o.current = opts;

  const put = (d: Drag | null): void => {
    live.current = d;
    setDrag(d);
  };
  /** The press is over: its hold stops, and a native row gets its own drag back. */
  const release = (): void => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    window.clearTimeout(p.timer);
    if (p.undrag) p.el.draggable = true;
  };
  const end = (): void => {
    window.cancelAnimationFrame(raf.current);
    if (row.current) row.current.style.transform = "";
    row.current = null;
    ghost.current?.el.remove();
    ghost.current = null;
    shifted.current = false;
    release(); // the gesture is over: moving before the release must not start it again
    put(null);
  };

  // The list changed under the pointer (a suggestion arrived, the song moved on):
  // a press or drag on the old list never carries over to the new one.
  useEffect(() => {
    release();
    if (live.current && live.current.settleTo === null) end();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.signature]);
  useEffect(
    () => () => {
      window.cancelAnimationFrame(raf.current);
      release(); // a hold still waiting must not lift a row that's gone
    },
    [],
  );

  // A finger's drag must not scroll the list under it: once its hold has armed it, its touchmoves
  // are cancelled. The listener sits on the list, never the window, so other touches keep scrolling
  // smoothly; and it is there before a touch starts, which it has to be to cancel one.
  const touchGuard = useRef<{ list: HTMLElement | null; move: (e: TouchEvent) => void; menu: (e: Event) => void } | null>(null);
  useEffect(() => {
    touchGuard.current ??= {
      list: null,
      move: (e) => {
        if (press.current?.touch && press.current.armed && e.cancelable) e.preventDefault();
      },
      // A finger that has moved the row isn't asking for its long-press menu; one still holding may be.
      menu: (e) => {
        if (live.current && press.current?.touch && shifted.current) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
    };
    const g = touchGuard.current;
    const list = opts.listRef.current;
    if (list === g.list) return;
    g.list?.removeEventListener("touchmove", g.move);
    g.list?.removeEventListener("contextmenu", g.menu, true);
    list?.addEventListener("touchmove", g.move, { passive: false });
    list?.addEventListener("contextmenu", g.menu, true);
    g.list = list;
  });
  useEffect(
    () => () => {
      const g = touchGuard.current;
      if (!g) return;
      g.list?.removeEventListener("touchmove", g.move);
      g.list?.removeEventListener("contextmenu", g.menu, true);
      g.list = null; // a remount (StrictMode runs one in development) attaches them again
    },
    [],
  );

  /** Glide the row into list slot `target` (its own slot cancels), then commit. */
  const settle = (target: number): void => {
    const d = live.current;
    if (!d || d.settleTo !== null) return;
    window.cancelAnimationFrame(raf.current);
    put({ ...d, target, settleTo: slotTop(d, target) - d.tops[d.from] });
    const g = ghost.current;
    const list = o.current.listRef.current;
    if (g && list) {
      // The floating copy lands exactly on the slot, at full width, and settles down.
      const y = list.getBoundingClientRect().top + slotTop(d, target) - g.rect.top;
      const ease = reduced() ? "none" : `transform ${SETTLE_MS}ms ${EASE}, box-shadow ${SETTLE_MS}ms ${EASE}, width ${SETTLE_MS}ms ${EASE}`;
      g.el.querySelectorAll<HTMLElement>("[data-ghost-hide]").forEach((e) => (e.style.display = ""));
      Object.assign(g.el.style, { transition: ease, width: `${g.rect.width}px`, transform: `translate(0px, ${y}px)`, boxShadow: "0 0 0 rgba(0, 0, 0, 0)" });
    }
    window.setTimeout(
      () =>
        // One render for the new order and the cleared offsets, so nothing flickers.
        flushSync(() => {
          // Same list rows, so the commit lands what the listener saw.
          if (target !== d.from && o.current.signature === d.signature) o.current.onCommit(d.from, target);
          end();
        }),
      reduced() ? 0 : SETTLE_MS,
    );
  };

  const active = drag !== null && drag.settleTo === null;
  useEffect(() => {
    if (!active) return;
    if (live.current?.native) {
      // The browser owns a native drag's input; the document hears each step first. While the
      // copy shows a slot the drag is the list's alone (the header and the page's own "drop to
      // add" never see it), so a release lands the song in the slot it shows.
      let awayTimer = 0;
      const onOver = (e: globalThis.DragEvent): void => {
        window.clearTimeout(awayTimer); // still in the window
        pointer.current.x = e.clientX;
        pointer.current.y = e.clientY;
        if (!updateNative()) return; // the compact card: whatever is under the pointer decides
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      };
      const onDrop = (e: globalThis.DragEvent): void => {
        const d = live.current;
        if (!d || !ghost.current?.inside) return; // the last frame drawn decides
        e.preventDefault();
        e.stopPropagation();
        settle(d.target);
      };
      // Out of the window nothing here takes the release, and the copy says so. A cancelled drag
      // (Escape) sends the same dragleave just before its dragend, so the card waits a moment:
      // a cancel glides home from the slot the copy shows.
      const onLeave = (e: globalThis.DragEvent): void => {
        if (e.relatedTarget !== null) return;
        window.clearTimeout(awayTimer);
        awayTimer = window.setTimeout(() => updateNative(true), 100);
      };
      document.addEventListener("dragenter", onOver, true);
      document.addEventListener("dragover", onOver, true);
      document.addEventListener("drop", onDrop, true);
      document.addEventListener("dragleave", onLeave, true);
      return () => {
        window.clearTimeout(awayTimer);
        document.removeEventListener("dragenter", onOver, true);
        document.removeEventListener("dragover", onOver, true);
        document.removeEventListener("drop", onDrop, true);
        document.removeEventListener("dragleave", onLeave, true);
      };
    }
    const cancel = (): void => {
      release();
      if (live.current) settle(live.current.from);
    };
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      // Before the app's own Escape, which would close the queue.
      e.preventDefault();
      e.stopImmediatePropagation();
      cancel();
    };
    // The window hears the drag too: the browser can drop the row's pointer
    // capture mid-drag, and the release may land anywhere.
    const onUp = (): void => {
      release();
      if (live.current) settle(live.current.target);
    };
    const onMove = (e: globalThis.PointerEvent): void => {
      if (!(e.buttons & 1)) return onUp(); // the button came up out of our sight: drop it where it shows
      pointer.current.y = e.clientY;
      update();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("blur", cancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // The dragged row moves outside React (every pointer move would otherwise
  // re-render the whole list); React only hears when the target slot changes.
  const update = (): void => {
    const d = live.current;
    if (!d || d.settleTo !== null) return;
    const scroll = o.current.scrollRef.current;
    const offset = pointer.current.y - pointer.current.startY + (scroll?.scrollTop ?? 0) - pointer.current.startScroll;
    if (Math.abs(offset) >= START_PX) shifted.current = true;
    // On screen the row stops at the edges of where it may land; the slot still follows the pointer.
    const lo = slotTop(d, o.current.clamp(d.from, 0)) - d.tops[d.from];
    const hi = slotTop(d, o.current.clamp(d.from, d.tops.length - 1)) - d.tops[d.from];
    if (row.current) row.current.style.transform = `translateY(${Math.min(Math.max(offset, lo), hi)}px) scale(1.02)`;
    const center = d.tops[d.from] + d.heights[d.from] / 2 + offset;
    let target = 0;
    for (let j = 0; j < d.tops.length; j++) if (j !== d.from && d.tops[j] + d.heights[j] / 2 < center) target++;
    target = o.current.clamp(d.from, target);
    if (target !== d.target) put({ ...d, target });
  };

  /**
   * A native drag moved: the copy follows, locked to the list while over its column, and the
   * slots follow it there. Returns whether the copy shows a slot (`away`: the pointer left the window).
   */
  const updateNative = (away = false): boolean => {
    const d = live.current;
    const g = ghost.current;
    const list = o.current.listRef.current;
    if (!d || !g || !list || d.settleTo !== null) return false;
    const lr = list.getBoundingClientRect();
    // The list's column where the page shows: over the header or under the last row the copy
    // parks at the first or last slot, and a release there lands in it.
    const page = o.current.scrollRef.current?.getBoundingClientRect() ?? lr;
    const { x, y, startX, startY } = pointer.current;
    const inside = !away && x >= lr.left && x <= lr.right && y >= page.top && y <= page.bottom;
    if (inside !== g.inside) {
      g.inside = inside;
      g.el.style.width = `${inside ? g.rect.width : Math.min(g.rect.width, COMPACT_PX)}px`;
      // The compact card keeps the cover and the names; rows mark the rest `data-ghost-hide`.
      g.el.querySelectorAll<HTMLElement>("[data-ghost-hide]").forEach((e) => (e.style.display = inside ? "" : "none"));
    }
    let tx = 0;
    let ty = y - startY;
    if (inside) {
      const lo = lr.top + slotTop(d, o.current.clamp(d.from, 0)) - g.rect.top;
      const hi = lr.top + slotTop(d, o.current.clamp(d.from, d.tops.length - 1)) - g.rect.top;
      ty = Math.min(Math.max(ty, lo), hi);
    } else {
      // Compact, held by its cover: it stays on screen wherever the row was grabbed.
      tx = x - startX + g.grabX - Math.min(g.grabX, 56);
    }
    g.el.style.transform = `translate(${tx}px, ${ty}px) scale(1.02)`;
    let target = d.from; // outside the list nothing moves
    if (inside) {
      const scroll = o.current.scrollRef.current;
      const center = d.tops[d.from] + d.heights[d.from] / 2 + (y - startY) + (scroll?.scrollTop ?? 0) - pointer.current.startScroll;
      target = 0;
      for (let j = 0; j < d.tops.length; j++) if (j !== d.from && d.tops[j] + d.heights[j] / 2 < center) target++;
      target = o.current.clamp(d.from, target);
    }
    if (target !== d.target) put({ ...d, target });
    return inside;
  };

  const autoScroll = (): void => {
    const scroll = o.current.scrollRef.current;
    const list = o.current.listRef.current;
    const d = live.current;
    if (!scroll || !list || !d || d.settleTo !== null) return;
    const r = scroll.getBoundingClientRect();
    const y = pointer.current.y;
    const over = y < r.top + EDGE_PX ? y - r.top - EDGE_PX : y > r.bottom - EDGE_PX ? y - r.bottom + EDGE_PX : 0;
    // Only while the farthest slot the row may take that way is still out of view.
    const top = list.getBoundingClientRect().top;
    const room =
      over < 0
        ? top + slotTop(d, o.current.clamp(d.from, 0)) < r.top
        : top + slotTop(d, o.current.clamp(d.from, d.tops.length - 1)) + d.heights[d.from] > r.bottom;
    if (over && room) {
      const before = scroll.scrollTop;
      scroll.scrollTop += Math.sign(over) * Math.min(18, Math.max(1, Math.round(Math.abs(over) / 3)));
      if (scroll.scrollTop !== before) update();
    }
    raf.current = window.requestAnimationFrame(autoScroll);
  };

  const begin = (p: { y: number; el: HTMLElement }): void => {
    const list = o.current.listRef.current;
    if (!list) return;
    suppressClick.current = true; // the release is not a click on the row
    // The list's own entry: a native row's handlers sit on the row inside it.
    const el = [...list.children].find((c) => c === p.el || c.contains(p.el)) as HTMLElement | undefined;
    const from = el ? [...list.children].indexOf(el) : -1;
    if (!el || from < 0 || !o.current.canDrag(from)) {
      release();
      return;
    }
    const base = list.getBoundingClientRect().top;
    const rects = [...list.children].map((c) => c.getBoundingClientRect());
    row.current = el;
    pointer.current = { startX: 0, startY: p.y, startScroll: o.current.scrollRef.current?.scrollTop ?? 0, x: 0, y: p.y };
    put({
      from,
      target: from,
      tops: rects.map((r) => r.top - base),
      heights: rects.map((r) => r.height),
      gap: rects.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : 0,
      signature: o.current.signature,
      settleTo: null,
    });
    raf.current = window.requestAnimationFrame(autoScroll);
  };

  const beginNative = (i: number, e: DragEvent<HTMLElement>): void => {
    const list = o.current.listRef.current;
    const el = list?.children[i] as HTMLElement | undefined;
    if (!list || !el || live.current || !o.current.canDrag(i)) return;
    // Moving here, copying onto another playlist or the queue.
    e.dataTransfer.effectAllowed = "copyMove";
    if (BLANK) e.dataTransfer.setDragImage(BLANK, 0, 0);
    const base = list.getBoundingClientRect().top;
    const rects = [...list.children].map((c) => c.getBoundingClientRect());
    const rect = rects[i];
    const copy = el.cloneNode(true) as HTMLElement;
    Object.assign(copy.style, {
      position: "fixed",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      margin: "0",
      zIndex: "1000",
      pointerEvents: "none",
      borderRadius: "8px",
      overflow: "hidden",
      background: "rgb(var(--elevated))",
      boxShadow: LIFT,
      transform: "scale(1.02)",
      transition: reduced() ? "none" : `width 160ms ${EASE}`,
    });
    document.body.appendChild(copy);
    ghost.current = { el: copy, rect, grabX: e.clientX - rect.left, inside: true };
    pointer.current = {
      startX: e.clientX,
      startY: e.clientY,
      startScroll: o.current.scrollRef.current?.scrollTop ?? 0,
      x: e.clientX,
      y: e.clientY,
    };
    put({
      from: i,
      target: i,
      tops: rects.map((r) => r.top - base),
      heights: rects.map((r) => r.height),
      gap: rects.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : 0,
      signature: o.current.signature,
      settleTo: null,
      native: true,
    });
  };

  /** A press on row `i`. `native`: the row drags natively under a mouse, so only a finger is ours. */
  const pressRow = (e: PointerEvent<HTMLElement>, i: number, native: boolean): void => {
    suppressClick.current = false;
    const touch = e.pointerType === "touch" || e.pointerType === "pen";
    if ((native && !touch) || e.button !== 0 || live.current || !o.current.canDrag(i)) return;
    // A mouse on the row's own buttons and links presses them. A finger holding one picks the row up
    // (most of a row is links on a touchscreen); its tap still presses it.
    if (!touch && (e.target as HTMLElement).closest("button, a, input")) return;
    release();
    const el = e.currentTarget;
    if (!touch) {
      el.setPointerCapture(e.pointerId);
      press.current = { x: e.clientX, y: e.clientY, el, touch, armed: true, undrag: false, timer: 0 };
      return;
    }
    // A finger first holds still, then the row lifts where it lies, so the finger knows it has it. The
    // row's own native drag (carrying the song to a playlist) is off meanwhile: a long press can't start it.
    const undrag = el.draggable;
    if (undrag) el.draggable = false;
    const p = { x: e.clientX, y: e.clientY, el, touch, armed: false, undrag, timer: 0 };
    p.timer = window.setTimeout(() => {
      p.armed = true;
      if (press.current !== p || live.current) return;
      begin(p);
      update();
    }, TOUCH_HOLD_MS);
    press.current = p;
  };
  const moveRow = (e: PointerEvent<HTMLElement>): void => {
    const p = press.current;
    if (!p) return;
    if (!live.current) {
      const moved = Math.hypot(e.clientX - p.x, e.clientY - p.y);
      if (!p.armed) {
        if (moved > TOUCH_SLOP_PX) release(); // moved before the hold: the finger is scrolling the list
        return;
      }
      if (moved < START_PX) return;
      begin(p);
    }
    pointer.current.y = e.clientY;
    update();
  };
  // Only a drag this hook moves itself: a native drag's start cancels the pointer, and its own events end it.
  const upRow = (): void => {
    const d = live.current;
    release();
    if (d && !d.native) settle(d.target);
  };
  const cancelRow = (): void => {
    const d = live.current;
    release();
    if (d && !d.native) settle(d.from);
  };

  const dragProps = (i: number): SortableDragProps => ({
    onDragStart: (e) => {
      if (!e.defaultPrevented) beginNative(i, e); // a press on the row's own buttons isn't a drag
    },
    onDragEnd: (e) => {
      const d = live.current;
      if (!d?.native || d.settleTo !== null) return; // dropped in the list: already gliding into place
      if (e.dataTransfer.dropEffect !== "none") end(); // taken by another target (copied into a playlist)
      else settle(d.from); // Escape, or let go somewhere else: glide home
    },
    onPointerDown: (e) => pressRow(e, i, true),
    onPointerMove: moveRow,
    onPointerUp: upRow,
    onPointerCancel: cancelRow,
  });

  const still = drag ? reduced() : false;
  const styleFor = (i: number): CSSProperties | undefined => {
    const d = drag;
    if (!d) return undefined;
    // A native drag's floating copy is what moves; the row's own slot is the gap.
    if (i === d.from && d.native) return { opacity: 0 };
    if (i === d.from) {
      const settling = d.settleTo !== null;
      return {
        position: "relative",
        zIndex: 20,
        cursor: "grabbing",
        background: settling ? "rgb(var(--elevated) / 0)" : "rgb(var(--elevated))",
        boxShadow: settling ? "0 0 0 rgba(0, 0, 0, 0)" : LIFT,
        transition:
          settling && !still
            ? `transform ${SETTLE_MS}ms ${EASE}, box-shadow ${SETTLE_MS}ms ${EASE}, background-color ${SETTLE_MS}ms ${EASE}`
            : "none",
        ...(settling ? { transform: `translateY(${d.settleTo}px)` } : null),
      };
    }
    const span = d.heights[d.from] + d.gap;
    const shift =
      d.from < d.target && i > d.from && i <= d.target ? -span : d.target < d.from && i >= d.target && i < d.from ? span : 0;
    return {
      transform: shift ? `translateY(${shift}px)` : undefined,
      transition: still ? "none" : `transform ${SETTLE_MS}ms ${EASE}`,
    };
  };

  const rowProps = (i: number): SortableRowProps => ({
    onPointerDown: (e) => pressRow(e, i, false),
    onPointerMove: moveRow,
    onPointerUp: upRow,
    onPointerCancel: cancelRow,
    onClickCapture: (e) => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      e.stopPropagation();
      e.preventDefault();
    },
    onKeyDown: (e) => {
      if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown") || live.current) return;
      e.preventDefault();
      e.stopPropagation(); // not the player's own arrow shortcuts, even when the row can't move
      const target = o.current.clamp(i, i + (e.key === "ArrowUp" ? -1 : 1));
      const list = o.current.listRef.current;
      if (!list || !o.current.canDrag(i) || target === i || target < 0 || target >= list.children.length) return;
      o.current.onCommit(i, target);
      // The row's DOM node moved, which drops focus: put it back on the moved row.
      window.requestAnimationFrame(() => (list.children[target] as HTMLElement | undefined)?.focus());
    },
  });

  return { styleFor, rowProps, dragProps, dragging: drag?.from ?? null };
}
