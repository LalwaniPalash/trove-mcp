export function cacheKey(prefix: string, payload: unknown): string {
  const serialized = JSON.stringify(payload);
  let hash = 0;
  for (let i = 0; i < serialized.length; i += 1) {
    hash = (hash << 5) - hash + serialized.charCodeAt(i);
    hash |= 0;
  }
  return `${prefix}:${Math.abs(hash)}`;
}
