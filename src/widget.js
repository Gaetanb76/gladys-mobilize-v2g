// Dashboard widget "v2g_balance": the balance of a day, a month or a year,
// the detail of its lines, and a form to enter the official V2G hours of a
// month (Mobilize app or invoice).

import { computeBalance } from "./balance.js";
import { dayKey, monthKey, yearKey, monthLabel, previousMonth, daysInMonth } from "./dates.js";

export const WIDGET_KEY = "v2g_balance";
export const OFFICIAL_HOURS_ACTION = "official_hours";

const PERIODS = new Set(["day", "month", "year"]);

export function periodKey(period, now) {
  if (period === "day") return dayKey(now);
  if (period === "year") return yearKey(now);
  return monthKey(now);
}

function formatter(language) {
  const locale = language === "fr" ? "fr-FR" : "en-GB";
  const euro = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 4 });
  return {
    euro: (n) => euro.format(n),
    perKwh: (n) => `${euro.format(n)}/kWh`,
    perHour: (n) => `${euro.format(n)}/h`,
  };
}

const round = (n, digits) => Math.round(n * 10 ** digits) / 10 ** digits;

function title(period, key, language) {
  const fr = language === "fr";
  if (period === "day") return fr ? "Bilan V2G · aujourd'hui" : "V2G balance · today";
  if (period === "year") return `${fr ? "Bilan V2G" : "V2G balance"} · ${key}`;
  return `${fr ? "Bilan V2G" : "V2G balance"} · ${monthLabel(key, language)}`;
}

function sourceLabel(tariffs) {
  const sources = Object.values(tariffs.sources);
  if (sources.every((s) => s === "manual")) return { en: "Entered by hand", fr: "Saisis à la main" };
  const grid = sources.includes("site")
    ? { en: `Mobilize grid ${tariffs.gridLabel ?? ""}`, fr: `Grille Mobilize ${tariffs.gridLabel ?? ""}` }
    : { en: `Built-in grid ${tariffs.gridLabel}`, fr: `Grille intégrée ${tariffs.gridLabel}` };
  if (!sources.includes("manual")) return grid;
  return { en: `${grid.en} + by hand`, fr: `${grid.fr} + saisie` };
}

// Daily balances of a month, or monthly balances of a year.
function chartPoints(ledger, tariffs, period, key, now) {
  if (period === "month") {
    const [y, m] = key.split("-").map(Number);
    const last = key === monthKey(now) ? Number(dayKey(now).slice(8, 10)) : daysInMonth(y, m);
    return Array.from({ length: last }, (_, i) => {
      const day = `${key}-${String(i + 1).padStart(2, "0")}`;
      return { t: `${day}T12:00:00Z`, v: computeBalance(ledger.totals(day), tariffs, "day", day, now).balance };
    });
  }
  const lastMonth = key === yearKey(now) ? Number(monthKey(now).slice(5, 7)) : 12;
  return Array.from({ length: lastMonth }, (_, i) => {
    const month = `${key}-${String(i + 1).padStart(2, "0")}`;
    return { t: `${month}-15T12:00:00Z`, v: computeBalance(ledger.totals(month), tariffs, "month", month, now).balance };
  });
}

/**
 * @param {{ period?: string, language?: string, now: Date, ledger: object, tariffs: object,
 *           borne: { configured: boolean, reachable: boolean|null, plugged: boolean|null } }} input
 */
