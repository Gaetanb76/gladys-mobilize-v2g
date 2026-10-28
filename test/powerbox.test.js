import { test } from "node:test";
import assert from "node:assert/strict";
import { createPowerboxClient, parseMeters, parseStatus, describeMeters, apiBaseUrl } from "../src/powerbox.js";
import { startFakePowerbox } from "../tools/fake-powerbox.js";

test("base URL: bare address is HTTPS, a simulator URL is kept", () => {
  assert.equal(apiBaseUrl("192.168.1.50"), "https://192.168.1.50/v1.0");
  assert.equal(apiBaseUrl(" http://localhost:8443/ "), "http://localhost:8443/v1.0");
  assert.throws(() => apiBaseUrl(""), /No Powerbox address/);
});

test("logs in, reads and parses the meters", async (t) => {
  const fake = await startFakePowerbox();
  t.after(() => fake.close());
  fake.setState({ plugged: true, powerW: 7400 });
  fake.addEnergy({ chargedWh: 1500, injectedWh: 250 });

  const client = createPowerboxClient({ host: fake.url, password: "test" });
  const reading = parseMeters(await client.readMeters());
  assert.equal(reading.chargedWh, 1_000_000 + 1500);
  assert.equal(reading.injectedWh, 250);
  assert.equal(parseStatus(await client.readStatus()).vehicleConnected, true);
  assert.equal(reading.powerW, 7400);
  assert.equal(reading.sessionWh, 1750);
  assert.equal(fake.calls.auth, 1);

  await client.readMeters();
  assert.equal(fake.calls.auth, 1, "the token is reused");
});

test("logs in again once when the token expired", async (t) => {
  const fake = await startFakePowerbox();
  t.after(() => fake.close());
  const client = createPowerboxClient({ host: fake.url, password: "test" });
  await client.readMeters();
  fake.expireTokens();
  await client.readMeters();
  assert.equal(fake.calls.auth, 2);
  assert.equal(fake.calls.meters, 2);
});

test("a wrong password is a clear error that never shows the password", async (t) => {
  const fake = await startFakePowerbox();
  t.after(() => fake.close());
  const client = createPowerboxClient({ host: fake.url, password: "s3cr3t-wrong" });
  await assert.rejects(client.readMeters(), (err) => {
    assert.match(err.message, /refused the login/);
    assert.doesNotMatch(err.message, /s3cr3t/);
    return true;
  });
});

test("a busy borne (503) and an unreachable one are errors, not crashes", async (t) => {
  const fake = await startFakePowerbox();
  const client = createPowerboxClient({ host: fake.url, password: "test" });
  fake.failNextRequests(1);
  await assert.rejects(client.readMeters(), /HTTP 503/);
  await client.readMeters(); // recovers
  await fake.close();
  await assert.rejects(client.readMeters(), /unreachable/);
  t.diagnostic("closed borne rejected as expected");
});

test("a session meter that is not connected: no session power", () => {
  const reading = parseMeters([
    { Model: "EVPLCCom-Virtual-Meter", Connected: "false", Values: [{ Name: "ActivePower_W", Value: 12 }] },
    { Model: "Power Board Meter", Connected: "true", Values: [{ Name: "ActiveEnergy_Ws", Value: "36000" }] },
  ]);
  assert.deepEqual(reading, { chargedWh: 10, injectedWh: null, powerW: 0, sessionWh: null });
});

test("garbage meters parse to nulls", () => {
  assert.deepEqual(parseMeters(null), { chargedWh: null, injectedWh: null, powerW: 0, sessionWh: null });
  assert.equal(describeMeters("nope"), "no meter");
});

test("describeMeters lists models and value names", () => {
  const text = describeMeters([{ Model: "TiC", Connected: "true", Values: [{ Name: "ApparentPower_VA", Value: 920 }] }]);
  assert.equal(text, "TiC (connected): ApparentPower_VA=920");
});

test("the car is read on the pilot, not on a cable left in the socket", () => {
  const status = (CP, CableState) => ({ chargingmodule: { basic: { CP } }, custominfo: { ActiveSocket: "M3", M3: { CableState } } });
  assert.equal(parseStatus(status("A1", "Plugged")).vehicleConnected, false); // cable in the borne, no car
  assert.equal(parseStatus(status("B2", "Plugged")).vehicleConnected, true);
  assert.equal(parseStatus(status("C2", "Plugged")).vehicleConnected, true);
  assert.equal(parseStatus(status("F", "Plugged")).vehicleConnected, false); // error state
  // no CP in the charging module: the socket's own state
  assert.equal(parseStatus({ custominfo: { M3: { state: "B" } } }).vehicleConnected, true);
  assert.deepEqual(parseStatus(null), { vehicleConnected: null, pilot: null, cableState: null, chargingState: null });
});
