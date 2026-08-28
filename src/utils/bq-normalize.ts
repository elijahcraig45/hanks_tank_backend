/**
 * Shared BigQuery response helpers.
 *
 * Extracted from predictions.controller.ts so the MLB and NFL controllers use one
 * implementation. Pure functions, no behaviour change.
 *
 * BigQuery returns DATE/TIMESTAMP as { value: "..." } wrapper objects. Anything that
 * reaches the frontend must be flattened first, or the UI receives objects where it
 * expects strings.
 */

export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function formatIsoDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return formatIsoDate(date);
}

export function dateDiffInDays(startDate: string, endDate: string): number {
  const start = new Date(`${startDate}T12:00:00Z`).getTime();
  const end = new Date(`${endDate}T12:00:00Z`).getTime();
  return Math.round((end - start) / (24 * 60 * 60 * 1000));
}

export function clampProbability(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }

  return Math.min(0.999999, Math.max(0.000001, value));
}

export function normalizeBigQueryTemporalValue<T>(
  value: T | { value: T } | null | undefined
): T | string | null {
  if (value == null) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'object' && 'value' in (value as object)) {
    return normalizeBigQueryTemporalValue((value as { value: T }).value);
  }

  return value as T;
}
