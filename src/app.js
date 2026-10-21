// The integration: polls the Powerbox, keeps the day-by-day record, keeps
// the tariffs up to date, publishes the Gladys states and serves the widget.
// Takes the Gladys client as an argument so the tests can pass a fake one.

import path from "node:path";
import fs from "node:fs/promises";
import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES, DEVICE_FEATURE_UNITS } from "@gladysassistant/integration-sdk";
import { readSettings } from "./settings.js";
import { resolveTariffs } from "./tariffs.js";
import { fetchMobilizeGrid } from "./mobilizeGrid.js";
import { createPowerboxClient, parseMeters, describeMeters } from "./powerbox.js";
import { loadLedger, saveJson } from "./ledger.js";
import { computeBalance } from "./balance.js";
import { buildDiscoveredDevice, DEVICE_TYPE, PLATFORM_ID, PERIODS } from "./device.js";
import { createChangePublisher } from "./publisher.js";
import { buildWidgetContent, periodKey, WIDGET_KEY, OFFICIAL_HOURS_ACTION } from "./widget.js";
import { monthKey, previousMonth, monthLabel } from "./dates.js";

const GRID_REFRESH_MS = 24 * 60 * 60 * 1000;
const SAVE_EVERY_MS = 5 * 60 * 1000; // spare the SD card of a Raspberry Pi
const ERROR_POLL_SECONDS = 120; // slower polling while the borne fails
const round = (n, digits) => Math.round(n * 10 ** digits) / 10 ** digits;

