/**
 * ByTune's menus: every right-click and "…" menu, the pickers in Settings and the player bar, and the
 * Create menu. One surface for all of them: a dark sheet with a single light that glides to the row
 * under the pointer or the keyboard, red on a destructive row. A menu about a song, a playlist, an
 * album or an artist opens with it at the top, lit by its cover. A chosen option carries a check at
 * the right; a row with more (›) opens its own menu beside it. Paint and motion: index.css (.menu).
 */
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight } from "lucide-react";
import { Artwork } from "./primitives";
import { upgradeArtwork } from "../lib/artwork";
import { useUI, type ContextMenuState, type MenuItem, type MenuSubject } from "../stores/ui";

/** Every kind of menu row, for focus and the keyboard (an action, and one of a set of choices). */
const ROWS = '[role^="menuitem"]:not(:disabled)';

/** Whether the last thing done was a key press: only then does a menu light the row the keyboard is
    on. A menu opened with the mouse focuses its first row without lighting it. (Kept by hand: the
    engine's own :focus-visible guesses "keyboard" before anything has been pressed in the window.) */
let byKeys = false;
const keysPressed = (): void => {
  byKeys = true;
};
const pointerPressed = (): void => {
  byKeys = false;
};

/**
 * A menu's light: one element under the rows, moved by hand to the row under the pointer or the
 * keyboard, so crossing rows re-renders nothing. `light` goes first in a relative list holding the
 * rows (each marked data-menu-row); `track` holds the handlers that move it, for that list.
 */
export function useMenuLight(): {
  light: ReactNode;
  to: (row: Element | null) => void;
  track: {
    onPointerOver: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerLeave: (e: React.PointerEvent<HTMLElement>) => void;
    onFocus: (e: React.FocusEvent<HTMLElement>) => void;
  };
} {
  const ref = useRef<HTMLSpanElement | null>(null);
  const to = (row: Element | null): void => {
    const el = ref.current;
    const list = el?.parentElement;
    if (!el || !list) return;
    if (!(row instanceof HTMLElement) || row.matches(":disabled")) {
      el.classList.remove("is-on");
      return;
    }
    const top = row.getBoundingClientRect().top - list.getBoundingClientRect().top;
    const place = (): void => {
      el.style.transform = `translateY(${top}px)`;
      el.style.height = `${row.offsetHeight}px`;
    };
    // From off, it appears on its row instead of gliding in from wherever it last was.
    if (el.classList.contains("is-on")) place();
    else {
      el.style.transition = "none";
      place();
      void el.offsetHeight;
      el.style.transition = "";
    }
    el.classList.toggle("is-danger", row.dataset.tone === "danger");
    el.classList.add("is-on");
  };
  /** Off a row, it rests on the row whose own menu is open, or on the keyboard's row, or goes out. */
  const rest = (list: Element): void => {
    const open = list.querySelector('[data-menu-row][aria-expanded="true"]');
    const focused = byKeys ? list.querySelector("[data-menu-row]:focus") : null;
    to(open ?? focused);
  };
  return {
    light: <span ref={ref} aria-hidden className="menu-light" />,
    to,
    track: {
      onPointerOver: (e) => {
        const row = (e.target as Element).closest("[data-menu-row]");
        if (row && e.currentTarget.contains(row)) to(row);
        else rest(e.currentTarget);
      },
      onPointerLeave: (e) => rest(e.currentTarget),
      // Keyboard focus only: a menu opened by the mouse focuses its first row without lighting it.
      onFocus: (e) => {
        const row = (e.target as Element).closest("[data-menu-row]");
        if (row && byKeys) to(row);
      },
    },
  };
}

/** What the menu acts on, at its top: the cover, the name and what it is, lit by the cover. */
function Subject({ subject }: { subject: MenuSubject }) {
  const src = subject.thumb ? upgradeArtwork(subject.thumb) : "";
  return (
    <div role="presentation" className="menu-subject" style={src ? ({ "--light": `url(${JSON.stringify(src)})` } as CSSProperties) : undefined}>
      <Artwork src={subject.thumb ?? ""} rounded={subject.round ? "rounded-full" : "rounded-lg"} className="w-10 h-10 shrink-0" iconClassName="w-4 h-4" alt="" />
      <span className="min-w-0 flex-1">
        <span className="menu-subject-title">{subject.title}</span>
        {subject.subtitle && <span className="menu-subject-sub">{subject.subtitle}</span>}
      </span>
    </div>
  );
}

