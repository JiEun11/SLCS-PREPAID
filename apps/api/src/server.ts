import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createApp } from "./app.js";

import { createServices } from "./services.js";

if (process.env.NODE_ENV === "development") {
  const envFile = fileURLToPath(new URL("../../../.env", import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
}

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const { adminAuth, customerService } = createServices(process.env);
const app = createApp(adminAuth, customerService);
if (process.env.NODE_ENV === "production") {
  const webRoot = fileURLToPath(new URL("../../web/dist/", import.meta.url));
  app.use(express.static(webRoot));
  app.get(/^\/(?!api(?:\/|$)|assets(?:\/|$)).*/, (_request, response) => {
    response.sendFile(join(webRoot, "index.html"));
  });
}

app.listen(port, "0.0.0.0", () => {
  console.info(`SLCS PREPAID API listening on port ${port}`);
});
