/**
 * SpotifyIcons — the play-bar icon geometry, extracted VERBATIM from the
 * live Spotify web player's DOM (Encore icons, 16-box, currentColor; the
 * fullscreen glyph ships as fill="none"). Do not substitute these paths.
 */

type IconProps = { className?: string };

function Svg({ className = "w-4 h-4", children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden>
      {children}
    </svg>
  );
}

/* data-testid="track" — the small note on the cover placeholder (24-box). */
export function SpCoverNote({ className = "w-5 h-5" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M15 4v12.167a3.5 3.5 0 1 1-3.5-3.5H13V4zm-2 10.667h-1.5a1.5 1.5 0 1 0 1.5 1.5z" />
    </svg>
  );
}

export function SpShuffle({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M13.151.922a.75.75 0 1 0-1.06 1.06L13.109 3H11.16a3.75 3.75 0 0 0-2.873 1.34l-6.173 7.356A2.25 2.25 0 0 1 .39 12.5H0V14h.391a3.75 3.75 0 0 0 2.873-1.34l6.173-7.356a2.25 2.25 0 0 1 1.724-.804h1.947l-1.017 1.018a.75.75 0 0 0 1.06 1.06L15.98 3.75zM.391 3.5H0V2h.391c1.109 0 2.16.49 2.873 1.34L4.89 5.277l-.979 1.167-1.796-2.14A2.25 2.25 0 0 0 .39 3.5z" />
      <path d="m7.5 10.723.98-1.167.957 1.14a2.25 2.25 0 0 0 1.724.804h1.947l-1.017-1.018a.75.75 0 1 1 1.06-1.06l2.829 2.828-2.829 2.828a.75.75 0 1 1-1.06-1.06L13.109 13H11.16a3.75 3.75 0 0 1-2.873-1.34l-.787-.938z" />
    </Svg>
  );
}

export function SpPrev({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M3.3 1a.7.7 0 0 1 .7.7v5.15l9.95-5.744a.7.7 0 0 1 1.05.606v12.575a.7.7 0 0 1-1.05.607L4 9.149V14.3a.7.7 0 0 1-.7.7H1.7a.7.7 0 0 1-.7-.7V1.7a.7.7 0 0 1 .7-.7z" />
    </Svg>
  );
}

export function SpPlay({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M3 1.713a.7.7 0 0 1 1.05-.607l10.89 6.288a.7.7 0 0 1 0 1.212L4.05 14.894A.7.7 0 0 1 3 14.288z" />
    </Svg>
  );
}

export function SpPause({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M2.7 1a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7zm8 0a.7.7 0 0 0-.7.7v12.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7z" />
    </Svg>
  );
}

export function SpNext({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M12.7 1a.7.7 0 0 0-.7.7v5.15L2.05 1.107A.7.7 0 0 0 1 1.712v12.575a.7.7 0 0 0 1.05.607L12 9.149V14.3a.7.7 0 0 0 .7.7h1.6a.7.7 0 0 0 .7-.7V1.7a.7.7 0 0 0-.7-.7z" />
    </Svg>
  );
}

export function SpRepeat({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M0 4.75A3.75 3.75 0 0 1 3.75 1h8.5A3.75 3.75 0 0 1 16 4.75v5a3.75 3.75 0 0 1-3.75 3.75H9.81l1.018 1.018a.75.75 0 1 1-1.06 1.06L6.939 12.75l2.829-2.828a.75.75 0 1 1 1.06 1.06L9.811 12h2.439a2.25 2.25 0 0 0 2.25-2.25v-5a2.25 2.25 0 0 0-2.25-2.25h-8.5A2.25 2.25 0 0 0 1.5 4.75v5A2.25 2.25 0 0 0 3.75 12H5v1.5H3.75A3.75 3.75 0 0 1 0 9.75z" />
    </Svg>
  );
}

