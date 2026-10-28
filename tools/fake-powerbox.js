// A simulated Mobilize Powerbox Verso: the three local API endpoints the
// integration reads, over plain HTTP.
//
//   npm run fake-powerbox                 -> http://localhost:8443, password "test"
//   PORT=9000 PASSWORD=secret SPEED=60 npm run fake-powerbox
//
// Then set the Powerbox address of the integration to http://<this machine>:8443
// (a full http:// URL is accepted for the simulator; the real borne is HTTPS).
//
// Standalone, it plays a loop: unplugged, charging at 7.4 kW, sending back
// to the grid at 3.6 kW (V2G), plugged and idle. SPEED multiplies the
// energies (60 = one real second counts as a minute of charge). The tests
// drive it by hand with setState() instead.

import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const meter = (Model, connected, values) => ({
  Model,
  Connected: connected ? "true" : "false",
  ID: Model === "Power Board Meter" ? 1 : Model === "TiC" ? 2 : 0,
  Manufacturer: "Simulator",
  Serial: "SIM-0001",
  Values: Object.entries(values).map(([Name, Value]) => ({ Name, Value, Timestamp: Math.floor(Date.now() / 1000) })),
});

export function startFakePowerbox({ port = 0, password = "test", username = "installer" } = {}) {
  // cablePlugged: the cable stays in the T2S socket without any car (the session
  // meter then still says "Connected", as on a real Verso)
  const state = { plugged: false, cablePlugged: true, statusAvailable: true, powerW: 0, chargedWs: 1_000 * 3600 * 1000, injectedWs: 0, sessionWs: 0 };
  const tokens = new Set();
  const calls = { auth: 0, meters: 0, configs: 0, status: 0 };
  let failNext = 0; // answer HTTP 503 to the next n requests (the real borne does)

  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    if (failNext > 0) {
      failNext--;
      send(503, { error: "busy" });
      return;
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/v1.0/auth") {
        calls.auth++;
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        } catch {
          send(400, { error: "bad json" });
          return;
        }
        if (body.username !== username || body.password !== password) {
          send(401, { error: "unauthorized" });
          return;
        }
        const token = crypto.randomBytes(16).toString("hex");
        tokens.add(token);
        send(200, { id_token: token });
        return;
      }
      const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!tokens.has(token)) {
        send(401, { error: "unauthorized" });
        return;
      }
      if (req.method === "GET" && req.url === "/v1.0/meters") {
        calls.meters++;
        send(200, [
          meter("EVPLCCom-Virtual-Meter", true, {
            Current_mA: Math.round((Math.abs(state.powerW) / 230) * 1000),
            Voltage_mV: 230_000,
            ActivePower_W: state.powerW,
            SessionTotalEnergy_Ws: state.sessionWs,
          }),
          meter("Power Board Meter", true, {
            ActiveEnergy_Ws: state.chargedWs,
            ActiveEnergyNegative_Ws: state.injectedWs,
            ReactivePower_var: 0,
            ApparentPower_VA: Math.abs(state.powerW),
            PowerFactor: 1,
          }),
          meter("TiC", true, { Current_PhaseA_mA: 4_000, ApparentPower_VA: 920 }),
        ]);
        return;
      }
      if (req.method === "GET" && req.url.startsWith("/v1.0/status/")) {
        calls.status++;
        if (!state.statusAvailable) {
          send(404, { error: "not found" });
          return;
        }
        // pilot: A = no car, B = car connected, C = car connected and charging (or V2G)
        const pilot = !state.plugged ? "A1" : state.powerW !== 0 ? "C2" : "B2";
        if (req.url === "/v1.0/status/chargingmodule") {
          send(200, { basic: { CP: pilot, PP: state.cablePlugged ? "32A" : "NoCable" }, states: { Operational: "Operative" } });
          return;
        }
        if (req.url === "/v1.0/status/custominfo") {
          send(200, {
            ActiveSocket: "M3",
            M3: {
              state: pilot.charAt(0),
              CableState: state.cablePlugged ? "Plugged" : "Unplugged",
              ChargingState: state.powerW !== 0 ? "Charging" : "NoCharging",
              SocketLock: state.cablePlugged ? "Locked" : "Unlocked",
            },
          });
          return;
        }
      }
      if (req.method === "GET" && req.url === "/v1.0/configs") {
        calls.configs++;
        send(200, [
          { module_name: "V2GContracts", config_name: "CurrentSet", config_value: "MobilizePower" },
          { module_name: "ChargerApp", config_name: "ACCharging.maxCurrent_mA", config_value: "32000" },
        ]);
        return;
      }
      send(404, { error: "not found" });
    });
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      const { port: actual } = server.address();
      resolve({
        url: `http://127.0.0.1:${actual}`,
        state,
        calls,
        /** Partial update, e.g. { plugged: true, powerW: 7400 }. */
        setState(patch) {
          Object.assign(state, patch);
        },
        /** Adds energy as the borne's counters would: +charged, -injected, in Wh. */
        addEnergy({ chargedWh = 0, injectedWh = 0 }) {
          state.chargedWs += chargedWh * 3600;
          state.injectedWs += injectedWh * 3600;
          state.sessionWs += (chargedWh + injectedWh) * 3600;
        },
        failNextRequests(n) {
          failNext = n;
        },
        expireTokens() {
          tokens.clear();
        },
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

// --- Standalone loop -------------------------------------------------------

const PHASES = [
  { name: "unplugged", seconds: 60, plugged: false, powerW: 0 },
  { name: "charging", seconds: 120, plugged: true, powerW: 7400 },
  { name: "V2G discharge", seconds: 90, plugged: true, powerW: -3600 },
  { name: "plugged, idle", seconds: 90, plugged: true, powerW: 0 },
];

async function main() {
  const port = Number(process.env.PORT ?? 8443);
  const speed = Number(process.env.SPEED ?? 60);
  const fake = await startFakePowerbox({ port, password: process.env.PASSWORD ?? "test" });
  console.log(`Fake Powerbox on http://0.0.0.0:${port} (user "installer", password "${process.env.PASSWORD ?? "test"}")`);
  let phase = 0;
  let left = PHASES[0].seconds;
  const apply = () => {
    const p = PHASES[phase];
    if (!p.plugged) fake.setState({ sessionWs: 0 });
    fake.setState({ plugged: p.plugged, powerW: p.powerW });
    console.log(`${new Date().toISOString()} ${p.name}`);
  };
  apply();
  setInterval(() => {
    const wh = (Math.abs(fake.state.powerW) * speed) / 3600; // energy of one simulated second x speed
    if (fake.state.powerW > 0) fake.addEnergy({ chargedWh: wh });
    if (fake.state.powerW < 0) fake.addEnergy({ injectedWh: wh });
    if (--left <= 0) {
      phase = (phase + 1) % PHASES.length;
      left = PHASES[phase].seconds;
      apply();
    }
  }, 1000);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
