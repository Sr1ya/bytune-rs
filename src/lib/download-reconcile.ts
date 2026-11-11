/**
 * Pure decision for boot-time download reconciliation (see lib/downloads.ts).
 *
 * The main process download queue is memory-only, but the renderer's registry
 * persists into the library store. After a quit/crash mid-download the
 * registry claims rows are "queued"/"downloading" that nothing will ever
 * update again — and startDownload refuses to retry while a row claims to be
 * active. Rows whose ids are absent from the live queue snapshot at boot are
 * therefore stale and must read as failed (failed stays retryable).
 */
export function staleDownloadIds(
  registry: Record<string, { status?: unknown }>,
  liveIds: Iterable<string>
): string[] {
  const live = new Set(liveIds);
  return Object.entries(registry ?? {})
    .filter(([id, item]) => {
      const status = item?.status;
      return (status === "queued" || status === "downloading") && !live.has(id);
    })
    .map(([id]) => id);
}
