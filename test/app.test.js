import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFakeGladys } from "@gladysassistant/integration-sdk/testing";
import { validateWidgetContent } from "@gladysassistant/integration-sdk";
import { createApp } from "../src/app.js";
import { startFakePowerbox } from "../tools/fake-powerbox.js";

const SITE_GRID = {
  grid: { label: "Septembre 2026", pricePerKwh: 0.2, v2gHourRate: 0.1, subscriptionByKva: { 9: 219 } },
  pdfUrl: "https://cdn-website.mobilityhouse.com/grille.pdf",
};

async function setup(t, { config = {}, grid = SITE_GRID } = {}) {
  const fake = await startFakePowerbox();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "v2g-app-"));
  let clock = new Date("2026-10-21T08:00:00Z");
  const gladys = createFakeGladys({
    config: { powerbox_host: fake.url, powerbox_password: "test", subscribed_power: "9", ...config },
  });
  const app = createApp(gladys, { dataDir, now: () => clock, fetchGrid: async () => grid });
  t.after(async () => {
    await app.stop();
    await gladys.disconnect();
    await fake.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await app.start();
  return {
    fake,
    gladys,
    app,
    dataDir,
    advance(ms) {
      clock = new Date(clock.getTime() + ms);
    },
    state: (key) => gladys.fake.lastState(`${gladys.externalIds("v2g_charger", "powerbox-verso").feature(key)}`),
  };
}

test("discovery publishes a device Gladys accepts", async (t) => {
  const { gladys } = await setup(t);
  await gladys.fake.scanRequest();
  const [device] = gladys.fake.discoveredDevices;
  assert.equal(device.name, "Mobilize Power V2G");
  assert.equal(device.features.length, 20);
});

test("a charge then a V2G session give the day's balance", async (t) => {
  const s = await setup(t);
  const minute = 60_000;
  s.fake.setState({ plugged: true, powerW: 7400 });
  for (let i = 0; i < 10; i++) {
    s.advance(minute);
    s.fake.addEnergy({ chargedWh: 1000 }); // 10 kWh in 10 minutes (simulator speed)
    await s.app.pollOnce();
  }
  s.fake.setState({ powerW: -3600 });
  for (let i = 0; i < 2; i++) {
    s.advance(minute);
    s.fake.addEnergy({ injectedWh: 500 });
    await s.app.pollOnce();
  }
  // the reading at start saw the car unplugged: 12 plugged readings 1 minute
  // apart count 11 minutes
  assert.equal(s.state("day_charged"), 10);
  assert.equal(s.state("day_injected"), 1);
  assert.equal(s.state("day_v2g_hours"), 0.18);
  assert.equal(s.state("day_charge_cost"), 2); // 10 kWh x 0.2 (site grid)
  assert.equal(s.state("day_v2g_bonus"), 0.02); // 11/60 h x 0.1
  assert.equal(s.state("day_subscription"), 0.6); // 219 / 365
  assert.equal(s.state("day_injection_credit"), 0);
  assert.equal(s.state("day_balance"), 2.58);
  assert.equal(s.state("plugged"), 1);
  assert.equal(s.state("power"), -3600);
  assert.equal(s.state("month_charged"), 10);
});

test("manual tariffs win over the site grid", async (t) => {
  const s = await setup(t, { config: { price_kwh: "0.1", v2g_hour_rate: "0.0633", injected_buyback: "0.1823", include_subscription: false } });
  s.fake.setState({ plugged: true });
  s.advance(60_000);
  s.fake.addEnergy({ chargedWh: 2000, injectedWh: 1000 });
  await s.app.pollOnce();
  assert.equal(s.state("day_charge_cost"), 0.2);
  assert.equal(s.state("day_injection_credit"), 0.18);
  assert.equal(s.state("day_subscription"), 0);
});

test("the widget fits the Gladys vocabulary for every period", async (t) => {
  const s = await setup(t);
  for (const period of ["day", "month", "year"]) {
    for (const language of ["fr", "en"]) {
      const ack = await s.gladys.fake.widgetGet("v2g_balance", { settings: { period }, language });
      assert.equal(ack.success, true);
      assert.deepEqual(validateWidgetContent(ack.data.content), [], `${period}/${language}`);
    }
  }
});

test("official hours from the widget replace the month's estimate", async (t) => {
  const s = await setup(t);
  const ack = await s.gladys.fake.widgetAction("v2g_balance", "official_hours", {}, {
    settings: { period: "month" },
    values: { month: "2026-10", hours: 120, clear: false },
  });
  assert.equal(ack.success, true);
  assert.equal(s.state("month_v2g_hours"), 120);
  assert.equal(s.state("month_v2g_bonus"), 12);
  assert.equal(s.state("day_v2g_hours"), 0, "days stay estimated");

  await s.gladys.fake.action("official_hours", { month: "", hours: null, clear: true });
  assert.equal(s.state("month_v2g_hours"), 0);
});

test("an unreachable borne is reported, then recovers", async (t) => {
  const s = await setup(t);
  s.fake.failNextRequests(1);
  s.advance(60_000);
  await s.app.pollOnce();
  assert.equal(s.gladys.fake.connectionStatus.connected, false);
  s.advance(60_000);
  await s.app.pollOnce();
  assert.equal(s.gladys.fake.connectionStatus.connected, true);
});

test("the connection test shows the meters", async (t) => {
  const s = await setup(t);
  const ack = await s.gladys.fake.action("test_connection", {});
  assert.match(ack.data.message.fr, /^OK : chargé|^OK : charged/);
  assert.match(ack.data.message.en, /Power Board Meter/);
});

test("the record survives a restart", async (t) => {
  const s = await setup(t);
  s.fake.setState({ plugged: true });
  s.advance(60_000);
  s.fake.addEnergy({ chargedWh: 3000 });
  await s.app.pollOnce();
  await s.app.stop(); // saves
  const saved = JSON.parse(await fs.readFile(path.join(s.dataDir, "ledger.json"), "utf8"));
  assert.equal(saved.days["2026-10-21"].chargedKwh, 3);
  const grid = JSON.parse(await fs.readFile(path.join(s.dataDir, "tariff-grid.json"), "utf8"));
  assert.equal(grid.grid.label, "Septembre 2026");
});

test("a cable left in the borne without a car counts no V2G hour", async (t) => {
  const s = await setup(t);
  s.fake.setState({ plugged: false, cablePlugged: true });
  for (let i = 0; i < 5; i++) {
    s.advance(60_000);
    await s.app.pollOnce();
  }
  assert.equal(s.state("plugged"), 0);
  assert.equal(s.state("day_v2g_hours"), 0);
});

test("without the socket state, the energies still count but no hour does", async (t) => {
  const s = await setup(t);
  s.fake.setState({ plugged: true, statusAvailable: false });
  for (let i = 0; i < 3; i++) {
    s.advance(60_000);
    s.fake.addEnergy({ chargedWh: 500 });
    await s.app.pollOnce();
  }
  assert.equal(s.state("day_charged"), 1.5);
  assert.equal(s.state("day_v2g_hours"), 0);
  assert.equal(s.gladys.fake.connectionStatus.connected, true, "the borne itself answers");
});

test("no kWh feature makes Gladys derive consumption and cost features", async (t) => {
  const { gladys } = await setup(t);
  await gladys.fake.scanRequest();
  const [device] = gladys.fake.discoveredDevices;
  const derived = device.features.filter(
    (f) => (f.category === "energy-sensor" && ["energy", "index", "daily-consumption", "thirty-minutes-consumption"].includes(f.type)) ||
      (f.category === "switch" && f.type === "energy"),
  );
  assert.deepEqual(derived, []);
});
