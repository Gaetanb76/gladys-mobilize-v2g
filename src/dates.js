// Calendar keys in the French time zone: Mobilize Power is a France-only
// offer, so days, months and years are those of Europe/Paris, whatever the
// container's clock.

export const TIME_ZONE = "Europe/Paris";

const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

/** "YYYY-MM-DD" of the instant in Paris. */
export function dayKey(date) {
  return dayFormat.format(date);
}

export const monthKey = (date) => dayKey(date).slice(0, 7);
export const yearKey = (date) => dayKey(date).slice(0, 4);

export const isLeap = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
export const daysInYear = (year) => (isLeap(year) ? 366 : 365);
export const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** Day number in the year of a "YYYY-MM-DD" key (1 = January 1st). */
export function dayOfYear(key) {
  const [y, m, d] = key.split("-").map(Number);
  return (Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86_400_000 + 1;
}

/**
 * How many days of the period the subscription is counted for: a past period
 * counts whole, the current one up to today included.
 * @param {"day"|"month"|"year"} period
 * @param {string} key "YYYY-MM-DD", "YYYY-MM" or "YYYY"
 */
export function subscriptionDays(period, key, now = new Date()) {
  if (period === "day") return 1;
  const today = dayKey(now);
  const year = Number(key.slice(0, 4));
  if (period === "month") {
    const full = daysInMonth(year, Number(key.slice(5, 7)));
    if (key === today.slice(0, 7)) return Number(today.slice(8, 10));
    return key < today.slice(0, 7) ? full : 0;
  }
  if (key === today.slice(0, 4)) return dayOfYear(today);
  return key < today.slice(0, 4) ? daysInYear(year) : 0;
}

/** The month before a "YYYY-MM" key. */
export function previousMonth(key) {
  const [y, m] = key.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

const MONTHS_FR = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "octobre 2026" / "October 2026" for a "YYYY-MM" key. */
export function monthLabel(key, language = "fr") {
  const [y, m] = key.split("-").map(Number);
  return `${(language === "fr" ? MONTHS_FR : MONTHS_EN)[m - 1]} ${y}`;
}
