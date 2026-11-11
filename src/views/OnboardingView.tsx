/**
 * First-run onboarding. Three ways in: a username and password account (Supabase-backed, no email
 * involved), Google through the default browser, or guest mode (fully offline; the library stays
 * in this computer's app-data folder and survives an uninstall). It also asks a reinstalled guest
 * whether to carry on, and asks a fresh Google account for a username, once.
 *
 * Composition: ByTune's own look, a page lit by the music. On the right, a drum of covers in 3D
 * (components/CoverDrum) that turns and can be spun or rolled; the cover in focus lights the page.
 * On the left, on the dark side, the brand and one step at a time. The first step says what ByTune
 * is and lists the ways in, each saying what it means and lighting up with the cover in focus as
 * the pointer reaches it. A step swaps in place (keyed, direction-aware) and turns the drum a notch.
 *
 * Loading states reflect real operations only: "Restoring your library" waits for the actual
 * cloud merge.
 */
import { useEffect, useId, useState, type ReactNode } from "react";
import { ACCOUNTS } from "../lib/features";
import { ArrowLeft, ArrowRight, Check, Cloud, Eye, EyeOff, HardDrive, KeyRound, Loader2 } from "lucide-react";
import { CaptionButtons } from "../components/TopBar";
import { CoverDrum } from "../components/CoverDrum";
import { useSession } from "../lib/session";
import { isMac } from "../lib/platform";
import {
  availabilityState,
  DISPLAY_NAME_MAX,
  displayNameProblem,
  normalizeDisplayName,
  PASSWORD_MIN,
  passwordProblem,
  usernameProblem,
  usernameTypable,
  USERNAME_MIN,
  type UsernameAvailability,
} from "../lib/account-validators";
import brandLogo from "../assets/brand/bytune-logo.svg";
import brandText from "../assets/brand/bytune-Text.svg";

type Screen = "choose" | "signup" | "signin" | "resume" | "restoring" | "pickusername" | "guestname";

/** Raw provider/engine errors to short, human, actionable messages. */
function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const msg = raw.replace(/^\[.*?\]\s*/, "");
  if (/failed to fetch|fetch failed|networkerror|network error|timeout|timed out/i.test(msg)) {
    return "Couldn't connect right now. Check your connection and try again.";
  }
  if (/invalid login credentials|wrong username or password/i.test(msg)) {
    return "That username or password doesn't match.";
  }
  if (/already registered|already exists|duplicate|username is already taken/i.test(msg)) {
    return "That username is already in use.";
  }
  if (/username_format|violates check constraint/i.test(msg)) {
    // The live database still runs the old username CHECK (see
    // supabase/migrations/0001-username-charset.sql).
    return "That username isn't accepted yet. Try letters and numbers.";
  }
  if (/email confirmation is enabled/i.test(msg)) {
    return "Sign-up is temporarily unavailable. Please try again later.";
  }
  if (/at least \d+ characters|letters, numbers/i.test(msg)) return msg;
  return "Something went wrong. Please try again.";
}

/* ------------------------------------------------------------------ */
/* Shared pieces                                                       */
/* ------------------------------------------------------------------ */

