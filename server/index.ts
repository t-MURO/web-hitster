import { existsSync } from "node:fs";
import { createApplication } from "./create-app.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const { httpServer, config } = await createApplication();

httpServer.listen(config.port, "0.0.0.0", () => {
  console.log(`Music Timeline is listening on ${config.publicBaseUrl}`);
});
