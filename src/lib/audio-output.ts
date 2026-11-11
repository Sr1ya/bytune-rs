/**
 * "The active output disappeared" detection — pure snapshot + decision.
 *
 * Chromium re-routes a playing <audio> to the new Windows default endpoint
 * all by itself, which is why unplugging a headset (or a Bluetooth link
 * dropping) made playback fall back to the PC speakers instead of pausing.
 * The OS pushes no "device removed" event into the page; what it does give
 * us is `devicechange` plus enumeration, and Chromium models the Windows
 * default output as a virtual `default` entry whose `groupId` is shared
 * with the physical device backing it. That yields a name-free, vendor-free
 * definition of "the output the listener was hearing":
 *
 *   snapshot — the `default` entry's groupId is the device sound is actually
 *              going to; every physical output entry's groupId is a device
 *              that is still connected.
 *   decision — pause only if the previous default's groupId is gone from the
 *              physical list while playing. Exactly the right line between
 *              the two worlds that must not be confused:
 *                · active headset removed / BT dropped     → gone → pause
 *                · intentional switch A→B (both alive)     → A still there → play on
 *                · new device connect steals the default   → old one alive → play on
 *                · unrelated second headset / mic removed  → default alive → play on
 *
 * The wiring in audio.ts listens to `devicechange` and re-enumerates —
 * event-driven, no polling, no timers. If groups are invisible (permissions
 * stripped in an exotic embed), the decision degrades to "never pause": a
 * silent no-op, never a false pause.
 */

export interface OutputSnapshot {
  /** groupId backing the Windows default output (null when invisible). */
  defaultGroup: string | null;
  /**
   * groupId of the output the listener has actually chosen: the selected
   * sink's group when a specific device is set, else the default output's
   * group (null when invisible).
   */
  selectedGroup: string | null;
  /** groupIds of all physical output endpoints currently enumerated. */
  physicalGroups: string[];
}

/** Structural slice of MediaDeviceInfo, so tests need no DOM. */
interface DeviceInfoLike {
  kind: string;
  deviceId: string;
  groupId: string;
  label?: string;
}

/**
 * One pickable output for the settings UI. The system default is deviceId ""
 * (what `setSinkId("")` means); physical entries keep their real sink id so
 * the audio engine can route to them directly.
 */
export interface OutputDeviceChoice {
  deviceId: string;
  label: string;
  isDefault: boolean;
  /** true for the physical endpoint the OS is currently routing "default" to */
  activeDefault?: boolean;
}

export function snapshotOutputs(devices: readonly DeviceInfoLike[], selectedSinkId = ""): OutputSnapshot {
  let defaultGroup: string | null = null;
  let selectedGroup: string | null = null;
  const physicalGroups: string[] = [];
  for (const d of devices) {
    if (d.kind !== "audiooutput") continue;
    // `default` and `communications` are virtual entries pointing at a
    // physical device; the physical endpoint itself is what marks "alive".
    if (d.deviceId === "default") {
      defaultGroup = d.groupId || null;
    } else if (d.deviceId !== "communications" && d.groupId && !physicalGroups.includes(d.groupId)) {
      physicalGroups.push(d.groupId);
    }
    if (selectedSinkId && d.deviceId === selectedSinkId) selectedGroup = d.groupId || null;
  }
  return { defaultGroup, selectedGroup: selectedSinkId ? selectedGroup : defaultGroup, physicalGroups };
}

export type OutputChangeAction = "pause" | "none";

/**
 * Whether an enumeration change means the output the listener was hearing
 * vanished. `playing` gates it: a vanished default while paused is just a
 * snapshot refresh, and pausing an already-paused player is meaningless.
 * "The output the listener was hearing" is the SELECTED sink when the user
 * routed playback to a specific device, else the system default.
 */
export function outputChangeAction(
  prev: OutputSnapshot | null,
  next: OutputSnapshot,
  playing: boolean,
  selectedSinkId = "",
): OutputChangeAction {
  if (!playing || !prev) return "none";
  const heard = selectedSinkId ? prev.selectedGroup : prev.defaultGroup;
  if (!heard) return "none";
  return next.physicalGroups.includes(heard) ? "none" : "pause";
}

/**
 * The pickable output list for the settings menu: "System default" first,
 * then every physical output endpoint. Chromium hides device labels until
 * the page has been granted capture permission once, so unlabeled entries
 * degrade to "Speaker N" instead of blocking the picker. The physical
 * endpoint the OS currently routes "default" to is flagged `activeDefault`
 * so the UI can show where "System default" actually leads right now.
 */
export function deviceChoices(devices: readonly DeviceInfoLike[]): OutputDeviceChoice[] {
  let defaultGroup: string | null = null;
  for (const d of devices) {
    if (d.kind === "audiooutput" && d.deviceId === "default") {
      defaultGroup = d.groupId || null;
      break;
    }
  }
  const choices: OutputDeviceChoice[] = [
    { deviceId: "", label: "System default", isDefault: true, activeDefault: true },
  ];
  const seen = new Set<string>();
  let unnamed = 0;
  for (const d of devices) {
    if (d.kind !== "audiooutput") continue;
    if (d.deviceId === "default" || d.deviceId === "communications" || !d.deviceId) continue;
    const dedupeKey = d.groupId || d.deviceId;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const label = d.label?.trim();
    choices.push({
      deviceId: d.deviceId,
      label: label || `Speaker ${++unnamed}`,
      isDefault: false,
      activeDefault: defaultGroup !== null && d.groupId === defaultGroup,
    });
  }
  return choices;
}
