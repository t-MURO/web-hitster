import { createApplication } from "./create-app.js";

const { httpServer, config } = await createApplication();

httpServer.listen(config.port, "0.0.0.0", () => {
  console.log(`Music Timeline is listening on ${config.publicBaseUrl}`);
});
