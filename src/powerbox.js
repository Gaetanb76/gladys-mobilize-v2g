// Read-only client of the Mobilize Powerbox local REST API.
//
// Not documented by Mobilize: the endpoints come from the community
// (forum.hacf.fr thread 56726 and github.com/MisterMonk3y/ha-mobilize-powerbox).
//   POST /v1.0/auth   {username, password}  -> { id_token }   (the "installer"
//                                               account printed on the borne)
//   GET  /v1.0/meters  Bearer <id_token>     -> the borne's meters
//   GET  /v1.0/configs Bearer <id_token>     -> the borne's configuration
//
// The borne serves HTTPS with a self-signed certificate, so the certificate
// is not checked (local network only). This client never writes anything to
// the borne: changing its configuration wears its flash memory and could
// interfere with Mobilize's control of the V2G.
//
// The password and the token are never logged nor put in an error message.

import http from "node:http";
import https from "node:https";

const TIMEOUT_MS = 20_000;
const MAX_BODY_BYTES = 1024 * 1024;

export class PowerboxError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = "PowerboxError";
    this.status = status;
  }
}

/** "192.168.1.50" -> "https://192.168.1.50/v1.0"; a full http(s) URL (the simulator) is kept. */
export function apiBaseUrl(host) {
  const value = String(host ?? "").trim().replace(/\/+$/, "");
  if (!value) throw new PowerboxError("No Powerbox address in the settings");
  const base = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return base.endsWith("/v1.0") ? base : `${base}/v1.0`;
}

function request(method, url, { body, token } = {}) {
  const target = new URL(url);
  const lib = target.protocol === "http:" ? http : https;
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers = { accept: "application/json", connection: "close" };
  if (payload) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;

  return new Promise((resolve, reject) => {
    const req = lib.request(target, { method, headers, rejectUnauthorized: false, timeout: TIMEOUT_MS }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) req.destroy(new PowerboxError("Powerbox answer too large"));
        else chunks.push(chunk);
      });
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new PowerboxError(`Powerbox answered HTTP ${res.statusCode} on ${target.pathname}`, res.statusCode));
          return;
        }
        try {
          resolve(text ? JSON.parse(text) : null);
        } catch {
          reject(new PowerboxError(`Powerbox answered something other than JSON on ${target.pathname}`));
        }
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new PowerboxError(`Powerbox did not answer within ${TIMEOUT_MS / 1000} s`)));
    req.on("error", (err) =>
      reject(err instanceof PowerboxError ? err : new PowerboxError(`Powerbox unreachable (${err.code ?? err.message})`)),
    );
    if (payload) req.write(payload);
    req.end();
  });
}

export function createPowerboxClient({ host, username = "installer", password }) {
  const base = apiBaseUrl(host);
  let token = null;

  async function authenticate() {
    if (!password) throw new PowerboxError("No Powerbox password in the settings");
    const answer = await request("POST", `${base}/auth`, { body: { username, password } }).catch((err) => {
      if (err.status === 401 || err.status === 403) throw new PowerboxError("Powerbox refused the login: check the user and password", err.status);
      throw err;
    });
    if (!answer?.id_token) throw new PowerboxError("Powerbox login answer without a token");
    token = answer.id_token;
  }

  async function get(endpoint) {
    if (!token) await authenticate();
    try {
      return await request("GET", `${base}/${endpoint}`, { token });
    } catch (err) {
      if (err.status !== 401) throw err;
      await authenticate(); // token expired: one new login, one retry
      return request("GET", `${base}/${endpoint}`, { token });
    }
  }

  return {
    readMeters: () => get("meters"),
    readConfigs: () => get("configs"),
    forgetToken() {
      token = null;
    },
  };
}

// --- Meters --------------------------------------------------------------
// The borne returns a list of meters: { Model, Connected: "true"|"false", ID,
// Manufacturer, Serial, Values: [{ Name, Value, Timestamp }] }. Known models:
//   "Power Board Meter"       the borne's own meter: cumulative energies
//   "EVPLCCom-Virtual-Meter"  the session with the car (power, session energy)
//   "TiC"                     the Linky, read by the borne's TIC input

export const METER_BOARD = "Power Board Meter";
export const METER_SESSION = "EVPLCCom-Virtual-Meter";

function meterMap(meters) {
  const map = new Map();
  for (const meter of Array.isArray(meters) ? meters : []) {
    const values = new Map();
    for (const v of Array.isArray(meter?.Values) ? meter.Values : []) {
      const n = typeof v?.Value === "number" ? v.Value : Number(v?.Value);
      values.set(v?.Name, Number.isFinite(n) ? n : null);
    }
    map.set(meter?.Model, { connected: String(meter?.Connected).toLowerCase() === "true", values });
  }
  return map;
}

/**
 * The values the integration uses. Energies in Wh (the borne gives W·s).
 *
 * "plugged" is the Connected flag of the session meter, which talks with the
 * car over the charging cable (PLC). It is the best candidate found so far
 * for "car plugged in"; to be confirmed on a real Verso (use the "Test the
 * connection" button of the integration to see the raw meters).
 */
export function parseMeters(meters) {
  const map = meterMap(meters);
  const board = map.get(METER_BOARD);
  const session = map.get(METER_SESSION);
  const wh = (meter, name) => {
    const ws = meter?.values.get(name);
    return Number.isFinite(ws) ? ws / 3600 : null;
  };
  return {
    chargedWh: wh(board, "ActiveEnergy_Ws"),
    injectedWh: wh(board, "ActiveEnergyNegative_Ws"),
    powerW: session?.connected ? (session.values.get("ActivePower_W") ?? null) : 0,
    sessionWh: session?.connected ? wh(session, "SessionTotalEnergy_Ws") : null,
    plugged: session ? session.connected : null,
  };
}

/** A short text listing every meter and value name, for the connection test. */
export function describeMeters(meters, maxLength = 900) {
  const parts = [];
  for (const [model, meter] of meterMap(meters)) {
    const values = [...meter.values].map(([name, value]) => `${name}=${value ?? "?"}`).join(", ");
    parts.push(`${model} (${meter.connected ? "connected" : "not connected"}): ${values || "no value"}`);
  }
  const text = parts.join(" | ") || "no meter";
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
