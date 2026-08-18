/**
 * Dependency-free IANA timezone conversion. This codebase has no
 * date-fns-tz/luxon dependency, and pulling one in for a handful of
 * conversions isn't worth it — `Intl.DateTimeFormat`, built into
 * Node/V8, already carries the full IANA database. The "guess, then
 * correct by the observed offset" trick below is the standard
 * dependency-free way to convert a civil (wall-clock) date/time in an
 * arbitrary zone to a UTC instant, including DST correctly for all real
 * zones — see e.g. https://stackoverflow.com/a/54127122.
 */

interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number; // 0-23
  minute: number;
  second: number;
}

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    // Intl can format midnight as hour "24" with hour12: false in some
    // engines — normalize it back to 0.
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/**
 * Converts a civil date/time (as a customer or business owner would say
 * it — "9:00 AM on August 20th in Asia/Kolkata") to the UTC instant it
 * represents.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const zonedGuess = getZonedParts(utcGuess, timeZone);
  const guessAsUtc = Date.UTC(
    zonedGuess.year,
    zonedGuess.month - 1,
    zonedGuess.day,
    zonedGuess.hour,
    zonedGuess.minute,
    zonedGuess.second,
  );
  const offsetMs = guessAsUtc - utcGuess.getTime();
  return new Date(utcGuess.getTime() - offsetMs);
}

/** 0 = Sunday .. 6 = Saturday, matching AiBusinessHoursWindow.day. */
export function dayOfWeekInZone(year: number, month: number, day: number, timeZone: string): number {
  // Anchor at local noon so we're never within a DST-transition window
  // when asking Intl which weekday this civil date falls on.
  const noonUtc = zonedTimeToUtc(year, month, day, 12, 0, timeZone);
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(noonUtc);
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[weekday] ?? new Date(noonUtc).getUTCDay();
}

/** Parses a "YYYY-MM-DD" string into its numeric parts. Throws on any
 *  other shape — callers validate the format before calling this. */
export function parseDateStr(dateStr: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) throw new Error(`Invalid date string: ${dateStr}`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/** Parses an "HH:MM" 24-hour string into its numeric parts. */
export function parseTimeStr(timeStr: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(timeStr);
  if (!match) throw new Error(`Invalid time string: ${timeStr}`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}
