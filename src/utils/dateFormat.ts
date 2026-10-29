/**
 * Date, Duration, and Timezone formatting helpers enforcing DD/MM/YYYY format
 * and displaying timestamps in the user's selected IANA timezone (default Asia/Kuala_Lumpur).
 */

export const SUPPORTED_TIMEZONES: { value: string; label: string }[] = [
  { value: 'Asia/Kuala_Lumpur', label: 'Malaysia (Asia/Kuala_Lumpur · GMT+8)' },
  { value: 'Asia/Singapore', label: 'Singapore (Asia/Singapore · GMT+8)' },
  { value: 'Asia/Jakarta', label: 'Indonesia WIB (Asia/Jakarta · GMT+7)' },
  { value: 'Asia/Bangkok', label: 'Thailand (Asia/Bangkok · GMT+7)' },
  { value: 'Asia/Tokyo', label: 'Japan (Asia/Tokyo · GMT+9)' },
  { value: 'Australia/Sydney', label: 'Australia AEST (Australia/Sydney)' },
  { value: 'Europe/London', label: 'United Kingdom (Europe/London)' },
  { value: 'UTC', label: 'Coordinated Universal Time (UTC)' },
];

export const DEFAULT_TIMEZONE = 'Asia/Kuala_Lumpur';

function extractZonedParts(date: Date, timeZone: string = DEFAULT_TIMEZONE) {
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value || '00';
    return {
      dd: get('day'),
      mm: get('month'),
      yyyy: get('year'),
      hh: get('hour') === '24' ? '00' : get('hour'),
      min: get('minute'),
      sec: get('second'),
    };
  } catch {
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = String(date.getFullYear());
    const hh = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    const sec = String(date.getSeconds()).padStart(2, '0');
    return { dd, mm, yyyy, hh, min, sec };
  }
}

export function formatDateDDMMYYYY(
  value?: string | number | Date | null,
  timeZone: string = DEFAULT_TIMEZONE
): string {
  if (value === null || value === undefined || value === '') return '';

  if (typeof value === 'number') {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    const { dd, mm, yyyy } = extractZonedParts(d, timeZone);
    return `${dd}/${mm}/${yyyy}`;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    const { dd, mm, yyyy } = extractZonedParts(value, timeZone);
    return `${dd}/${mm}/${yyyy}`;
  }

  const trimmed = String(value).trim();
  if (!trimmed) return '';

  const ddmmyyyyMatch = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (ddmmyyyyMatch) {
    return trimmed;
  }

  // Plain calendar date YYYY-MM-DD (no timezone day-shift)
  const yyyymmddMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (yyyymmddMatch) {
    const [, yyyy, mm, dd] = yyyymmddMatch;
    return `${dd}/${mm}/${yyyy}`;
  }

  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    const { dd, mm, yyyy } = extractZonedParts(parsed, timeZone);
    return `${dd}/${mm}/${yyyy}`;
  }

  return trimmed;
}

export function formatDateTimeDDMMYYYY(
  value: Date | number = new Date(),
  timeZone: string = DEFAULT_TIMEZONE
): string {
  const d = typeof value === 'number' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '';
  const { dd, mm, yyyy, hh, min } = extractZonedParts(d, timeZone);
  return `${dd}/${mm}/${yyyy}, ${hh}:${min}`;
}

export function formatTimeHHMM(
  value: Date | number,
  timeZone: string = DEFAULT_TIMEZONE
): string {
  const d = typeof value === 'number' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '';
  const { hh, min } = extractZonedParts(d, timeZone);
  return `${hh}:${min}`;
}

export function formatActivityTimestamp(
  at?: string,
  timestampIso?: string,
  timeZone: string = DEFAULT_TIMEZONE
): string {
  if (timestampIso) {
    const parsed = new Date(timestampIso);
    if (!Number.isNaN(parsed.getTime())) {
      return formatDateTimeDDMMYYYY(parsed, timeZone);
    }
  }
  return at || '';
}

export function toComparableYYYYMMDD(value?: string | null): string {
  if (!value) return '';
  const trimmed = value.trim();
  const dmy = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) {
    const dd = dmy[1].padStart(2, '0');
    const mm = dmy[2].padStart(2, '0');
    const yyyy = dmy[3];
    const mNum = Number(mm);
    const dNum = Number(dd);
    if (mNum >= 1 && mNum <= 12 && dNum >= 1 && dNum <= 31) {
      return `${yyyy}-${mm}-${dd}`;
    }
    return '';
  }

  const ymd = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (ymd) {
    return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
  }

  return '';
}

export function getTodayYYYYMMDD(timeZone: string = DEFAULT_TIMEZONE): string {
  const { yyyy, mm, dd } = extractZonedParts(new Date(), timeZone);
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Converts a YYYY-MM-DD deadline into end-of-day (23:59:59) epoch milliseconds
 * in the selected timezone (approximated cleanly via local/IANA offset).
 */
export function getDeadlineEndOfDayMs(
  deadlineYYYYMMDD: string,
  timeZone: string = DEFAULT_TIMEZONE
): number | null {
  const clean = toComparableYYYYMMDD(deadlineYYYYMMDD);
  if (!clean) return null;
  const [y, m, d] = clean.split('-').map(Number);
  if (!y || !m || !d) return null;

  // Compute offset of target timezone at noon UTC on that date
  const utcGuess = Date.UTC(y, m - 1, d, 23, 59, 59);
  try {
    const parts = extractZonedParts(new Date(utcGuess), timeZone);
    const zonedAsUtc = Date.UTC(
      Number(parts.yyyy),
      Number(parts.mm) - 1,
      Number(parts.dd),
      Number(parts.hh),
      Number(parts.min),
      Number(parts.sec)
    );
    const offsetMs = zonedAsUtc - utcGuess;
    return utcGuess - offsetMs;
  } catch {
    return new Date(y, m - 1, d, 23, 59, 59).getTime();
  }
}

export function formatDurationHoursMinutes(totalMinutes: number): string {
  const safe = Math.max(0, Math.round(totalMinutes || 0));
  const h = Math.floor(safe / 60);
  const m = safe % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

export function formatCountdownHMS(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function splitMinutesToHM(totalMinutes: number): { hours: number; minutes: number } {
  const safe = Math.max(0, Math.round(totalMinutes || 0));
  return {
    hours: Math.floor(safe / 60),
    minutes: safe % 60,
  };
}

export function combineHMToMinutes(hours: number, minutes: number): number {
  const h = Math.max(0, Math.floor(Number(hours) || 0));
  const m = Math.max(0, Math.floor(Number(minutes) || 0));
  return h * 60 + m;
}
