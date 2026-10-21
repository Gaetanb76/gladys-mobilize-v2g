// The balance of a period, in euros TTC:
//
//   charge cost       = kWh charged      x price per kWh
//   subscription      = annual amount    x days of the period / days of the year
//   V2G bonus         = V2G hours        x V2G Hour rate
//   injection credit  = kWh sent back    x buyback price (0 unless set)
//   balance           = charge cost + subscription - V2G bonus - injection credit
//
// A positive balance is what the car costs, a negative one what it earns.

import { daysInYear, subscriptionDays } from "./dates.js";

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {{chargedKwh: number, injectedKwh: number, v2gHours: number}} totals
 * @param {ReturnType<typeof import("./tariffs.js").resolveTariffs>} tariffs
 * @param {"day"|"month"|"year"} period
 * @param {string} key the period key (see dates.js)
 */
export function computeBalance(totals, tariffs, period, key, now = new Date()) {
  const days = subscriptionDays(period, key, now);
  const chargeCost = totals.chargedKwh * (tariffs.pricePerKwh ?? 0);
  const subscription = tariffs.includeSubscription
    ? ((tariffs.subscriptionAnnual ?? 0) * days) / daysInYear(Number(key.slice(0, 4)))
    : 0;
  const v2gBonus = totals.v2gHours * (tariffs.v2gHourRate ?? 0);
  const injectionCredit = totals.injectedKwh * (tariffs.injectedBuyback ?? 0);
  return {
    chargeCost: round2(chargeCost),
    subscription: round2(subscription),
    v2gBonus: round2(v2gBonus),
    injectionCredit: round2(injectionCredit),
    balance: round2(chargeCost + subscription - v2gBonus - injectionCredit),
  };
}
