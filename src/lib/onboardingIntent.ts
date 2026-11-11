/**
 * One-shot intent for which onboarding screen to open next — used by flows
 * that route INTO onboarding (e.g. the guest delete-protection modal's
 * "Sign in" / "Create account" actions). Consumed on first read so the
 * choice only applies to the immediate transition.
 */
export type OnboardingIntent = "signup" | "signin" | null;

let intent: OnboardingIntent = null;

export function setOnboardingIntent(screen: Exclude<OnboardingIntent, null>): void {
  intent = screen;
}

export function takeOnboardingIntent(): OnboardingIntent {
  const value = intent;
  intent = null;
  return value;
}