/** One row: its icon (in a tile when it has a second line), its label and note, then a check (the
    chosen option) or a › (it has a menu of its own). */
function Row({
  item,
  open,
  onActivate,
  onEnter,
}: {
  item: MenuItem;
  /** its own menu is showing */
  open?: boolean;
  onActivate: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onEnter?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const Icon = item.icon;
  const more = !!item.children?.length;
  const choice = item.checked !== undefined;
  return (
    <button
      type="button"
      role={choice ? (item.toggle ? "menuitemcheckbox" : "menuitemradio") : "menuitem"}
      aria-checked={choice ? item.checked : undefined}
      aria-haspopup={more ? "menu" : undefined}
      aria-expanded={more ? !!open : undefined}
      data-menu-row=""
      data-tone={item.danger ? "danger" : undefined}
      disabled={item.disabled}
      onClick={onActivate}
      onMouseEnter={onEnter}
      className={["menu-row", item.note && "is-rich", item.danger && "is-danger", item.checked && "is-checked", open && "is-open"]
        .filter(Boolean)
        .join(" ")}
    >
      {Icon &&
        (item.note ? (
          <span className="menu-tile">
            <Icon className={`w-[18px] h-[18px] ${item.iconClassName ?? ""}`} />
          </span>
        ) : (
          <Icon className={`menu-icon ${item.iconClassName ?? ""}`} />
        ))}
      <span className="menu-text">
        <span className="menu-label">{item.label}</span>
        {item.note && <span className="menu-note">{item.note}</span>}
      </span>
      {item.checked && <Check className="menu-check" strokeWidth={2.5} />}
      {more && <ChevronRight className="menu-more" />}
    </button>
  );
}

/**
 * A list's rows in order with its captions and the hairlines between groups: never one first, never
 * two together (a subject brings its own). Subjects themselves are drawn by the menu, at its top.
 */
function rows(items: MenuItem[], row: (item: MenuItem, i: number) => ReactNode, afterSubject: boolean): ReactNode[] {
  const out: ReactNode[] = [];
  let any = afterSubject;
  let lastWasLine = afterSubject;
  items.forEach((item, i) => {
    if (item.subject) return;
    if (item.separatorBefore && any && !lastWasLine) out.push(<div key={`line-${i}`} role="separator" className="menu-sep" />);
    out.push(
      item.header ? (
        <div key={`caption-${i}`} role="presentation" className="menu-caption">
          {item.label}
        </div>
      ) : (
        <Fragment key={`${item.label}-${i}`}>{row(item, i)}</Fragment>
      )
    );
    any = true;
    lastWasLine = false;
  });
  return out;
}

/**
 * A row's own menu, beside it, through a portal: the main menu scrolls, and a flyout inside it would
 * be clipped to that scroll box. Its first row lines up with the row it came from; it opens to the
 * left when the right has no room, and is measured after mount, before paint.
 */
function Submenu({
  anchor,
  items,
  onClose,
  onMouseEnter,
  onMouseLeave,
}: {
  anchor: DOMRect;
  items: MenuItem[];
  onClose: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; flipped: boolean } | null>(null);
  const light = useMenuLight();

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = anchor.right + 6;
    let flipped = false;
    if (left + w > window.innerWidth - 8) {
      left = anchor.left - w - 6;
      flipped = true;
    }
    // Minus the sheet's padding: its first row sits level with the row it came from.
    const top = Math.max(8, Math.min(anchor.top - 6, window.innerHeight - h - 8));
    setPos({ left: Math.max(8, left), top, flipped });
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      data-menu-portal=""
      role="menu"
      className={`menu menu-sub fixed z-[101] min-w-[200px] max-w-[320px] max-h-[340px] overflow-y-auto${pos?.flipped ? " is-flipped" : ""}`}
      style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="menu-list" {...light.track}>
        {light.light}
        {rows(
          items,
          (item) => (
            <Row
              item={item}
              onActivate={(e) => {
                e.stopPropagation();
                item.action?.();
                onClose();
              }}
            />
          ),
          false
        )}
      </div>
    </div>,
    document.body
  );
}

