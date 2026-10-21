// Mobilize Power tariffs: the published grid, and the values actually used.
//
// Three sources, by priority, value by value:
//   1. what the user typed in the settings (an empty field means "not set");
//   2. the grid read from mobilize-v2g.fr (see mobilizeGrid.js), when enabled;
//   3. DEFAULT_GRID below, the August 2026 grid, so the integration computes
//      something from the first start, even offline.
//
// All prices are TTC (taxes included), as on the Mobilize grid.

export const SUBSCRIBED_POWERS = [3, 6, 9, 12, 15, 18, 24, 30, 36];

export const DEFAULT_GRID = Object.freeze({
  label: "Août 2026",
  pricePerKwh: 0.1823,
  v2gHourRate: 0.1076,
  subscriptionByKva: Object.freeze({ 3: 136.27, 6: 178.28, 9: 223.54, 12: 267.24, 15: 308.26, 18: 350.39, 24: 440.46, 30: 523.04, 36: 606.53 }),
});

const frNumber = (s) => Number(String(s).replace(/\s/g, "").replace(",", "."));

/**
 * Reads the grid out of the text of the Mobilize PDF ("grille tarifaire").
 * Works on both the pdf.js text (one cell per line) and a layout text (a
 * table row per line). Returns null when a value is missing or implausible:
 * a half-read grid must never replace a good one.
 */
export function parseTariffGrid(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  const flat = text.replace(/ /g, " ");

  const subscriptionByKva = {};
  const rowRe = /(?:^|\s)(3|6|9|12|15|18|24|30|36)\s+(\d{2,4},\d{2})(?!\d)/g;
  for (const [, kva, amount] of flat.matchAll(rowRe)) {
    subscriptionByKva[kva] ??= frNumber(amount);
  }
  if (Object.keys(subscriptionByKva).length < 3) return null;

  // the only 4-decimal number of the grid is the price per kWh
  const price = flat.match(/(?:^|\s)(0,\d{4})(?!\d)/);
  const v2g = flat.match(/V2G\s*Hours?\s*:?\s*(\d+(?:,\d+)?)\s*cts/i);
  if (!price || !v2g) return null;
  const pricePerKwh = frNumber(price[1]);
  const v2gHourRate = frNumber(v2g[1]) / 100;
  if (!(pricePerKwh > 0.05 && pricePerKwh < 1) || !(v2gHourRate > 0 && v2gHourRate < 2)) return null;

  const month = flat.match(/(janvier|f[ée]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre)\s+(20\d\d)/i);
  const label = month ? `${month[1][0].toUpperCase()}${month[1].slice(1).toLowerCase()} ${month[2]}` : null;

  return { label, pricePerKwh, v2gHourRate, subscriptionByKva };
}

/**
 * The tariffs used for the balance.
 * @param {ReturnType<typeof import("./settings.js").readSettings>} settings
 * @param {object|null} fetchedGrid last grid read from the site (or null)
 */
export function resolveTariffs(settings, fetchedGrid) {
  const grid = settings.autoTariffs && fetchedGrid ? fetchedGrid : DEFAULT_GRID;
  const gridSource = grid === DEFAULT_GRID ? "default" : "site";
  const kva = settings.subscribedPower;
  const pick = (manual, fromGrid) =>
    manual !== null ? { value: manual, source: "manual" } : { value: fromGrid ?? null, source: gridSource };

  const price = pick(settings.pricePerKwh, grid.pricePerKwh);
  const rate = pick(settings.v2gHourRate, grid.v2gHourRate);
  const subscription = pick(settings.subscriptionAnnual, grid.subscriptionByKva[kva] ?? DEFAULT_GRID.subscriptionByKva[kva]);

  return {
    pricePerKwh: price.value,
    v2gHourRate: rate.value,
    subscriptionAnnual: subscription.value,
    injectedBuyback: settings.injectedBuyback,
    includeSubscription: settings.includeSubscription,
    subscribedPower: kva,
    gridLabel: grid.label,
    sources: { pricePerKwh: price.source, v2gHourRate: rate.source, subscriptionAnnual: subscription.source },
  };
}
