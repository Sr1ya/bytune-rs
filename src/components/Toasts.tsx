import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Info, X } from "lucide-react";
import { useUI, type Toast } from "../stores/ui";

const KIND_STYLES = {
  info: {
    icon: Info,
    tint: "text-white",
    badge: "bg-white/[0.14]",
    ring: "rgba(255,255,255,0.75)",
    glow: "255 255 255",
  },
  success: {
    icon: Check,
    tint: "text-emerald-300",
    badge: "bg-emerald-400/[0.16]",
    ring: "rgba(110,231,183,0.9)",
    glow: "52 211 153",
  },
  error: {
    icon: X,
    tint: "text-red-300",
    badge: "bg-red-400/[0.16]",
    ring: "rgba(252,165,165,0.9)",
    glow: "248 113 113",
  },
  warning: {
    icon: AlertTriangle,
    tint: "text-amber-300",
    badge: "bg-amber-400/[0.16]",
    ring: "rgba(252,211,77,0.9)",
    glow: "251 191 36",
  },
} as const;

/** Countdown ring geometry — r=16.75 on the 36px badge viewBox. Must match
    the `to` value of the toast-ring keyframes in index.css. */
const RING_C = 2 * Math.PI * 16.75;

/** The notification layer: beacons drop from under the top bar, centre
    screen, stack newest-first. Each card owns its own countdown so hovering
    pauses both the ring and the auto-dismiss timer. */
export function Toasts() {
  const toasts = useUI((s) => s.toasts);
  const dismiss = useUI((s) => s.dismissToast);

  if (!toasts.length) return null;

  return (
    <div
      className="fixed top-[78px] left-1/2 -translate-x-1/2 z-[110] flex flex-col items-center gap-2.5 pointer-events-none"
      aria-live="polite"
    >
      {/* Newest lands nearest the top bar; older beacons are pushed down. */}
      {[...toasts].reverse().map((toast) => (
        <ToastCard key={toast.id} toast={toast} onDone={() => dismiss(toast.id)} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDone }: { toast: Toast; onDone: () => void }) {
  const { icon: Icon, tint, badge, ring, glow } = KIND_STYLES[toast.kind];
  const duration = toast.duration ?? 4600;
  const [leaving, setLeaving] = useState(false);
  const [hover, setHover] = useState(false);
  const remaining = useRef(duration);
  const startedAt = useRef(0);
  const closing = useRef(false);

  const close = () => {
    if (closing.current) return;
    closing.current = true;
    setLeaving(true);
    window.setTimeout(onDone, 340);
  };

  // Countdown that banks the remaining time whenever hover pauses it, so the
  // ring (a pure CSS animation paused in sync) and this timer never drift.
  useEffect(() => {
    if (hover || closing.current) return;
    startedAt.current = performance.now();
    const t = window.setTimeout(close, remaining.current);
    return () => {
      window.clearTimeout(t);
      remaining.current -= performance.now() - startedAt.current;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hover]);

  return (
    <div
      className={`group relative pointer-events-auto ${leaving ? "toast-lift" : "toast-drop"}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      role="status"
    >
      {/* kind-coloured ambience blooming behind the glass */}
      <div
        aria-hidden
        className="absolute -inset-5 rounded-full blur-lg pointer-events-none transition-opacity duration-500"
        style={{
          background: `radial-gradient(closest-side, rgb(${glow} / 0.20), transparent)`,
          opacity: hover ? 1 : 0.5,
        }}
      />
      <div className={toast.kind === "error" ? "toast-shake" : undefined}>
        <div className="relative flex items-center gap-3 rounded-full toast-beacon pl-1.5 pr-2 py-1.5 overflow-hidden min-w-[320px] max-w-[440px] transition-transform duration-300 hover:scale-[1.015]">
          {/* one-shot light sweep on arrival */}
          <span
            aria-hidden
            className="toast-sheen pointer-events-none absolute inset-y-0 left-0 w-1/3 bg-gradient-to-r from-transparent via-white/[0.10] to-transparent"
          />
          {/* icon badge wrapped by the countdown ring */}
          <div className="toast-icon relative shrink-0 w-9 h-9">
            <svg viewBox="0 0 36 36" className="absolute inset-0 w-full h-full -rotate-90">
              <circle cx="18" cy="18" r="16.75" fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth="1.5" />
              <circle
                cx="18"
                cy="18"
                r="16.75"
                fill="none"
                stroke={ring}
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeDasharray={RING_C}
                style={{
                  animation: `toast-ring ${duration}ms linear forwards`,
                  animationPlayState: hover ? "paused" : "running",
                }}
              />
            </svg>
            <div className={`absolute inset-[6px] rounded-full grid place-items-center ${badge}`}>
              <Icon className={`w-[13px] h-[13px] ${tint}`} strokeWidth={2.4} />
            </div>
          </div>
          <p className="text-[13px] font-medium text-ink-hi leading-snug pr-0.5 select-none">{toast.message}</p>
          <button
            onClick={close}
            className="relative shrink-0 ml-auto w-6 h-6 rounded-full grid place-items-center text-ink-faint hover:text-ink-hi hover:bg-white/10 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all duration-200"
            title="Dismiss"
            aria-label="Dismiss notification"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