export function ContextMenu() {
  const menu = useUI((s) => s.contextMenu);
  const close = useUI((s) => s.closeContextMenu);
  const ref = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState({ x: 0, y: 0, origin: "top left" });
  /** the open submenu: which item, and the row rect it flies out from */
  const [sub, setSub] = useState<{ index: number; anchor: DOMRect } | null>(null);
  /** grace timer so the cursor can travel from the row into the flyout */
  const subCloseTimer = useRef<number | null>(null);
  const light = useMenuLight();
  /** each menu opened gets a fresh sheet, so it unfolds again even when one was already up */
  const sheets = useRef(new WeakMap<ContextMenuState, number>());
  const opened = useRef(0);

  // Keys or pointer, whichever was used last (see byKeys); this menu is always mounted, so it listens.
  useEffect(() => {
    window.addEventListener("keydown", keysPressed, true);
    window.addEventListener("pointerdown", pointerPressed, true);
    return () => {
      window.removeEventListener("keydown", keysPressed, true);
      window.removeEventListener("pointerdown", pointerPressed, true);
    };
  }, []);

  const cancelSubClose = (): void => {
    if (subCloseTimer.current !== null) {
      window.clearTimeout(subCloseTimer.current);
      subCloseTimer.current = null;
    }
  };
  const scheduleSubClose = (): void => {
    cancelSubClose();
    subCloseTimer.current = window.setTimeout(() => setSub(null), 150);
  };

  // Measured in a layout effect so the very first paint is already at the
  // clamped position — a passive effect here let the menu flash at (0,0)
  // for a frame before jumping into place. (Submenu above does the same.)
  /** what had focus before the menu opened — it gets focus back on close */
  const returnFocus = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!menu) return;
    const el = ref.current;
    const w = el?.offsetWidth ?? 230;
    const h = el?.offsetHeight ?? 320;
    // Shift+F10 / the Menu key report (0, 0): open beside the focused element.
    let { x, y } = menu;
    if (x === 0 && y === 0 && document.activeElement instanceof HTMLElement) {
      const r = document.activeElement.getBoundingClientRect();
      [x, y] = [r.left + 16, r.bottom];
    }
    // Right-aligned menus hang off their right edge (x is that edge) —
    // settings selects drop down under the row's value, select-style.
    const left = Math.max(8, Math.min(menu.alignRight ? x - w : x, window.innerWidth - w - 8));
    // `above` menus hang from their bottom edge: y is the anchor's top, the
    // panel ends a beat above it — the playbar buttons open this way.
    const top = menu.above ? Math.max(8, y - h - 6) : Math.max(8, Math.min(y, window.innerHeight - h - 8));
    // It unfolds from the corner nearest where it was opened.
    const fromRight = !!menu.alignRight || left < x - 1;
    setPlace({ x: left, y: top, origin: `${menu.above ? "bottom" : "top"} ${fromRight ? "right" : "left"}` });
  }, [menu]);

  // A freshly opened menu always starts with every submenu folded, and with
  // focus on its first item so the keyboard can drive it.
  useEffect(() => {
    cancelSubClose();
    setSub(null);
    if (menu) {
      if (!returnFocus.current) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      ref.current?.querySelector<HTMLButtonElement>(ROWS)?.focus({ preventScroll: true });
    } else if (returnFocus.current) {
      // Only if focus left with the menu: an action that opened a dialog keeps it.
      const now = document.activeElement;
      if (returnFocus.current.isConnected && (!now || now === document.body)) returnFocus.current.focus({ preventScroll: true });
      returnFocus.current = null;
    }
    return cancelSubClose;
  }, [menu]);

  // Close on any press outside the menu. pointerdown, not click: the click
  // that opened the menu is still bubbling towards window when the menu
  // mounts, so a click listener here would be hit by that very event and
  // dismiss the menu before it ever painted. A press always starts after the
  // opener finished, so the next press outside — and only that — closes.
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (ref.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-menu-portal]")) return;
      close();
    };
    const onScroll = (e: Event): void => {
      // Only the listener's own scrolling behind the menu dismisses it: the
      // wheel or a trackpad (a touch drag or a scrollbar already closed it on
      // pointerdown). The page scrolling by itself, like synced lyrics gliding
      // to the next line, leaves it up. Scrolling the menu's own list (or its
      // submenu portal) keeps it up too.
      const t = e.target;
      if (t instanceof Node && ref.current?.contains(t)) return;
      if (t instanceof Element && t.closest("[data-menu-portal]")) return;
      close();
    };
    const onKey = (e: KeyboardEvent): void => {
      const active = document.activeElement as HTMLElement | null;
      const inSub = !!active?.closest("[data-menu-portal]");
      const list = (inSub ? active!.closest("[data-menu-portal]") : ref.current) as HTMLElement | null;
      const items = list ? [...list.querySelectorAll<HTMLButtonElement>(ROWS)] : [];
      const at = items.indexOf(active as HTMLButtonElement);
      const focusAt = (i: number): void => items[(i + items.length) % items.length]?.focus({ preventScroll: false });
      if (e.key === "Escape") {
        // First Escape folds the submenu, the second dismisses the menu.
        if (sub !== null) {
          setSub(null);
          ref.current?.querySelector<HTMLButtonElement>('[aria-expanded="true"]')?.focus();
          return;
        }
        close();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        focusAt(at < 0 ? (e.key === "ArrowDown" ? 0 : -1) : at + (e.key === "ArrowDown" ? 1 : -1));
      } else if (e.key === "Home" || e.key === "End") {
        e.preventDefault();
        focusAt(e.key === "Home" ? 0 : -1);
      } else if (e.key === "ArrowRight" && !inSub && active?.getAttribute("aria-haspopup") === "menu") {
        e.preventDefault();
        if (active.getAttribute("aria-expanded") !== "true") active.click();
        window.setTimeout(() => {
          document.querySelector<HTMLButtonElement>(`[data-menu-portal] ${ROWS}`)?.focus();
        }, 0);
      } else if (e.key === "ArrowLeft" && inSub) {
        e.preventDefault();
        setSub(null);
        ref.current?.querySelector<HTMLButtonElement>('[aria-expanded="true"]')?.focus();
      } else if (e.key === "Tab") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("wheel", onScroll, { capture: true, passive: true });
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", onScroll, { capture: true });
    };
  }, [menu, close, sub]);

  if (!menu) return null;
  let sheet = sheets.current.get(menu);
  if (sheet === undefined) {
    sheet = ++opened.current;
    sheets.current.set(menu, sheet);
  }
  const subject = menu.items.find((item) => item.subject)?.subject;

  return (
    <div
      key={sheet}
      ref={ref}
      role="menu"
      aria-orientation="vertical"
      aria-label={subject?.title}
      className={`menu fixed z-[100] min-w-[220px] max-w-[320px] max-h-[70vh] overflow-y-auto${menu.above ? " is-above" : ""}`}
      style={{ left: place.x, top: place.y, "--menu-origin": place.origin } as CSSProperties}
      onContextMenu={(e) => e.preventDefault()}
      onMouseLeave={() => {
        // Leaving the menu with a flyout open closes it after a short grace
        // period — enough for the cursor to cross into the flyout itself.
        if (sub !== null) scheduleSubClose();
      }}
    >
      <div className="menu-list" {...light.track}>
        {light.light}
        {subject && (
          <>
            <Subject subject={subject} />
            <div role="separator" className="menu-sep" />
          </>
        )}
        {rows(
          menu.items,
          (item, i) => {
            const more = !!item.children?.length;
            const open = more && sub?.index === i;
            return (
              <>
                <Row
                  item={item}
                  open={open}
                  onEnter={(e) => {
                    cancelSubClose();
                    if (!more) {
                      setSub(null);
                      return;
                    }
                    const rect = e.currentTarget.getBoundingClientRect();
                    setSub(sub?.index === i ? sub : { index: i, anchor: rect });
                  }}
                  onActivate={(e) => {
                    e.stopPropagation();
                    if (more) {
                      const rect = e.currentTarget.getBoundingClientRect();
                      setSub(open ? null : { index: i, anchor: rect });
                      return;
                    }
                    item.action?.();
                    close();
                  }}
                />
                {open && sub && (
                  <Submenu anchor={sub.anchor} items={item.children!} onClose={close} onMouseEnter={cancelSubClose} onMouseLeave={scheduleSubClose} />
                )}
              </>
            );
          },
          !!subject
        )}
      </div>
    </div>
  );
}
