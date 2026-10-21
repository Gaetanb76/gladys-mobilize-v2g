// Main container entrypoint. Everything lives in app.js (testable with the
// SDK's fake Gladys); this file only wires the real client.
//
// DATA_DIR overrides the record folder for a run outside Gladys.

import { GladysIntegration, logger } from "@gladysassistant/integration-sdk";
import { createApp } from "./app.js";

const app = createApp(new GladysIntegration(), { dataDir: process.env.DATA_DIR || "/data", logger });
await app.start();
