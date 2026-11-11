/**
 * One queue for everything that touches the account's data — account switches, cloud syncs and the
 * page's own store writes (ByTune's data-transition.ts serializeData). A sync that pulls a store
 * finishes before a page write queued behind it, and a write can never land in the middle of an
 * account switch.
 *
 * Switching accounts ends with a reload. From the moment the switch commits, the page's live stores
 * still hold the previous owner's data, so their writes are dropped (`freezePageWrites`) until the
 * reload brings the new owner's data in. (ByTune routed such late writes to the previous owner's
 * archive; the page drains its pending writes before every switch, so nothing of the old owner's is
 * left to lose.)
 */
let tail: Promise<unknown> = Promise.resolve();
let frozen = false;

export function serializeData<T>(work: () => Promise<T>): Promise<T> {
  const result = tail.catch(() => undefined).then(work);
  tail = result;
  return result;
}

/** Wait for accepted work, including work appended while draining. */
export async function drainData(): Promise<void> {
  let observed: Promise<unknown>;
  do {
    observed = tail;
    await observed.catch(() => undefined);
  } while (observed !== tail);
}

export function freezePageWrites(): void {
  frozen = true;
}

export function pageWritesFrozen(): boolean {
  return frozen;
}