export function createApp(gladys, { dataDir = "/data", now = () => new Date(), fetchGrid = fetchMobilizeGrid, logger } = {}) {
  const ledgerFile = path.join(dataDir, "ledger.json");
  const gridFile = path.join(dataDir, "tariff-grid.json");
  const ids = gladys.externalIds(DEVICE_TYPE, PLATFORM_ID);
  const publisher = createChangePublisher({ ids, publishStates: (states) => gladys.publishStates(states) });

  let settings = readSettings({});
  let ledger = null;
  let fetched = null; // { grid, pdfUrl, fetchedAt } last good grid read from the site
  let client = null;
  let pollTimer = null;
  let gridTimer = null;
  let consecutiveErrors = 0;
  let lastSave = 0;
  let dirty = false;
  const borne = { configured: false, reachable: null, plugged: null, lastError: null };

  const tariffs = () => resolveTariffs(settings, fetched?.grid ?? null);

  // --- Persistence ---------------------------------------------------------

  async function save(force = false) {
    if (!ledger || !dirty) return;
    if (!force && now().getTime() - lastSave < SAVE_EVERY_MS) return;
    try {
      ledger.prune(now());
      await saveJson(ledgerFile, ledger.state);
      lastSave = now().getTime();
      dirty = false;
    } catch (err) {
      logger?.error(`Could not save the V2G record: ${err.message}`);
    }
  }

  async function loadGridCache() {
    try {
      fetched = JSON.parse(await fs.readFile(gridFile, "utf8"));
    } catch {
      fetched = null;
    }
  }

  // --- States --------------------------------------------------------------

  function periodStates() {
    const t = tariffs();
    const at = now();
    const states = {};
    for (const p of PERIODS) {
      const key = periodKey(p, at);
      const totals = ledger.totals(key);
      const b = computeBalance(totals, t, p, key, at);
      Object.assign(states, {
        [`${p}_charged`]: round(totals.chargedKwh, 3),
        [`${p}_injected`]: round(totals.injectedKwh, 3),
        [`${p}_v2g_hours`]: round(totals.v2gHours, 2),
        [`${p}_charge_cost`]: b.chargeCost,
        [`${p}_subscription`]: b.subscription,
        [`${p}_v2g_bonus`]: b.v2gBonus,
        [`${p}_injection_credit`]: b.injectionCredit,
        [`${p}_balance`]: b.balance,
      });
    }
    return states;
  }

  async function publish(live = {}) {
    try {
      await publisher.publish({ ...live, ...periodStates() });
    } catch (err) {
      logger?.warn(`Could not publish the states: ${err.message}`);
    }
  }

  async function setReachable(reachable, error = null) {
    const changed = borne.reachable !== reachable || borne.lastError !== error;
    borne.reachable = reachable;
    borne.lastError = error;
    if (!changed) return;
    const message = reachable
      ? { en: "Connected to the Powerbox", fr: "Connecté à la borne" }
      : { en: `Powerbox: ${error}`, fr: `Borne : ${error}` };
    await gladys.setConnectionStatus(reachable, message).catch(() => {});
    gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  // --- Polling ---------------------------------------------------------------

  let polling = false;

  async function pollOnce() {
    if (!client || polling) return; // a slow borne must not stack up reads
    polling = true;
    try {
      await readAndRecord();
    } finally {
      polling = false;
    }
  }

  async function readAndRecord() {
    let reading;
    try {
      reading = parseMeters(await client.readMeters());
    } catch (err) {
      consecutiveErrors++;
      if (consecutiveErrors === 1 || consecutiveErrors % 30 === 0) logger?.warn(`Powerbox read failed: ${err.message}`);
      await setReachable(false, err.message);
      if (consecutiveErrors === 3) schedulePolling(); // slow down
      return;
    }
    if (consecutiveErrors >= 3) {
      consecutiveErrors = 0;
      schedulePolling(); // back to the normal pace
    }
    consecutiveErrors = 0;
    const { changed } = ledger.apply(reading, now(), {
      onReset: () => logger?.warn("A Powerbox energy counter went back: counting again from the new value"),
    });
    dirty = true; // the last reading moved, even without a change of the totals
    const pluggedChanged = borne.plugged !== reading.plugged;
    borne.plugged = reading.plugged;
    await setReachable(true);
    await publish({
      power: reading.powerW,
      plugged: reading.plugged,
      charged_total: reading.chargedWh === null ? null : round(reading.chargedWh / 1000, 3),
      injected_total: reading.injectedWh === null ? null : round(reading.injectedWh / 1000, 3),
    });
    await save();
    if (changed || pluggedChanged) gladys.requestWidgetRefresh(WIDGET_KEY);
  }

  function schedulePolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
    if (!client) return;
    const seconds = consecutiveErrors >= 3 ? Math.max(ERROR_POLL_SECONDS, settings.pollSeconds) : settings.pollSeconds;
    pollTimer = setInterval(() => pollOnce(), seconds * 1000);
  }

  // --- Tariff grid -----------------------------------------------------------

  async function refreshGrid() {
    const result = await fetchGrid({ logger });
    if (!result) return false;
    const changed = JSON.stringify(result.grid) !== JSON.stringify(fetched?.grid);
    fetched = { ...result, fetchedAt: now().toISOString() };
    try {
      await saveJson(gridFile, fetched);
    } catch (err) {
      logger?.warn(`Could not save the tariff grid: ${err.message}`);
    }
    if (changed) {
      logger?.info(`Mobilize tariff grid ${result.grid.label ?? ""} read: ${result.grid.pricePerKwh} €/kWh, ${result.grid.v2gHourRate} €/V2G Hour`);
      await publish();
      gladys.requestWidgetRefresh(WIDGET_KEY);
    }
    return true;
  }

  function scheduleGrid() {
    if (gridTimer) clearInterval(gridTimer);
    gridTimer = null;
    if (!settings.autoTariffs) return;
    const age = fetched?.fetchedAt ? now().getTime() - Date.parse(fetched.fetchedAt) : Infinity;
    if (!(age < GRID_REFRESH_MS)) refreshGrid();
    gridTimer = setInterval(() => refreshGrid(), GRID_REFRESH_MS);
  }

  // --- Settings ----------------------------------------------------------------

  async function applySettings(config) {
    settings = readSettings(config);
    borne.configured = Boolean(settings.host && settings.password);
    client = borne.configured ? createPowerboxClient(settings) : null;
    consecutiveErrors = 0;
    if (!client) {
      borne.reachable = null;
      logger?.warn("Powerbox address or password missing in the settings: nothing is read");
    }
    schedulePolling();
    scheduleGrid();
    await publish();
    if (client) await pollOnce();
  }

  // --- Official V2G hours ------------------------------------------------------

  function recordOfficialHours({ month, hours, clear }) {
    const allowed = [monthKey(now()), previousMonth(monthKey(now()))];
    if (!allowed.includes(month)) throw new Error("Unknown month");
    const label = { en: monthLabel(month, "en"), fr: monthLabel(month, "fr") };
    if (clear === true || clear === "true") {
      ledger.setOfficialHours(month, null);
      return { en: `${label.en}: back to the estimate`, fr: `${label.fr} : retour à l'estimation` };
    }
    const n = Number(String(hours ?? "").replace(",", "."));
    if (!Number.isFinite(n) || n < 0 || n > 744) {
      return { en: "Enter the V2G hours of the month", fr: "Saisissez les heures V2G du mois" };
    }
    ledger.setOfficialHours(month, n);
    return { en: `${label.en}: ${n} official V2G hours`, fr: `${label.fr} : ${n} heures V2G officielles` };
  }

  async function afterOfficialHours() {
    dirty = true;
    await save(true);
    await publish();
  }

  // --- Handlers ------------------------------------------------------------------

  gladys.onScanRequest(async () => {
    await gladys.publishDiscoveredDevices([buildDiscoveredDevice(gladys, DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES, DEVICE_FEATURE_UNITS)]);
  });

  gladys.onDeviceCreated(async () => {
    publisher.reset(); // the new features get every value at once
    await publish();
  });

  gladys.onConfigUpdated(async (config) => {
    await applySettings(config);
    gladys.requestWidgetRefresh(WIDGET_KEY);
  });

  gladys.onWidgetGet(WIDGET_KEY, async ({ settings: widgetSettings, language } = {}) =>
    buildWidgetContent({ period: widgetSettings?.period, language, now: now(), ledger, tariffs: tariffs(), borne }),
  );

  gladys.onWidgetAction(WIDGET_KEY, async (actionKey, _params, { values } = {}) => {
    if (actionKey !== OFFICIAL_HOURS_ACTION) return undefined;
    // an older Gladys drops the form and sends the action without values
    if (!values) return { en: "This Gladys version cannot show the form", fr: "Cette version de Gladys n'affiche pas le formulaire" };
    const message = recordOfficialHours(values);
    await afterOfficialHours();
    return message;
  });

  // Same entry from the Configuration screen, for a Gladys without widget forms.
  gladys.onAction(OFFICIAL_HOURS_ACTION, async (fields) => {
    const month = String(fields.month ?? "").trim() || monthKey(now());
    const message = recordOfficialHours({ month, hours: fields.hours, clear: fields.clear });
    await afterOfficialHours();
    gladys.requestWidgetRefresh(WIDGET_KEY);
    return message;
  });

  gladys.onAction("test_connection", async () => {
    if (!client) return { en: "Enter the Powerbox address and password first", fr: "Renseignez d'abord l'adresse et le mot de passe de la borne" };
    try {
      const meters = await client.readMeters();
      const r = parseMeters(meters);
      const head = `charged ${r.chargedWh === null ? "?" : round(r.chargedWh / 1000, 1)} kWh, sent back ${r.injectedWh === null ? "?" : round(r.injectedWh / 1000, 1)} kWh, plugged ${r.plugged ?? "?"}`;
      return { en: `OK: ${head}. Meters: ${describeMeters(meters, 700)}`, fr: `OK : ${head}. Compteurs : ${describeMeters(meters, 700)}` };
    } catch (err) {
      return { en: `Failed: ${err.message}`, fr: `Échec : ${err.message}` };
    }
  });

  gladys.onAction("refresh_tariffs", async () => {
    const ok = await refreshGrid();
    const t = tariffs();
    const summary = `${t.pricePerKwh} €/kWh, ${t.v2gHourRate} €/h, ${t.subscriptionAnnual} €/an (${t.subscribedPower} kVA)`;
    return ok
      ? { en: `Grid ${fetched.grid.label ?? ""} read. Used: ${summary}`, fr: `Grille ${fetched.grid.label ?? ""} lue. Tarifs utilisés : ${summary}` }
      : { en: `The grid could not be read; used: ${summary}`, fr: `Grille illisible pour l'instant ; tarifs utilisés : ${summary}` };
  });

  // --- Lifecycle -----------------------------------------------------------------

  async function stop() {
    if (pollTimer) clearInterval(pollTimer);
    if (gridTimer) clearInterval(gridTimer);
    pollTimer = gridTimer = null;
    await save(true);
  }

  gladys.handleShutdown(stop);

  return {
    async start() {
      ledger = await loadLedger(ledgerFile, { logger });
      await loadGridCache();
      await gladys.connect();
      await applySettings(await gladys.getConfig());
    },
    stop,
    pollOnce,
    refreshGrid,
    get ledger() {
      return ledger;
    },
  };
}
