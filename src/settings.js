// The integration settings (manifest config_schema) as typed values.

import { SUBSCRIBED_POWERS } from "./tariffs.js";

// An empty or invalid number field means "not set" (null), so the grid value applies.
function optionalNumber(value, { min = 0, max = Infinity } = {}) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const n = Number(String(value).replace(",", "."));
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function bool(value, fallback) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return fallback;
}

export function readSettings(config = {}) {
  const power = Number(config.subscribed_power);
  const poll = Number(config.poll_seconds);
  return {
    host: String(config.powerbox_host ?? "").trim(),
    username: String(config.powerbox_username ?? "").trim() || "installer",
    password: String(config.powerbox_password ?? ""),
    pollSeconds: Number.isFinite(poll) ? Math.min(300, Math.max(15, Math.round(poll))) : 30,
    autoTariffs: bool(config.auto_tariffs, true),
    subscribedPower: SUBSCRIBED_POWERS.includes(power) ? power : 9,
    pricePerKwh: optionalNumber(config.price_kwh, { max: 5 }),
    v2gHourRate: optionalNumber(config.v2g_hour_rate, { max: 5 }),
    subscriptionAnnual: optionalNumber(config.subscription_annual, { max: 10000 }),
    injectedBuyback: optionalNumber(config.injected_buyback, { max: 5 }) ?? 0,
    includeSubscription: bool(config.include_subscription, true),
  };
}