/* Spotify's repeat-one glyph — shortened loop + built-in "1". */
export function SpRepeatOne({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M0 4.75A3.75 3.75 0 0 1 3.75 1h.75v1.5h-.75A2.25 2.25 0 0 0 1.5 4.75v5A2.25 2.25 0 0 0 3.75 12H5v1.5H3.75A3.75 3.75 0 0 1 0 9.75zM12.25 2.5a2.25 2.25 0 0 1 2.25 2.25v5A2.25 2.25 0 0 1 12.25 12H9.81l1.018-1.018a.75.75 0 0 0-1.06-1.06L6.939 12.75l2.829 2.828a.75.75 0 1 0 1.06-1.06L9.811 13.5h2.439A3.75 3.75 0 0 0 16 9.75v-5A3.75 3.75 0 0 0 12.25 1h-.75v1.5z" />
      <path d="m8 1.85.77.694H6.095V1.488q1.046-.077 1.507-.385.474-.308.583-.913h1.32V8H8z" />
      <path d="M8.77 2.544 8 1.85v.693z" />
    </Svg>
  );
}

export function SpLyrics({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M13.426 2.574a2.831 2.831 0 0 0-4.797 1.55l3.247 3.247a2.831 2.831 0 0 0 1.55-4.797M10.5 8.118l-2.619-2.62L4.74 9.075 2.065 12.12a1.287 1.287 0 0 0 1.816 1.816l3.06-2.688 3.56-3.129zM7.12 4.094a4.331 4.331 0 1 1 4.786 4.786l-3.974 3.493-3.06 2.689a2.787 2.787 0 0 1-3.933-3.933l2.676-3.045z" />
    </Svg>
  );
}

export function SpQueue({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M15 15H1v-1.5h14zm0-4.5H1V9h14zm-14-7A2.5 2.5 0 0 1 3.5 1h9a2.5 2.5 0 0 1 0 5h-9A2.5 2.5 0 0 1 1 3.5m2.5-1a1 1 0 0 0 0 2h9a1 1 0 1 0 0-2z" />
    </Svg>
  );
}

export function SpVolumeHigh({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M9.741.85a.75.75 0 0 1 .375.65v13a.75.75 0 0 1-1.125.65l-6.925-4a3.64 3.64 0 0 1-1.33-4.967 3.64 3.64 0 0 1 1.33-1.332l6.925-4a.75.75 0 0 1 .75 0zm-6.924 5.3a2.14 2.14 0 0 0 0 3.7l5.8 3.35V2.8zm8.683 4.29V5.56a2.75 2.75 0 0 1 0 4.88" />
      <path d="M11.5 13.614a5.752 5.752 0 0 0 0-11.228v1.55a4.252 4.252 0 0 1 0 8.127z" />
    </Svg>
  );
}

export function SpVolumeOff({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M13.86 5.47a.75.75 0 0 0-1.061 0l-1.47 1.47-1.47-1.47A.75.75 0 0 0 8.8 6.53L10.269 8l-1.47 1.47a.75.75 0 1 0 1.06 1.06l1.47-1.47 1.47 1.47a.75.75 0 0 0 1.06-1.06L12.39 8l1.47-1.47a.75.75 0 0 0 0-1.06" />
      <path d="M10.116 1.5A.75.75 0 0 0 8.991.85l-6.925 4a3.64 3.64 0 0 0-1.33 4.967 3.64 3.64 0 0 0 1.33 1.332l6.925 4a.75.75 0 0 0 1.125-.649v-1.906a4.7 4.7 0 0 1-1.5-.694v1.3L2.817 9.852a2.14 2.14 0 0 1-.781-2.92c.187-.324.456-.594.78-.782l5.8-3.35v1.3c.45-.313.956-.55 1.5-.694z" />
    </Svg>
  );
}

