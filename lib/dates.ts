// Deterministic date resolution for dunning commitments.
// All "today" logic is anchored to Asia/Dubai (UTC+4, no DST) so a customer's
// "tomorrow" matches the day they actually mean, regardless of server timezone.

const WEEKDAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_SLUGS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_SLUGS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// ── Calendar helpers (UTC-noon dates, DST-safe) ───────────────────────────────

export function dubaiTodayISO(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(new Date());
}

function todayUTC(): Date {
  const [y, m, d] = dubaiTodayISO().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDays(base: Date, n: number): Date {
  return new Date(base.getTime() + n * 86_400_000);
}

function toISO(d: Date): string {
  return d.toISOString().split('T')[0];
}

function safeDate(y: number, m: number, d: number): Date | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

function upcomingWeekday(base: Date, target: number, strictAfter: boolean): Date {
  let days = (target - base.getUTCDay() + 7) % 7;
  if (strictAfter && days === 0) days = 7;
  return addDays(base, days);
}

function lastDayOfMonth(base: Date): Date {
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0));
}

function addMonths(base: Date, n: number): Date {
  const y = base.getUTCFullYear();
  const m = base.getUTCMonth() + n;
  const d = base.getUTCDate();
  const dt = new Date(Date.UTC(y, m, d));
  if (dt.getUTCDate() !== d) dt.setUTCDate(0); // clamp overflow, e.g. Jan 31 + 1 month
  return dt;
}

const NUM_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, couple: 2, three: 3, four: 4,
  five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function wordToNum(w: string): number | null {
  if (/^\d+$/.test(w)) return parseInt(w, 10);
  return NUM_WORDS[w] ?? null;
}

// ── Prompt context ────────────────────────────────────────────────────────────

// Injected into the AI prompt so it never has to guess the current date.
export function buildDateContext(): string {
  const base = todayUTC();
  const anchors: string[] = [];
  for (let i = 0; i <= 14; i++) {
    const d = addDays(base, i);
    anchors.push(`${WEEKDAYS_FULL[d.getUTCDay()]} ${toISO(d)}`);
  }
  return (
    `Today is ${WEEKDAYS_FULL[base.getUTCDay()]}, ${toISO(base)} (Asia/Dubai).\n` +
    `Weekday reference for the next 14 days: ${anchors.join(', ')}.`
  );
}

// ── Resolver ──────────────────────────────────────────────────────────────────

function parseExplicitDate(s: string, base: Date): string | null {
  // YYYY-MM-DD
  let m = s.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (m) {
    const d = safeDate(+m[1], +m[2], +m[3]);
    return d ? toISO(d) : null;
  }
  // DD Mon [YYYY]
  m = s.match(/\b(\d{1,2})\s+([a-z]{3,9})\.?(?:\s+(\d{4}))?\b/);
  if (m) {
    const mon = MONTH_SLUGS.indexOf(m[2].slice(0, 3));
    if (mon >= 0) {
      const year = m[3] ? +m[3] : base.getUTCFullYear();
      let d = safeDate(year, mon + 1, +m[1]);
      if (d) {
        if (!m[3] && toISO(d) < toISO(base)) d = safeDate(year + 1, mon + 1, +m[1])!;
        return toISO(d);
      }
    }
  }
  // Mon DD [YYYY]
  m = s.match(/\b([a-z]{3,9})\.?\s+(\d{1,2})(?:\s+(\d{4}))?\b/);
  if (m) {
    const mon = MONTH_SLUGS.indexOf(m[1].slice(0, 3));
    if (mon >= 0) {
      const year = m[3] ? +m[3] : base.getUTCFullYear();
      let d = safeDate(year, mon + 1, +m[2]);
      if (d) {
        if (!m[3] && toISO(d) < toISO(base)) d = safeDate(year + 1, mon + 1, +m[2])!;
        return toISO(d);
      }
    }
  }
  // DD[/-.]MM[/-.]YYYY
  m = s.match(/\b(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{4}))?\b/);
  if (m) {
    const day = +m[1];
    const mon = +m[2];
    if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
      const year = m[3] ? +m[3] : base.getUTCFullYear();
      let d = safeDate(year, mon, day);
      if (d) {
        if (!m[3] && toISO(d) < toISO(base)) d = safeDate(year + 1, mon, day)!;
        return toISO(d);
      }
    }
  }
  return null;
}

// Turn a customer's date phrase into a concrete YYYY-MM-DD, always in the future.
// Returns null when nothing recognisable is present (caller then downgrades).
export function resolveCommittedDate(phrase: string | null | undefined): string | null {
  if (!phrase) return null;
  const s = phrase.toLowerCase().replace(/[.,!?]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;

  const base = todayUTC();

  if (/\bday after tomorrow\b/.test(s)) return toISO(addDays(base, 2));
  if (/\b(?:tomorrow|tmrw|tmr|tomrw)\b/.test(s)) return toISO(addDays(base, 1));
  if (/\b(?:today|tonight|right now)\b/.test(s)) return toISO(base);

  // Weekends — user's explicit rule.
  if (/\bnext weekend\b/.test(s)) return toISO(addDays(upcomingWeekday(base, 5, false), 8));
  if (/\b(?:this weekend|weekend|end of (?:the )?week|end of (?:this )?week)\b/.test(s)) {
    return toISO(upcomingWeekday(base, 5, false));
  }

  if (/\b(?:end of (?:the )?month|month end)\b/.test(s)) return toISO(lastDayOfMonth(base));
  if (/\bnext month\b/.test(s)) return toISO(addMonths(base, 1));

  // "in N days/weeks/months"
  const inN = s.match(/\bin\s+(a|an|one|two|couple|three|four|five|six|seven|eight|nine|ten|\d+)\s+(day|days|week|weeks|month|months)\b/);
  if (inN) {
    const n = wordToNum(inN[1]);
    if (n != null) {
      if (inN[2].startsWith('day')) return toISO(addDays(base, n));
      if (inN[2].startsWith('week')) return toISO(addDays(base, n * 7));
      if (inN[2].startsWith('month')) return toISO(addMonths(base, n));
    }
  }

  // A calendar date beats a weekday name when both appear.
  const explicit = parseExplicitDate(s, base);
  if (explicit) return explicit;

  // Weekday name → nearest upcoming (strictly after today).
  for (let i = 0; i < 7; i++) {
    const full = WEEKDAY_SLUGS[i];
    const re = new RegExp(`\\b(?:${full}|${full.slice(0, 3)})\\b`);
    if (re.test(s)) {
      const days = ((i - base.getUTCDay() + 7) % 7) || 7;
      return toISO(addDays(base, days));
    }
  }

  return null;
}

// ── Customer-facing confirmation (echoed after a resolved commitment) ──────────

export function dateConfirmLine(lang: string, iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const human = d.toLocaleDateString('en-GB', {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
  const dm = d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
  switch (lang) {
    case 'ar': return `للتأكيد، موعد السداد المتوقع هو ${dm}.`;
    case 'hi': return `पुष्टि के लिए, भुगतान की तारीख ${dm} है।`;
    default:   return `To confirm, the payment date is ${human}.`;
  }
}