export function buildWidgetContent({ period: wanted, language = "en", now, ledger, tariffs, borne }) {
  const period = PERIODS.has(wanted) ? wanted : "month";
  const key = periodKey(period, now);
  const totals = ledger.totals(key);
  const b = computeBalance(totals, tariffs, period, key, now);
  const f = formatter(language);
  const gain = b.balance <= 0;

  const components = [
    { type: "text", variant: "caption", text: title(period, key, language) },
    {
      type: "value",
      label: gain ? { en: "Gain", fr: "Gain" } : { en: "Cost", fr: "Coût" },
      value: round(Math.abs(b.balance), 2),
      unit: "€",
      icon: gain ? "trending-down" : "trending-up",
      color: gain ? "success" : "warning",
    },
    { type: "value", label: { en: "Charging", fr: "Recharge" }, value: b.chargeCost, unit: "€", icon: "battery-charging" },
    { type: "value", label: { en: "V2G bonus", fr: "Bonus V2G" }, value: b.v2gBonus, unit: "€", icon: "gift", color: "success" },
    {
      type: "value",
      label: totals.officialHours ? { en: "V2G hours", fr: "Heures V2G" } : { en: "V2G hours (est.)", fr: "Heures V2G (est.)" },
      value: round(totals.v2gHours, 1),
      unit: "h",
      icon: "clock",
    },
  ];
  // the content budget is 8 components: caption, 4 tiles, chart, status, button

  if (period !== "day") {
    components.push({
      type: "chart",
      chart_type: "bar",
      title: period === "month" ? { en: "Balance per day", fr: "Bilan par jour" } : { en: "Balance per month", fr: "Bilan par mois" },
      unit: "€",
      series: [{ name: { en: "Balance", fr: "Bilan" }, points: chartPoints(ledger, tariffs, period, key, now) }],
    });
  }

  const kwh = (n) => `${round(n, 1).toLocaleString(language === "fr" ? "fr-FR" : "en-GB")} kWh`;
  const items = [
    { label: { en: "Charged", fr: "Énergie chargée" }, value: kwh(totals.chargedKwh), icon: "zap", color: "neutral" },
    { label: { en: "Sent back to the grid", fr: "Énergie renvoyée" }, value: kwh(totals.injectedKwh), icon: "upload", color: "neutral" },
    { label: { en: "Subscription (pro rata)", fr: "Abonnement (prorata)" }, value: f.euro(b.subscription), color: "neutral" },
  ];
  if (tariffs.injectedBuyback > 0) {
    items.push({ label: { en: "Energy sent back, bought", fr: "Rachat énergie renvoyée" }, value: f.euro(b.injectionCredit), color: "success" });
  }
  items.push(
    { label: { en: "Price per kWh", fr: "Prix du kWh" }, value: f.perKwh(tariffs.pricePerKwh ?? 0), color: "neutral" },
    { label: { en: "V2G Hour", fr: "V2G Hour" }, value: f.perHour(tariffs.v2gHourRate ?? 0), color: "neutral" },
    { label: { en: "Tariffs", fr: "Tarifs" }, value: sourceLabel(tariffs)[language === "fr" ? "fr" : "en"], icon: "file-text", color: "info" },
  );
  if (!borne.configured) {
    items.push({ label: { en: "Powerbox", fr: "Borne" }, value: language === "fr" ? "à configurer" : "not set up", color: "warning" });
  } else if (borne.reachable === false) {
    items.push({ label: { en: "Powerbox", fr: "Borne" }, value: language === "fr" ? "injoignable" : "unreachable", color: "danger" });
  } else if (borne.plugged !== null) {
    items.push({
      label: { en: "Car", fr: "Voiture" },
      value: borne.plugged ? (language === "fr" ? "branchée" : "plugged in") : language === "fr" ? "débranchée" : "unplugged",
      color: borne.plugged ? "success" : "neutral",
    });
  }
  components.push({ type: "status", items });

  const current = monthKey(now);
  const previous = previousMonth(current);
  components.push({
    type: "button",
    label: { en: "Official V2G hours", fr: "Heures V2G officielles" },
    icon: "edit-3",
    style: "secondary",
    action: {
      key: OFFICIAL_HOURS_ACTION,
      fields: [
        {
          key: "month",
          type: "select",
          required: true,
          default: current,
          label: { en: "Month", fr: "Mois" },
          options: [current, previous].map((m) => ({ value: m, label: { en: monthLabel(m, "en"), fr: monthLabel(m, "fr") } })),
        },
        { key: "hours", type: "number", min: 0, max: 744, label: { en: "V2G hours (app or invoice)", fr: "Heures V2G (appli ou facture)" } },
        { key: "clear", type: "boolean", default: false, label: { en: "Back to the estimate", fr: "Revenir à l'estimation" } },
      ],
    },
  });

  return { ttl_seconds: 300, components };
}
