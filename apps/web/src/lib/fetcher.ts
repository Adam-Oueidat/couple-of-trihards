/**
 * The one fetcher every SWR hook in the app shares.
 *
 * Throwing on a non-2xx matters: SWR treats a resolved promise as success, so a
 * fetcher that returned the parsed body of a 401 would populate `data` with an
 * error payload and leave `error` undefined. Callers distinguish "no data yet"
 * from "the request failed" purely on those two fields.
 */
export async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}
