/**
 * One search per query and filter for a minute, shared by the Search page and
 * the top bar's typeahead: typing on the Search page asks both for the same
 * page. A failed search is forgotten, so the next ask tries again.
 */
import type { ByTuneApi } from "../shared/api";

type Page = Awaited<ReturnType<ByTuneApi["searchPage"]>>;

const KEEP_MS = 60_000;
const KEEP_MAX = 40;
const recent = new Map<string, { at: number; page: Promise<Page> }>();

export function searchPageOnce(query: string, filter: string): Promise<Page> {
  const api = window.bytune;
  if (!api) return Promise.reject(new Error("ByTune bridge unavailable"));
  const key = `${filter}:${query.toLowerCase()}`;
  const hit = recent.get(key);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.page;
  const page = api.searchPage(query, filter);
  recent.delete(key);
  recent.set(key, { at: Date.now(), page });
  page.catch(() => {
    if (recent.get(key)?.page === page) recent.delete(key);
  });
  const oldest = recent.keys().next().value;
  if (recent.size > KEEP_MAX && oldest !== undefined) recent.delete(oldest);
  return page;
}
