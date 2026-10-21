import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseTariffGrid, resolveTariffs, DEFAULT_GRID } from "../src/tariffs.js";
import { readSettings } from "../src/settings.js";
import { findGridPdfUrl } from "../src/mobilizeGrid.js";

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

test("parses the pdf.js text of the August 2026 grid", () => {
  const grid = parseTariffGrid(fixture("grille-aout-2026.txt"));
  assert.deepEqual(grid, {
    label: "Août 2026",
    pricePerKwh: 0.1823,
    v2gHourRate: 0.1076,
    subscriptionByKva: { 3: 136.27, 6: 178.28, 9: 223.54, 12: 267.24, 15: 308.26, 18: 350.39, 24: 440.46, 30: 523.04, 36: 606.53 },
  });
});

test("parses a layout text (one table row per line)", () => {
  const text = [
    "GRILLE DE L'OFFRE MOBILIZE POWER",
    "                                 Septembre 2026",
    "3          140,00",
    "12         270,00                               0,1900",
    "36         610,00",
    "     • V2G Hour : 11 cts TTC",
  ].join("\n");
  const grid = parseTariffGrid(text);
  assert.equal(grid.label, "Septembre 2026");
  assert.equal(grid.pricePerKwh, 0.19);
  assert.equal(grid.v2gHourRate, 0.11);
  assert.deepEqual(grid.subscriptionByKva, { 3: 140, 12: 270, 36: 610 });
});

test("refuses a half-read grid", () => {
  assert.equal(parseTariffGrid(""), null);
  assert.equal(parseTariffGrid(fixture("grille-aout-2026.txt").replace("V2G Hour : 10,76 cts", "")), null);
  assert.equal(parseTariffGrid("3 136,27\n0,1823\nV2G Hour : 10,76 cts"), null);
});

test("finds the consumer grid link, not the 'petit pro' one", () => {
  const url = findGridPdfUrl(fixture("page-links.html"));
  assert.equal(
    url,
    "https://cdn-website.mobilityhouse.com/grille%20tarifaire%20(aout%202026)_e95f41052db0a6cf1a451e7ade0d6fb8.pdf",
  );
});

test("ignores grid links on unknown hosts", () => {
  assert.equal(findGridPdfUrl('<a href="https://evil.example/grille tarifaire.pdf">x</a>'), null);
  assert.equal(findGridPdfUrl('<a href="http://cdn-website.mobilityhouse.com/grille tarifaire.pdf">x</a>'), null);
});

test("manual values win over the grid, value by value", () => {
  const settings = readSettings({ subscribed_power: "6", v2g_hour_rate: "0,0633", price_kwh: "" });
  const t = resolveTariffs(settings, null);
  assert.equal(t.v2gHourRate, 0.0633);
  assert.equal(t.sources.v2gHourRate, "manual");
  assert.equal(t.pricePerKwh, DEFAULT_GRID.pricePerKwh);
  assert.equal(t.sources.pricePerKwh, "default");
  assert.equal(t.subscriptionAnnual, 178.28);
  assert.equal(t.injectedBuyback, 0);
});

test("the site grid is used only when automatic tariffs are on", () => {
  const site = { label: "Sept. 2026", pricePerKwh: 0.2, v2gHourRate: 0.12, subscriptionByKva: { 9: 230 } };
  assert.equal(resolveTariffs(readSettings({}), site).pricePerKwh, 0.2);
  assert.equal(resolveTariffs(readSettings({}), site).sources.pricePerKwh, "site");
  assert.equal(resolveTariffs(readSettings({ auto_tariffs: false }), site).pricePerKwh, DEFAULT_GRID.pricePerKwh);
  // a power missing from the site grid falls back to the default grid
  assert.equal(resolveTariffs(readSettings({ subscribed_power: "36" }), site).subscriptionAnnual, 606.53);
});
