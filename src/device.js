// The Gladys device: live values of the borne, and the balance of today and
// of the current month. The year is shown by the widget only.
//
// Category / type / unit names checked against
// @gladysassistant/integration-sdk 0.15.0 (the fake Gladys of its testing
// module refuses unknown ones). Feature keys are forever: a renamed key is a
// removed feature for every user.

export const DEVICE_TYPE = "v2g_charger";
export const PLATFORM_ID = "powerbox-verso";
export const PERIODS = ["day", "month"];

const PERIOD_NAMES = { day: "aujourd'hui", month: "ce mois" };

// The kWh features avoid the energy-sensor "energy"/"index" types on purpose:
// Gladys treats those as meter indexes and adds a "(consumption)" and a
// "(cost)" feature to each of them, priced with the house contract — a
// duplicate of this integration's own costs. The charged energy is an
// electric-vehicle charge total, the energy sent back a battery discharge
// index: no derived feature for either.
export function buildFeatureDefinitions(C, T, U) {
  const charged = { category: C.ELECTRICAL_VEHICLE_CHARGE, type: T.ELECTRICAL_VEHICLE_CHARGE.CHARGE_ENERGY_CONSUMPTION_TOTAL, unit: U.KILOWATT_HOUR, min: 0, max: 10_000_000 };
  const injected = { category: C.BATTERY_STORAGE, type: T.BATTERY_STORAGE.DISCHARGE_INDEX, unit: U.KILOWATT_HOUR, min: 0, max: 10_000_000 };
  const euro = { category: C.CURRENCY, type: T.CURRENCY.DECIMAL, unit: U.EURO, min: -100_000, max: 100_000 };
  const live = [
    { key: "power", name: "Puissance borne", category: C.ENERGY_SENSOR, type: T.ENERGY_SENSOR.POWER, unit: U.WATT, min: -22_000, max: 22_000 },
    { key: "plugged", name: "Voiture branchée", category: C.ELECTRICAL_VEHICLE_CHARGE, type: T.ELECTRICAL_VEHICLE_CHARGE.PLUGGED, min: 0, max: 1 },
    { key: "charged_total", name: "Énergie chargée (compteur borne)", ...charged },
    { key: "injected_total", name: "Énergie renvoyée (compteur borne)", ...injected },
  ];
  const periods = PERIODS.flatMap((p) => [
    { key: `${p}_charged`, name: `Énergie chargée ${PERIOD_NAMES[p]}`, ...charged },
    { key: `${p}_injected`, name: `Énergie renvoyée ${PERIOD_NAMES[p]}`, ...injected },
    { key: `${p}_v2g_hours`, name: `Heures V2G ${PERIOD_NAMES[p]}`, category: C.DURATION, type: T.DURATION.DECIMAL, unit: U.HOURS, min: 0, max: 10_000 },
    { key: `${p}_charge_cost`, name: `Coût recharge ${PERIOD_NAMES[p]}`, ...euro },
    { key: `${p}_subscription`, name: `Abonnement ${PERIOD_NAMES[p]}`, ...euro },
    { key: `${p}_v2g_bonus`, name: `Bonus V2G ${PERIOD_NAMES[p]}`, ...euro },
    { key: `${p}_injection_credit`, name: `Rachat énergie renvoyée ${PERIOD_NAMES[p]}`, ...euro },
    { key: `${p}_balance`, name: `Bilan V2G ${PERIOD_NAMES[p]}`, ...euro },
  ]);
  return [...live, ...periods];
}

export function buildDiscoveredDevice(gladys, C, T, U) {
  const ids = gladys.externalIds(DEVICE_TYPE, PLATFORM_ID);
  const features = buildFeatureDefinitions(C, T, U).map((def) => ({
    name: def.name,
    external_id: ids.feature(def.key),
    category: def.category,
    type: def.type,
    unit: def.unit ?? null,
    min: def.min,
    max: def.max,
    read_only: true,
    has_feedback: false,
    keep_history: true,
  }));
  return { name: "Mobilize Power V2G", external_id: ids.device, features };
}