function GoogleG({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 18 18" className={className} aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.32A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.28-1.72V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.04l3.01-2.32Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.96l3 2.32C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}

function Spinner() {
  return <Loader2 className="w-4 h-4 animate-spin" />;
}

function ErrorNote({ msg }: { msg: string | null }) {
  if (!msg) return null;
  return (
    <p role="alert" className="ob-error">
      {msg}
    </p>
  );
}

/** Buttons: the app's own pills (a collection page's Play is the same white one). */
const btnPrimary = "ob-btn ob-btn-primary";
const btnSecondary = "ob-btn ob-btn-secondary";
/** Quiet text actions: skip. */
const btnText = "ob-text";

/** Back to the ways in, above a step's title. */
function BackLink({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="ob-back-link">
      <ArrowLeft className="w-4 h-4" /> Back
    </button>
  );
}

/** A step's title, and the line under it. */
function Title({ children, lede }: { children: ReactNode; lede?: ReactNode }) {
  return (
    <header className="ob-head">
      <h2 className="ob-title">{children}</h2>
      {lede && <p className="ob-lede">{lede}</p>}
    </header>
  );
}

/**
 * A text field that keeps its words inside the box: the label sits in it and moves up out of the
 * way once there's text or focus; while it's focused and empty, a hint on the typing line says
 * what goes in; and what's known about the text (available, taken, too long) sits on the top
 * line, opposite the label.
 */
function Field({
  label,
  hint,
  status,
  tone,
  trailing,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  status?: ReactNode;
  tone?: "good" | "warn";
  trailing?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="ob-field">
      <input
        {...props}
        id={id}
        placeholder={hint ?? " "}
        aria-label={label}
        aria-describedby={`${id}s`}
        className={trailing ? "ob-input ob-trail" : "ob-input"}
      />
      <label htmlFor={id} className="ob-label">
        {label}
      </label>
      {/* Always there, so a change is announced. */}
      <span id={`${id}s`} aria-live="polite" className={`ob-field-status${tone ? ` is-${tone}` : ""}`}>
        {status}
      </span>
      {trailing}
    </div>
  );
}

/** A password field with a reveal toggle: a desktop app never makes you type a long password blind. */
function PasswordField(props: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const [show, setShow] = useState(false);
  return (
    <Field
      {...props}
      type={show ? "text" : "password"}
      trailing={
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          aria-label={show ? "Hide password" : "Show password"}
          className="ob-reveal"
        >
          {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      }
    />
  );
}

/* ------------------------------------------------------------------ */
/* Username availability                                               */
/* ------------------------------------------------------------------ */

/**
 * Debounced live availability for a well-formed username. Clearing the timer
 * doesn't cancel a request already in flight, so a slow answer for an earlier
 * name must never overwrite the current one's verdict (stale-guard). A failed
 * lookup reads as "unknown": the form stays submittable and the database
 * UNIQUE constraint decides for real at sign-up.
 */
function useUsernameAvailability(username: string, active: boolean): UsernameAvailability {
  const [state, setState] = useState<UsernameAvailability>("idle");
  useEffect(() => {
    if (!active) {
      setState("idle");
      return;
    }
    let stale = false;
    setState("checking");
    const t = setTimeout(async () => {
      try {
        const res = (await window.bytune?.authUsernameAvailable(username.trim())) as
          | { available: boolean | null; reason?: string }
          | undefined;
        if (!stale) setState(availabilityState(res?.available));
      } catch {
        if (!stale) setState("unknown");
      }
    }, 450);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [username, active]);
  return state;
}

/** What the username field knows about its text, for the box's top line. A rule still unmet while
    typing is said quietly; only a taken name is a warning. */
function usernameStatus(
  state: UsernameAvailability,
  formatProblem: string | null
): { status?: ReactNode; tone?: "good" | "warn" } {
  if (formatProblem) {
    const n = /at (least|most) (\d+)/.exec(formatProblem);
    return { status: n ? `${n[1] === "least" ? "At least" : "Up to"} ${n[2]} characters` : "Letters, numbers, _ and @ only" };
  }
  if (state === "checking") {
    return {
      status: (
        <>
          <Loader2 className="w-3 h-3 animate-spin" /> Checking
        </>
      ),
    };
  }
  if (state === "free") {
    return {
      status: (
        <>
          <Check className="w-3.5 h-3.5" /> Available
        </>
      ),
      tone: "good",
    };
  }
  if (state === "taken") return { status: "Taken", tone: "warn" };
  if (state === "unknown") return { status: "Couldn't check, you can still continue" };
  return {};
}

/** The display name field: what it's for while focused, and on its top line when it's too long. */
function DisplayNameField({
  value,
  onChange,
  hint,
  autoFocus,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  hint: string;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  const tooLong = [...normalizeDisplayName(value)].length > DISPLAY_NAME_MAX;
  return (
    <Field
      label="Display name"
      hint={hint}
      status={tooLong ? `Up to ${DISPLAY_NAME_MAX} characters` : undefined}
      tone={tooLong ? "warn" : undefined}
      autoFocus={autoFocus}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      autoComplete="name"
      disabled={disabled}
    />
  );
}

/** A guest's own name, or one carried from the guest who is now creating an account. */
function startingName(): string {
  const s = useSession.getState();
  return s.suggestedDisplayName ?? (s.mode === "guest" ? s.displayName : null) ?? "";
}

/* ------------------------------------------------------------------ */
/* Step: username + password form (sign up / sign in)                  */
/* ------------------------------------------------------------------ */

function UsernamePasswordForm({
  mode,
  onBack,
  navigate,
}: {
  mode: "signup" | "signin";
  onBack: () => void;
  navigate: (s: Screen) => void;
}) {
  const [displayName, setDisplayName] = useState(startingName);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const formatProblem = mode === "signup" && username.length > 0 ? usernameProblem(username) : null;
  const availability = useUsernameAvailability(
    username,
    mode === "signup" && !formatProblem && username.trim().length >= USERNAME_MIN
  );
  const nameProblem = mode === "signup" ? displayNameProblem(displayName) : null;

  const canSubmit =
    username.trim().length >= USERNAME_MIN &&
    password.length > 0 &&
    (mode === "signin" || (confirm.length > 0 && availability !== "taken" && !formatProblem && !nameProblem)) &&
    !busy;

  const google = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const info = (await window.bytune?.authSignInGoogle()) as { needsUsername?: boolean } | undefined;
      if (info?.needsUsername) {
        navigate("pickusername");
        return;
      }
      await window.bytune?.syncNow().catch(() => undefined);
      navigate("restoring");
      await useSession.getState().refresh();
    } catch (err) {
      setError(friendlyError(err));
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy) return;
    if (mode === "signup") {
      const pwProblem = passwordProblem(password);
      if (pwProblem) {
        setError(pwProblem);
        return;
      }
      if (password !== confirm) {
        setError("Passwords don't match.");
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const info = (await (mode === "signup"
        ? window.bytune?.authSignUp(username.trim(), password, displayName)
        : window.bytune?.authSignIn(username.trim(), password))) as { needsUsername?: boolean } | undefined;
      if (info?.needsUsername) {
        navigate("pickusername");
        return;
      }
      // Real work: pull/merge the account's cloud data before entry.
      navigate("restoring");
      await window.bytune?.syncNow().catch(() => undefined);
      await useSession.getState().refresh();
    } catch (err) {
      setError(friendlyError(err));
      setBusy(false);
    }
  };

  const signup = mode === "signup";
  return (
    <form onSubmit={(e) => void submit(e)}>
      <BackLink onClick={onBack} disabled={busy} />
      <Title lede={signup ? "No email needed, but a lost password can't be reset." : undefined}>
        {signup ? "Create your account" : "Sign in"}
      </Title>
      <div className="ob-fields">
        {signup && (
          <DisplayNameField value={displayName} onChange={setDisplayName} hint="What people see" autoFocus disabled={busy} />
        )}
        <Field
          label="Username"
          hint={signup ? "For signing in. Letters, numbers, _ and @" : undefined}
          {...(signup ? usernameStatus(availability, formatProblem) : {})}
          autoFocus={!signup}
          value={username}
          onChange={(e) => setUsername(usernameTypable(e.target.value))}
          autoComplete="username"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={busy}
        />
        <PasswordField
          label="Password"
          hint={signup ? `At least ${PASSWORD_MIN} characters` : undefined}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={signup ? "new-password" : "current-password"}
          disabled={busy}
        />
        {signup && (
          <PasswordField
            label="Confirm password"
            hint="The same password again"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            disabled={busy}
          />
        )}
      </div>
      <ErrorNote msg={error} />
      <div className="ob-actions">
        <button type="submit" disabled={!canSubmit} className={btnPrimary}>
          {busy ? (
            <>
              <Spinner /> {signup ? "Creating account…" : "Signing in…"}
            </>
          ) : signup ? (
            "Create account"
          ) : (
            "Sign in"
          )}
        </button>
        <button type="button" onClick={() => void google()} className={btnSecondary} disabled={busy}>
          {busy ? <Spinner /> : <GoogleG className="w-[18px] h-[18px]" />} Continue with Google
        </button>
      </div>
      <p className="ob-switch">
        {signup ? "Already have an account? " : "New to ByTune? "}
        <button type="button" onClick={() => navigate(signup ? "signin" : "signup")} className="ob-link" disabled={busy}>
          {signup ? "Sign in" : "Create an account"}
        </button>
      </p>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Step: the ways in                                                   */
/* ------------------------------------------------------------------ */

/**
 * One way in, as a row: what it is and what it means. The row's name is its title alone; the
 * line under it describes it. It lights up with the cover in focus on the drum (index.css, .ob-way).
 */
function Way({
  icon,
  title,
  note,
  main,
  busy,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  note: string;
  /** The way ByTune suggests: its tile is the one white thing in the list. */
  main?: boolean;
  /** This way is under way: it stays bright while the others wait. */
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const id = useId();
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-labelledby={`${id}t`}
        aria-describedby={`${id}n`}
        className={`ob-way${busy ? " is-busy" : ""}`}
      >
        <span className={`ob-way-icon${main ? " is-main" : ""}`} aria-hidden>
          {icon}
        </span>
        <span className="ob-way-text">
          <span id={`${id}t`} className="ob-way-title">
            {title}
          </span>
          <span id={`${id}n`} className="ob-way-note">
            {note}
          </span>
        </span>
        <ArrowRight className="ob-way-go w-4 h-4" aria-hidden />
      </button>
    </li>
  );
}

function ChooseContent({
  onPick,
  navigate,
}: {
  onPick: (screen: "signup" | "signin") => void;
  navigate: (s: Screen) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"none" | "google">("none");

  const google = async (): Promise<void> => {
    if (busy !== "none") return;
    setBusy("google");
    setError(null);
    try {
      const info = (await window.bytune?.authSignInGoogle()) as { needsUsername?: boolean } | undefined;
      if (info?.needsUsername) {
        // Fresh Google user: one-time username choice before entry.
        navigate("pickusername");
        return;
      }
      // Resolves when the browser round-trip lands (or errors out).
      await window.bytune?.syncNow().catch(() => undefined);
      await useSession.getState().refresh();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy("none");
    }
  };

  const off = busy !== "none";
  const icon = "w-[18px] h-[18px]";
  return (
    <div>
      {/* Two lines that rise out of their own masks; the text stays one heading for screen readers. */}
      <h2 className="ob-hero">
        <span className="ob-line">
          <span>Stream what's new.</span>
        </span>{" "}
        <span className="ob-line ob-line-dim" style={{ ["--d" as string]: "90ms" }}>
          <span>Play what's yours.</span>
        </span>
      </h2>
      <p className="ob-lede ob-hero-lede">One library for both. Free and open source.</p>
      <ul className="ob-ways">
        {ACCOUNTS && (<>
        <Way
          main
          icon={<Cloud className={icon} />}
          title="Create an account"
          note="Keeps your library in sync on every computer"
          onClick={() => onPick("signup")}
          disabled={off}
        />
        <Way
          icon={busy === "google" ? <Spinner /> : <GoogleG className={icon} />}
          title="Continue with Google"
          note={busy === "google" ? "Finish in your browser" : "Sign in or sign up through your browser"}
          onClick={() => void google()}
          busy={busy === "google"}
          disabled={off}
        />
        <Way
          icon={<KeyRound className={icon} />}
          title="Sign in"
          note="With your ByTune username and password"
          onClick={() => onPick("signin")}
          disabled={off}
        />
        </>)}
        <Way
          icon={<HardDrive className={icon} />}
          title="Continue as guest"
          note="Everything stays on this computer"
          onClick={() => navigate("guestname")}
          disabled={off}
        />
      </ul>
      <ErrorNote msg={error} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step: guest name (optional, before entering as a guest)             */
/* ------------------------------------------------------------------ */

function GuestNameContent({ onBack }: { onBack: () => void }) {
  const [name, setName] = useState(startingName);
  const [busy, setBusy] = useState<"none" | "name" | "skip">("none");
  const [error, setError] = useState<string | null>(null);
  const problem = displayNameProblem(name);

  const enter = async (withName: boolean): Promise<void> => {
    if (busy !== "none" || (withName && problem)) return;
    setBusy(withName ? "name" : "skip");
    setError(null);
    try {
      await window.bytune?.authContinueGuest(withName ? name : undefined);
      await useSession.getState().refresh();
    } catch (err) {
      setError(friendlyError(err));
      setBusy("none");
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void enter(true);
      }}
    >
      <BackLink onClick={onBack} disabled={busy !== "none"} />
      <Title lede="Everything stays on this computer. It isn't backed up.">What should we call you?</Title>
      <DisplayNameField value={name} onChange={setName} hint="Shown around ByTune" autoFocus disabled={busy !== "none"} />
      <ErrorNote msg={error} />
      <div className="ob-actions">
        <button type="submit" disabled={busy !== "none" || !!problem} className={btnPrimary}>
          {busy === "name" ? (
            <>
              <Spinner /> Starting…
            </>
          ) : (
            "Continue"
          )}
        </button>
      </div>
      <div className="ob-foot">
        <button type="button" onClick={() => void enter(false)} className={btnText} disabled={busy !== "none"}>
          {busy === "skip" ? (
            <>
              <Spinner /> Starting…
            </>
          ) : (
            "Skip for now"
          )}
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Step: guest resume (after a reinstall)                              */
/* ------------------------------------------------------------------ */

function ResumeContent({ onSignInInstead }: { onSignInInstead: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <Title lede="We found it on this computer, from an earlier install.">Your guest library is still here</Title>
      <div className="ob-actions">
        <button
          disabled={busy}
          onClick={async () => {
            if (busy) return;
            setBusy(true);
            setError(null);
            try {
              await window.bytune?.authContinueGuest();
              await useSession.getState().refresh();
            } catch (err) {
              setError(friendlyError(err));
              setBusy(false);
            }
          }}
          className={btnPrimary}
        >
          {busy ? (
            <>
              <Spinner /> Starting…
            </>
          ) : (
            "Continue as guest"
          )}
        </button>
        <button disabled={busy} onClick={onSignInInstead} className={btnSecondary}>
          Sign in with an account instead
        </button>
      </div>
      <p className="ob-aside">Signing in later carries it over. Nothing is deleted.</p>
      <ErrorNote msg={error} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step: restoring (real state, shown while the cloud merge runs)      */
/* ------------------------------------------------------------------ */

function RestoringContent() {
  return (
    <div>
      <Title lede="Your playlists, likes and history are coming back from your account.">Restoring your library</Title>
      <p className="ob-status">
        <Loader2 className="w-4 h-4 animate-spin" /> Syncing
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step: pick a username (one time, for fresh Google sign-ins)         */
/* ------------------------------------------------------------------ */

function PickUsernameContent() {
  // The name on their Google account (or the guest's own), ready to keep.
  const [displayName, setDisplayName] = useState(startingName);
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const formatProblem = username.length > 0 ? usernameProblem(username) : null;
  const availability = useUsernameAvailability(username, !formatProblem && username.trim().length >= USERNAME_MIN);
  const nameProblem = displayNameProblem(displayName);

  const save = async (): Promise<void> => {
    if (busy || availability === "taken" || formatProblem || nameProblem) return;
    setBusy(true);
    setError(null);
    try {
      await window.bytune?.authSetUsername(username.trim(), displayName);
      // Username claimed: now pull/merge the account and enter.
      await window.bytune?.syncNow().catch(() => undefined);
      await useSession.getState().refresh();
    } catch (err) {
      setError(friendlyError(err));
      setBusy(false);
    }
  };

  // Offline-safe escape: keep the auto-generated name (changeable later in
  // Settings) rather than trapping the user without network.
  const skip = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.bytune?.authSkipUsername(displayName);
      await window.bytune?.syncNow().catch(() => undefined);
      await useSession.getState().refresh();
    } catch (err) {
      setError(friendlyError(err));
      setBusy(false);
    }
  };

  return (
    <div>
      <Title lede="It's how you sign in. You can change it later.">Choose a username</Title>
      <div className="ob-fields">
        <DisplayNameField value={displayName} onChange={setDisplayName} hint="What people see in rooms" disabled={busy} />
        <Field
          label="Username"
          hint="Letters, numbers, _ and @"
          {...usernameStatus(availability, formatProblem)}
          autoFocus
          value={username}
          onChange={(e) => setUsername(usernameTypable(e.target.value))}
          autoComplete="username"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={busy}
        />
      </div>
      <ErrorNote msg={error} />
      <div className="ob-actions">
        <button
          onClick={() => void save()}
          disabled={busy || availability === "taken" || !!formatProblem || !!nameProblem || username.trim().length < USERNAME_MIN}
          className={btnPrimary}
        >
          {busy ? (
            <>
              <Spinner /> Saving…
            </>
          ) : (
            "Continue"
          )}
        </button>
      </div>
      <div className="ob-foot">
        <button onClick={() => void skip()} disabled={busy} className={btnText}>
          Skip for now
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

export function Onboarding({ initial }: { initial: Screen }) {
  const [screen, setScreen] = useState<Screen>(initial);
  const [dir, setDir] = useState<"fwd" | "back">("fwd");
  /** Steps taken, back steps counting down: the drum turns a notch the way each one went. */
  const [turn, setTurn] = useState(0);
  /** Until the first step, the first screen waits for the brand and the drum. */
  const [stepped, setStepped] = useState(false);
  const navigate = (s: Screen, d: "fwd" | "back" = "fwd"): void => {
    setDir(d);
    setScreen(s);
    setTurn((n) => n + (d === "back" ? -1 : 1));
    setStepped(true);
  };

  return (
    <div className="ob-root h-screen flex flex-col bg-canvas text-ink overflow-hidden select-none relative">
      <CoverDrum turn={turn} busy={screen === "restoring"} />

      {/* Frameless-window chrome: a bare drag strip with the caption buttons. macOS draws its
          traffic lights top-left over this strip, so there's nothing to render there. */}
      <div className="app-drag h-12 shrink-0 flex items-start justify-end relative z-10">
        {!isMac && <CaptionButtons />}
      </div>

      <div className="ob-scroll">
        <div className="ob-side">
          <h1 className="ob-brand" data-intro-target>
            <img src={brandLogo} alt="" aria-hidden className="ob-brand-mark" />
            <img src={brandText} alt="ByTune" className="ob-brand-word" />
          </h1>
          <main className="ob-column">
            <div
              key={screen}
              className={`ob-screen${dir === "back" ? " ob-back" : ""}`}
              style={stepped ? undefined : { ["--ob-base" as string]: "380ms" }}
            >
              {screen === "choose" && <ChooseContent onPick={(s) => navigate(s)} navigate={navigate} />}
              {screen === "signup" && (
                <UsernamePasswordForm mode="signup" onBack={() => navigate("choose", "back")} navigate={navigate} />
              )}
              {screen === "signin" && (
                <UsernamePasswordForm mode="signin" onBack={() => navigate("choose", "back")} navigate={navigate} />
              )}
              {screen === "resume" && <ResumeContent onSignInInstead={() => navigate("choose", "back")} />}
              {screen === "restoring" && <RestoringContent />}
              {screen === "pickusername" && <PickUsernameContent />}
              {screen === "guestname" && <GuestNameContent onBack={() => navigate("choose", "back")} />}
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
