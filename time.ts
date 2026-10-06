/**
 * All "daily" logic runs on Asia/Kuala_Lumpur time (UTC+8, no daylight saving).
 */
export const KL_OFFSET_MS = 8 * 60 * 60 * 1000
export const DAY_MS = 24 * 60 * 60 * 1000

/** "YYYY-MM-DD" of the KL day containing `ts`. */
export function klDayKey(ts: number = Date.now()): string {
  return new Date(ts + KL_OFFSET_MS).toISOString().slice(0, 10)
}

/** UTC epoch-ms range [start, end) of a KL day ("YYYY-MM-DD", or the day containing `ts`). */
export function klDayRange(day: string | number = Date.now()): { start: number; end: number } {
  const key = typeof day === 'number' ? klDayKey(day) : day
  const [y, m, d] = key.split('-').map(Number)
  const start = Date.UTC(y, m - 1, d) - KL_OFFSET_MS
  return { start, end: start + DAY_MS }
}

/** Hour of day (0–23) in KL time. */
export function klHour(ts: number): number {
  return new Date(ts + KL_OFFSET_MS).getUTCHours()
}

/** "1 Oct 2026, 14:05" in KL time, independent of the device's own time zone. */
export function formatKlDateTime(ts: number): string {
  const d = new Date(ts + KL_OFFSET_MS)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm}`
}

/** Seconds to 0.01, e.g. 12345 → "12.35". */
export function formatSeconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  return (Math.round(Math.max(0, ms) / 10) / 100).toFixed(2)
}
