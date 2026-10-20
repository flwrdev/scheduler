// Helpers for the Polaris date field (`<s-date-field>`). Dates are plain "YYYY-MM-DD" text.

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EARLIEST_YEAR = 2000;

// True when the text is a full "YYYY-MM-DD" date with a sensible year. The field can send
// half-typed text such as "0002-07-11" while the merchant is still typing, and this tells
// those apart from a finished date.
export function isCompleteIsoDate(value: string): boolean {
  return (
    ISO_DATE_PATTERN.test(value) &&
    Number(value.slice(0, 4)) >= EARLIEST_YEAR
  );
}

// Builds the `disallow` text that turns off every date before `isoDate`. The result looks
// like "--2026-10-16" (everything up to and including the day before).
export function disallowDatesBefore(isoDate: string): string {
  const day = new Date(`${isoDate}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 1);
  return `--${day.toISOString().slice(0, 10)}`;
}
