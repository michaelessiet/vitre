/** Imported activity records remain readable, but their provider requests are historical. */
export function historicalActivityIds(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const activity of activities) {
    if (activity.kind !== "thread.history.imported") continue;
    const payload = activity.payload;
    if (payload === null || typeof payload !== "object" || !("historicalActivityIds" in payload))
      continue;
    if (!Array.isArray(payload.historicalActivityIds)) continue;
    for (const id of payload.historicalActivityIds) {
      if (typeof id === "string") ids.add(id);
    }
  }
  return ids;
}
