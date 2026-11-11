/** Typed access to the preload bridge, with a friendly error in plain-browser dev. */
import type { ByTuneApi } from "../shared/api";

declare global {
  interface Window {
    bytune?: ByTuneApi;
  }
}

export function hasBridge(): boolean {
  return typeof window !== "undefined" && !!window.bytune;
}

export function requireBridge(): ByTuneApi {
  if (typeof window === "undefined" || !window.bytune) {
    throw new Error("Not running inside the ByTune desktop shell.");
  }
  return window.bytune;
}
