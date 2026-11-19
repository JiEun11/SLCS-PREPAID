import { createApp } from "./app.js";

import { createServices } from "./services.js";

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const { adminAuth, customerService } = createServices(process.env);
createApp(adminAuth, customerService).listen(port, () => {
  console.info(`SLCS PREPAID API listening on port ${port}`);
});
