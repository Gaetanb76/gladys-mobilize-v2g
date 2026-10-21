// Day-by-day record of what went through the Powerbox, built from the
// borne's cumulative counters:
//   - kWh charged into the car   (delta of the charged energy index),
//   - kWh sent back to the grid  (delta of the injected energy index),
//   - V2G hours                  (time with the car plugged in).
//
// The V2G hours are an ESTIMATE: Mobilize counts them only once the minimum
// charge level is reached and until the departure time, which the borne does
// not expose. The user can enter the official figure of a month (Mobilize app
// or invoice); it then replaces the estimate for that month.
//
// The record is persisted as JSON in the integration's /data folder, so the
// totals survive restarts and updates.

import fs from "node:fs/promises";
import path from "node:path";
import { dayKey } from "./dates.js";

// Between two readings further apart than this (borne unreachable, Gladys
// stopped), nobody knows whether the car stayed plugged: no hour is counted.
export const MAX_GAP_MS = 10 * 60 * 1000;
const KEEP_DAYS = 1100; // about three years of history

const emptyDay = () => ({ chargedKwh: 0, injectedKwh: 0, v2gHours: 0 });
const finite = (v) => typeof v === "number" && Number.isFinite(v);

export function createLedger(initial = {}) {
  const state = {
    version: 1,
    last: initial.last ?? null, // { at, chargedWh, injectedWh, plugged }
    days: initial.days ?? {},
    officialHours: initial.officialHours ?? {},
  };

  function day(key) {
    state.days[key] ??= emptyDay();
    return state.days[key];
  }

  // Delta of a cumulative index; a counter that went back (borne reset,
  // replaced board) restarts the count instead of producing a negative value.
  function indexDelta(previous, current, onReset) {
    if (!finite(previous) || !finite(current)) return 0;
    if (current < previous) {
      onReset?.();
      return 0;
    }
    return current - previous;
  }

  return {
    state,

    /**
     * Records one reading of the borne.
     * @param {{chargedWh: number|null, injectedWh: number|null, plugged: boolean|null}} reading
     * @param {Date} at
     * @returns {{changed: boolean, reset: boolean}}
     */
    apply(reading, at, { onReset } = {}) {
      const last = state.last;
      const now = { at: at.toISOString(), chargedWh: reading.chargedWh, injectedWh: reading.injectedWh, plugged: reading.plugged };
      let changed = false;
      let reset = false;
      if (last) {
        const gap = at.getTime() - Date.parse(last.at);
        if (gap <= 0) return { changed: false, reset: false };
        const flagReset = () => {
          reset = true;
          onReset?.();
        };
        const chargedKwh = indexDelta(last.chargedWh, reading.chargedWh, flagReset) / 1000;
        const injectedKwh = indexDelta(last.injectedWh, reading.injectedWh, flagReset) / 1000;
        const hours = last.plugged === true && reading.plugged === true && gap <= MAX_GAP_MS ? gap / 3_600_000 : 0;
        if (chargedKwh > 0 || injectedKwh > 0 || hours > 0) {
          const d = day(dayKey(at));
          d.chargedKwh += chargedKwh;
          d.injectedKwh += injectedKwh;
          d.v2gHours += hours;
          changed = true;
        }
        // keep the previous index when a reading lacks it, so the next delta is right
        if (!finite(now.chargedWh)) now.chargedWh = last.chargedWh;
        if (!finite(now.injectedWh)) now.injectedWh = last.injectedWh;
      }
      state.last = now;
      return { changed, reset };
    },

    /** Official V2G hours of a month ("YYYY-MM"); null clears it (back to the estimate). */
    setOfficialHours(month, hours) {
      if (hours === null) delete state.officialHours[month];
      else state.officialHours[month] = hours;
    },

    /**
     * Totals of a day ("YYYY-MM-DD"), a month ("YYYY-MM") or a year ("YYYY").
     * A month's hours are the official figure when one was entered.
     */
    totals(key) {
      const sum = { chargedKwh: 0, injectedKwh: 0, v2gHours: 0, officialHours: false };
      const months = new Map();
      for (const [k, d] of Object.entries(state.days)) {
        if (!k.startsWith(key)) continue;
        sum.chargedKwh += d.chargedKwh;
        sum.injectedKwh += d.injectedKwh;
        const m = k.slice(0, 7);
        months.set(m, (months.get(m) ?? 0) + d.v2gHours);
      }
      if (key.length > 7) {
        sum.v2gHours = state.days[key]?.v2gHours ?? 0;
        return sum;
      }
      // months with an official figure but no recorded day still count
      for (const m of Object.keys(state.officialHours)) if (m.startsWith(key) && !months.has(m)) months.set(m, 0);
      for (const [m, estimate] of months) {
        const official = state.officialHours[m];
        if (finite(official)) sum.officialHours = true;
        sum.v2gHours += finite(official) ? official : estimate;
      }
      return sum;
    },

    /** Drops the days older than about three years. */
    prune(now = new Date()) {
      const limit = dayKey(new Date(now.getTime() - KEEP_DAYS * 86_400_000));
      for (const k of Object.keys(state.days)) if (k < limit) delete state.days[k];
    },
  };
}

// --- Persistence -----------------------------------------------------------

export async function loadLedger(file, { logger } = {}) {
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return createLedger();
  }
  try {
    const data = JSON.parse(raw);
    return createLedger(data?.version === 1 ? data : {});
  } catch {
    // keep the damaged file aside for a manual rescue rather than crashing on every start
    const aside = `${file}.damaged-${Date.now()}`;
    await fs.rename(file, aside);
    logger?.error(`The V2G record was unreadable and was moved to ${aside}; starting a new one`);
    return createLedger();
  }
}

/** Atomic write: a crash mid-write never leaves a truncated record. */
export async function saveJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, file);
}
