import { once } from "node:events";
import { createPostgresPool } from "./adapters.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { IngestionService } from "./domain.js";
import { PostgresIngestionRepository } from "./repository.js";
import { startMqttIngestion } from "./transport.js";
import { resolveDeviceContext } from "./device-context.js";

const config = loadConfig();
const repository = new PostgresIngestionRepository(createPostgresPool(config));
const service = new IngestionService(
  repository,
  resolveDeviceContext,
  undefined,
  config.MQTT_MAX_SAMPLES_PER_BATCH,
);
const server = buildApp(repository, service, config.HTTP_BODY_LIMIT).listen(
  config.PORT,
  () => {
    process.stdout.write(
      `${JSON.stringify({
        level: "info",
        service: "algaguard-mqtt-ingestion-service",
        message: "listening",
        port: config.PORT,
      })}\n`,
    );
  },
);
await once(server, "listening");
const mqttClient = await startMqttIngestion(service, config);

async function shutdown(signal: string) {
  process.stdout.write(
    `${JSON.stringify({
      level: "info",
      service: "algaguard-mqtt-ingestion-service",
      message: "shutdown",
      signal,
    })}\n`,
  );
  if (mqttClient) await mqttClient.endAsync();
  await repository.close();
  server.close((error) => process.exit(error ? 1 : 0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