export function SpMiniplayer({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M16 2.45c0-.8-.65-1.45-1.45-1.45H1.45C.65 1 0 1.65 0 2.45v11.1C0 14.35.65 15 1.45 15h5.557v-1.5H1.5v-11h13V7H16z" />
      <path d="M15.25 9.007a.75.75 0 0 1 .75.75v4.493a.75.75 0 0 1-.75.75H9.325a.75.75 0 0 1-.75-.75V9.757a.75.75 0 0 1 .75-.75z" />
    </Svg>
  );
}

export function SpFullscreen({ className = "w-4 h-4" }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" aria-hidden>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M0.25 3C0.25 2.0335 1.0335 1.25 2 1.25H5.375V2.75H2C1.86193 2.75 1.75 2.86193 1.75 3V5.42857H0.25V3ZM14 2.75H10.625V1.25H14C14.9665 1.25 15.75 2.0335 15.75 3V5.42857H14.25V3C14.25 2.86193 14.1381 2.75 14 2.75ZM1.75 10.5714V13C1.75 13.1381 1.86193 13.25 2 13.25H5.375V14.75H2C1.0335 14.75 0.25 13.9665 0.25 13V10.5714H1.75ZM14.25 13V10.5714H15.75V13C15.75 13.9665 14.9665 14.75 14 14.75H10.625V13.25H14C14.1381 13.25 14.25 13.1381 14.25 13Z"
        fill="currentColor"
      />
    </svg>
  );
}

/* Exit-fullscreen glyph — extracted VERBATIM from the live Spotify web-player
   bundle (encore~web-player / web-player.cb5c9531.js): svg 16-box, a single
   evenodd path, fill currentColor. Four brackets whose elbows face the centre.
   Rendered 16px in a 32px button — exactly as Spotify's play bar does. */
export function SpExitFullscreen({ className = "w-4 h-4" }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" aria-hidden>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12.12 1.25V3.67857C12.12 3.81664 12.2319 3.92857 12.37 3.92857H15.75V5.42857H12.37C11.4035 5.42857 10.62 4.64507 10.62 3.67857V1.25H12.12ZM3.87998 3.67895V1.279H5.37998V3.67895C5.37998 4.64545 4.59648 5.42895 3.62998 5.42895H0.26998V3.92895H3.62998C3.76805 3.92895 3.87998 3.81702 3.87998 3.67895ZM10.62 12.2785C10.62 11.3116 11.4039 10.529 12.37 10.529H15.75V12.029H12.37C12.2315 12.029 12.12 12.1409 12.12 12.2785V14.739H10.62V12.2785ZM3.63091 12.0603H0.25V10.5603H3.63091C4.5983 10.5603 5.38 11.3447 5.38 12.3103V14.7389H3.88V12.3103C3.88 12.1714 3.76809 12.0603 3.63091 12.0603Z"
        fill="currentColor"
      />
    </svg>
  );
}

/* data-testid = "add-button" — circled plus. */
export function SpPlus({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path d="M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8" />
      <path d="M11.75 8a.75.75 0 0 1-.75.75H8.75V11a.75.75 0 0 1-1.5 0V8.75H5a.75.75 0 0 1 0-1.5h2.25V5a.75.75 0 0 1 1.5 0v2.25H11a.75.75 0 0 1 .75.75" />
    </Svg>
  );
}

/* Share — tray with an upward arrow (Spotify's miniplayer share glyph style). */
export function SpShare({ className = "w-4 h-4" }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="none" aria-hidden>
      <path
        d="M8 1.5v8M5.25 3.75 8 1l2.75 2.75M2.5 6.5v6a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* Added state — filled circle with check cutout (Spotify check-circle). */
export function SpCheck({ className }: IconProps) {
  return (
    <Svg className={className}>
      <path
        fillRule="evenodd"
        d="M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0zm3.71 5.29a1 1 0 0 0-1.41 0L7.25 8.34 5.71 6.79a1 1 0 0 0-1.41 1.41l2.25 2.25a1 1 0 0 0 1.41 0l3.75-3.75a1 1 0 0 0 0-1.41z"
      />
    </Svg>
  );
}
