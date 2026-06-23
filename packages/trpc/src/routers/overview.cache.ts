import { getRedisCache } from '@openpanel/redis';
import type { IChartRange } from '@openpanel/validation';

// Long TTL for the immutable previous comparison window. The previous period for
// a non-realtime range is a CLOSED window entirely in the past, so its
// aggregates never change once the day boundary is set. 1h balances hit-rate
// against the rare late-arriving event landing 30–60d back; the cache key
// encodes the resolved bounds, so a day-boundary rollover misses and recomputes.
export const PREVIOUS_PERIOD_TTL = 60 * 60;

// Ranges whose "previous" window is still moving relative to now() — their bounds
// change every request, so a long TTL would never hit and would only churn Redis.
// Mirrors the realtime set in overview.ts's `cacher`.
export const REALTIME_RANGES = new Set<IChartRange>([
  '30min',
  'today',
  'lastHour',
  'last24h',
]);

// Key encodes the RESOLVED previous-window bounds (carried inside previousInput),
// not the raw range string — so a rolling 30d window invalidates when the day
// boundary advances. `label` separates metric fns that share an identical
// previousInput but return different results (getMetrics vs getEventMetrics …).
// Escaping mirrors cacheMiddleware so keys stay human-readable in redis-cli.
export function previousPeriodCacheKey(label: string, previousInput: unknown) {
  return `trpc:overview.prev:${label}:${JSON.stringify(previousInput).replace(
    /"/g,
    "'",
  )}`;
}

// Read-through cache for an immutable previous-period computation. Only serves
// from cache in production (matching cacheMiddleware) so dev always recomputes
// and a stale dev cache never masks a query change.
export async function getCachedPreviousPeriod<R>(
  label: string,
  previousInput: unknown,
  compute: () => Promise<R>,
): Promise<R> {
  if (process.env.NODE_ENV !== 'production') {
    return compute();
  }
  const key = previousPeriodCacheKey(label, previousInput);
  const cached = await getRedisCache().getJson<R>(key);
  if (cached !== null) {
    return cached;
  }
  const result = await compute();
  if (result !== null && result !== undefined) {
    getRedisCache().setJson(key, PREVIOUS_PERIOD_TTL, result);
  }
  return result;
}
