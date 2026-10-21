import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createLedger, loadLedger, saveJson, MAX_GAP_MS } from "../src/ledger.js";
import { computeBalance } from "../src/balance.js";
import { subscriptionDays, dayKey } from "../src/dates.js";
import { resolveTariffs } from "../src/tariffs.js";
import { readSettings } from "../src/settings.js";

const at = (iso) => new Date(iso);
const minute = 60_000;

test("counts index deltas and plugged time per Paris day", () => {
  const ledger = createLedger();
  ledger.apply({ chargedWh: 1000, injectedWh: 500, plugged: true }, at("2026-10-21T10:00:00Z"));
  ledger.apply({ chargedWh: 3500, injectedWh: 500, plugged: true }, at("2026-10-21T10:30:00Z")); // 30 min > MAX_GAP: no hours
  ledger.apply({ chargedWh: 3500, injectedWh: 1700, plugged: true }, at("2026-10-21T10:36:00Z"));
  const day = ledger.totals("2026-10-21");
  assert.equal(day.chargedKwh, 2.5);
  assert.equal(day.injectedKwh, 1.2);
  assert.equal(day.v2gHours, 0.1); // the 6 minutes only
});

test("no hours while unplugged, none across a long gap", () => {
  const ledger = createLedger();
  const t0 = Date.parse("2026-10-21T08:00:00Z");
  ledger.apply({ chargedWh: 0, injectedWh: 0, plugged: false }, new Date(t0));
  ledger.apply({ chargedWh: 0, injectedWh: 0, plugged: true }, new Date(t0 + minute)); // just plugged
  ledger.apply({ chargedWh: 0, injectedWh: 0, plugged: true }, new Date(t0 + 2 * minute));
  ledger.apply({ chargedWh: 0, injectedWh: 0, plugged: true }, new Date(t0 + 2 * minute + MAX_GAP_MS + 1));
  ledger.apply({ chargedWh: 0, injectedWh: 0, plugged: false }, new Date(t0 + 30 * minute));
  assert.ok(Math.abs(ledger.totals("2026-10-21").v2gHours - 1 / 60) < 1e-9);
});

test("a counter that goes back restarts the count", () => {
  const ledger = createLedger();
  let resets = 0;
  ledger.apply({ chargedWh: 9000, injectedWh: 0, plugged: false }, at("2026-10-21T08:00:00Z"));
  ledger.apply({ chargedWh: 100, injectedWh: 0, plugged: false }, at("2026-10-21T08:01:00Z"), { onReset: () => resets++ });
  ledger.apply({ chargedWh: 600, injectedWh: 0, plugged: false }, at("2026-10-21T08:02:00Z"));
  assert.equal(resets, 1);
  assert.equal(ledger.totals("2026-10-21").chargedKwh, 0.5);
});

test("a reading without an index keeps the previous one", () => {
  const ledger = createLedger();
  ledger.apply({ chargedWh: 1000, injectedWh: null, plugged: false }, at("2026-10-21T08:00:00Z"));
  ledger.apply({ chargedWh: null, injectedWh: null, plugged: false }, at("2026-10-21T08:01:00Z"));
  ledger.apply({ chargedWh: 2000, injectedWh: null, plugged: false }, at("2026-10-21T08:02:00Z"));
  assert.equal(ledger.totals("2026-10-21").chargedKwh, 1);
});

test("days follow Paris midnight, not UTC", () => {
  assert.equal(dayKey(at("2026-10-21T22:30:00Z")), "2026-10-22"); // 00:30 in Paris (UTC+2)
  assert.equal(dayKey(at("2026-12-31T23:30:00Z")), "2027-01-01"); // 00:30 in Paris (UTC+1)
});

test("official hours replace the month's estimate, also in the year", () => {
  const ledger = createLedger({
    days: {
      "2026-09-30": { chargedKwh: 10, injectedKwh: 2, v2gHours: 5 },
      "2026-10-01": { chargedKwh: 20, injectedKwh: 4, v2gHours: 7 },
      "2026-10-02": { chargedKwh: 5, injectedKwh: 1, v2gHours: 3 },
    },
  });
  assert.equal(ledger.totals("2026-10").v2gHours, 10);
  ledger.setOfficialHours("2026-10", 12.5);
  assert.deepEqual(ledger.totals("2026-10"), { chargedKwh: 25, injectedKwh: 5, v2gHours: 12.5, officialHours: true });
  assert.equal(ledger.totals("2026").v2gHours, 17.5);
  assert.equal(ledger.totals("2026-10-01").v2gHours, 7); // a day stays estimated
  ledger.setOfficialHours("2026-08", 4); // a month with no recorded day
  assert.equal(ledger.totals("2026").v2gHours, 21.5);
  ledger.setOfficialHours("2026-10", null);
  assert.equal(ledger.totals("2026-10").v2gHours, 10);
});

test("subscription days: whole past periods, the current one up to today", () => {
  const now = at("2026-10-21T12:00:00Z");
  assert.equal(subscriptionDays("day", "2026-10-21", now), 1);
  assert.equal(subscriptionDays("month", "2026-10", now), 21);
  assert.equal(subscriptionDays("month", "2026-09", now), 30);
  assert.equal(subscriptionDays("month", "2026-11", now), 0);
  assert.equal(subscriptionDays("year", "2026", now), 294);
  assert.equal(subscriptionDays("year", "2024", now), 366);
});

test("balance: charge + subscription - V2G bonus - injection credit", () => {
  const tariffs = resolveTariffs(readSettings({ subscribed_power: "9" }), null); // 0.1823 €/kWh, 0.1076 €/h, 223.54 €/yr
  const now = at("2026-10-21T12:00:00Z");
  const b = computeBalance({ chargedKwh: 100, injectedKwh: 30, v2gHours: 300 }, tariffs, "month", "2026-10", now);
  assert.deepEqual(b, {
    chargeCost: 18.23,
    subscription: 12.86, // 223.54 x 21 / 365
    v2gBonus: 32.28,
    injectionCredit: 0,
    balance: -1.19,
  });
  const withBuyback = resolveTariffs(readSettings({ injected_buyback: "0,1823", include_subscription: false }), null);
  const b2 = computeBalance({ chargedKwh: 100, injectedKwh: 30, v2gHours: 0 }, withBuyback, "day", "2026-10-21", now);
  assert.equal(b2.subscription, 0);
  assert.equal(b2.injectionCredit, 5.47);
  assert.equal(b2.balance, 12.76);
});

test("persists and reloads; a damaged file is set aside", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "v2g-"));
  const file = path.join(dir, "ledger.json");
  const ledger = createLedger();
  ledger.apply({ chargedWh: 0, injectedWh: 0, plugged: true }, at("2026-10-21T08:00:00Z"));
  ledger.apply({ chargedWh: 4000, injectedWh: 0, plugged: true }, at("2026-10-21T08:05:00Z"));
  await saveJson(file, ledger.state);
  const again = await loadLedger(file);
  assert.equal(again.totals("2026-10-21").chargedKwh, 4);
  assert.equal(again.state.last.chargedWh, 4000);

  await fs.writeFile(file, "{not json");
  const errors = [];
  const fresh = await loadLedger(file, { logger: { error: (m) => errors.push(m) } });
  assert.equal(fresh.state.last, null);
  assert.equal(errors.length, 1);
  assert.ok((await fs.readdir(dir)).some((f) => f.startsWith("ledger.json.damaged-")));
  await fs.rm(dir, { recursive: true });
});
