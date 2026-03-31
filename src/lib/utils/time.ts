export function nowIso(): string {
  return new Date().toISOString();
}

export function daysAgo(days: number): Date {
  const base = new Date();
  base.setDate(base.getDate() - days);
  return base;
}

export function safeNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}
