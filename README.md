# gladys-mobilize-v2g

External integration for **Gladys Assistant** for the **Mobilize Power** V2G offer (Renault Group cars with a **Mobilize Powerbox Verso**): energy charged and sent back to the grid, V2G hours, charging cost, V2G Hour bonus, subscription and balance per day, month and year. End-user guide: `docs/fr.md` / `docs/en.md`.

```
Powerbox Verso --local REST API (read-only, HTTPS, installer account)--> main container (src/index.js)
mobilize-v2g.fr --tariff grid PDF, once a day--------------------------> main container
                                                                          -> Gladys (states + "V2G balance" widget)
```

- `src/powerbox.js` read-only client of the borne's local API (`/v1.0/auth`, `/v1.0/meters`); never writes to the borne.
- `src/ledger.js` day-by-day record built from the borne's cumulative counters; V2G hours estimated from the plug-in time; persisted in `/data/ledger.json`.
- `src/tariffs.js` + `src/mobilizeGrid.js` the tariff grid (built-in August 2026 grid, the PDF read from mobilize-v2g.fr, manual values first).
- `src/balance.js` charge cost + subscription − V2G bonus − buyback of the energy sent back.
- `src/device.js`, `src/widget.js`, `src/app.js` Gladys device, widget, wiring.
- `tools/fake-powerbox.js` a simulated Powerbox (HTTP) for tests and manual runs.

The local API is not documented by Mobilize; the endpoints and meter names come from the community: [forum HACF](https://forum.hacf.fr/t/interfacer-home-assistant-avec-la-borne-mobilize-powerbox-uno/56726) and [ha-mobilize-powerbox](https://github.com/MisterMonk3y/ha-mobilize-powerbox). Mobilize removed the choice of the OCPP server in 2026, so OCPP is not an option.

## Develop

```bash
npm install
npm test
npm run fake-powerbox   # http://localhost:8443, user "installer", password "test"
```

In Gladys' developer mode, set the Powerbox address to `http://<your machine>:8443` to use the simulator (a full `http://` URL is accepted for it; a bare IP means HTTPS, as on the real borne).

Validate before release: `npx github:GladysAssistant/integration-store .`

## To check on a real Powerbox Verso

- The "car plugged in" signal: the `Connected` flag of the `EVPLCCom-Virtual-Meter` meter is the current guess. The **Test the connection** button of the integration lists every meter and value.
- The sign of `ActivePower_W` while sending energy back.
