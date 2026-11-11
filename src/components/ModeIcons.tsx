/**
 * ModeIcons — shuffle / repeat state glyphs, drawn from the Bootstrap
 * Icons set (filled, 16-box) used by the user's reference component.
 * Each button is ONE persistent svg; state differences are always-mounted
 * overlays whose dash offset eases on toggle (no remounts, no keyframes):
 *
 *   shuffle   bi-shuffle.  on = plain; off = corner-to-corner slash.
 *   repeat    bi-arrow-repeat (Spotify's repeat icon). all = plain;
 *             one = "1" badge flows in at the centre; off = plain grey.
 */

type IconProps = { className?: string };

export function ShuffleIcon({
  on,
  className = "w-[18px] h-[18px]",
}: IconProps & { on: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden>
      <path
        d="M0 3.5A.5.5 0 0 1 .5 3H1c2.202 0 3.827 1.24 4.874 2.418.49.552.865 1.102 1.126 1.532.26-.43.636-.98 1.126-1.532C9.173 4.24 10.798 3 13 3v1c-1.798 0-3.173 1.01-4.126 2.082A9.624 9.624 0 0 0 7.556 8a9.624 9.624 0 0 0 1.317 1.918C9.828 10.99 11.204 12 13 12v1c-2.202 0-3.827-1.24-4.874-2.418A10.595 10.595 0 0 1 7 9.05c-.26.43-.636.98-1.126 1.532C4.827 11.76 3.202 13 1 13H.5a.5.5 0 0 1 0-1H1c1.798 0 3.173-1.01 4.126-2.082A9.624 9.624 0 0 0 6.444 8a9.624 9.624 0 0 0-1.317-1.918C4.172 5.01 2.796 4 1 4H.5a.5.5 0 0 1-.5-.5z"
        fillRule="evenodd"
      />
      <path d="M13 5.466V1.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384l-2.36 1.966a.25.25 0 0 1-.41-.192zm0 9v-3.932a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384l-2.36 1.966a.25.25 0 0 1-.41-.192z" />
      <line
        x1="1.1"
        y1="1.1"
        x2="14.9"
        y2="14.9"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        pathLength={1}
        strokeDasharray={1}
        strokeDashoffset={on ? 1 : 0}
        className="flow-dash"
      />
    </svg>
  );
}

export function RepeatIcon({
  mode,
  className = "w-[18px] h-[18px]",
}: { mode: "off" | "all" | "one" } & IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden>
      {/* bi-arrow-repeat — arrowheads + chasing loop */}
      <path d="M11.534 7h3.932a.25.25 0 0 1 .192.41l-1.966 2.36a.25.25 0 0 1-.384 0l-1.966-2.36a.25.25 0 0 1 .192-.41m-11 2h3.932a.25.25 0 0 0 .192-.41L2.692 6.23a.25.25 0 0 0-.384 0L.342 8.59A.25.25 0 0 0 .534 9" />
      <path
        d="M8 3c-1.552 0-2.94.707-3.857 1.818a.5.5 0 1 1-.771-.636A6.002 6.002 0 0 1 13.917 7H12.9A5 5 0 0 0 8 3M3.1 9a5.002 5.002 0 0 0 8.757 2.182.5.5 0 1 1 .771.636A6.002 6.002 0 0 1 2.083 9z"
        fillRule="evenodd"
      />
      {/* "1" badge — repeat one */}
      <path
        d="M6.9 7l1.7-1.2v5.1"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={1}
        strokeDasharray={1}
        strokeDashoffset={mode === "one" ? 0 : 1}
        className="flow-dash"
      />
    </svg>
  );
}
