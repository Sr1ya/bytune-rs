/**
 * Guest delete-protection modal. Guests have no cloud backup, so "Reset app
 * data" must never be a one-click mistake: this explains what deletion means
 * for a guest and routes "Sign in" / "Create account" into onboarding
 * (preserving the data for migration), with a clearly separated destructive
 * escape hatch. Escape / backdrop click behave like "Keep my data".
 */
import { useEffect, useRef } from "react";
import { ShieldAlert } from "lucide-react";

const btnBase =
  "w-full rounded-xl py-2.5 text-[13.5px] font-semibold transition-all duration-150 active:scale-[0.99] disabled:opacity-40 disabled:active:scale-100 select-none flex items-center justify-center gap-2";

export function GuestDeleteModal({
  onClose,
  onSignIn,
  onCreateAccount,
  onDeleteAnyway,
}: {
  onClose: () => void;
  onSignIn: () => void;
  onCreateAccount: () => void;
  onDeleteAnyway: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    const t = window.setTimeout(() => panelRef.current?.focus(), 30);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.clearTimeout(t);
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="guest-delete-title"
        onClick={(e) => e.stopPropagation()}
        className="w-[420px] max-w-full bg-surface border border-ink-hi/[0.1] rounded-2xl p-6 outline-none animate-rise-in"
      >
        <div className="flex items-start gap-3.5 mb-4">
          <div className="w-10 h-10 rounded-xl bg-amber-400/15 text-amber-400 grid place-items-center shrink-0">
            <ShieldAlert className="w-5 h-5" />
          </div>
          <div>
            <h2 id="guest-delete-title" className="text-[16px] font-semibold leading-snug">
              You're using ByTune as a guest
            </h2>
            <p className="text-[13px] text-ink-dim mt-1 leading-relaxed">
              Your data lives only on this PC. Deleting it now can't be undone. There's no cloud
              backup without an account.
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <button onClick={onCreateAccount} className={`${btnBase} bg-primary text-on-primary hover:brightness-110`}>
            Create account &amp; back up
          </button>
          <button onClick={onSignIn} className={`${btnBase} bg-panel border border-ink-hi/[0.09] hover:bg-ink-hi/[0.05] text-ink-hi`}>
            Sign in
          </button>
          <button onClick={onClose} className={`${btnBase} bg-ink-hi/[0.06] hover:bg-ink-hi/[0.1] text-ink-hi`}>
            Keep my data
          </button>
        </div>

        <div className="border-t border-ink-hi/[0.08] mt-4 pt-4">
          <button
            onClick={onDeleteAnyway}
            className="w-full rounded-xl py-2.5 text-[13.5px] font-semibold text-red-400 hover:bg-red-400/10 transition-colors select-none"
          >
            Delete anyway
          </button>
        </div>
      </div>
    </div>
  );
}
