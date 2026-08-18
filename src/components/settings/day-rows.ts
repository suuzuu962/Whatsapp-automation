import type { AiBusinessHoursWindow } from '@/types';

// ------------------------------------------------------------
// Shared day-by-day hours editor shape — used by both the account-level
// business hours editor (ai-agent-config.tsx) and the per-staff working
// hours editor (staff-management.tsx), since both edit the same
// {day, open, close}[] shape with a fixed 7-row Sun..Sat UI.
// ------------------------------------------------------------

export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export type DayRow = { day: number; enabled: boolean; open: string; close: string };

export function emptyDayRows(): DayRow[] {
  return DAY_LABELS.map((_, day) => ({ day, enabled: false, open: '09:00', close: '17:00' }));
}

export function windowsToDayRows(windows: AiBusinessHoursWindow[] | undefined): DayRow[] {
  const rows = emptyDayRows();
  for (const w of windows ?? []) {
    if (w.day >= 0 && w.day <= 6) {
      rows[w.day] = { day: w.day, enabled: true, open: w.open, close: w.close };
    }
  }
  return rows;
}

export function dayRowsToWindows(rows: DayRow[]): AiBusinessHoursWindow[] {
  return rows.filter((d) => d.enabled).map((d) => ({ day: d.day, open: d.open, close: d.close }));
}
