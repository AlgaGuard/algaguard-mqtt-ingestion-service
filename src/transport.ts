import { randomUUID } from "node:crypto";
import mqtt, { type MqttClient } from "mqtt";
import { IngestionService, type MqttEnvelope } from "./domain.js";

export async function forwardTelemetry(envelope: MqttEnvelope) {
  const payload = envelope.payload as {
    batchId?: unknown;
    samples?: unknown;
  };
  const response = await fetch(
    `${process.env.TELEMETRY_SERVICE_URL ?? "http://telemetry-service:3000"}/v1/ingestion/batches`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        batchId: payload.batchId,
        deviceId: envelope.deviceId,
        samples: payload.samples,
      }),
    },
  );
  if (!response.ok) {
    throw new Error(`Telemetry durable commit failed with ${response.status}`);
  }
}

function acknowledgement(envelope: MqttEnvelope, duplicate: boolean) {
  const payload = envelope.payload as {
    batchId?: string;
    lastSequence?: string;
  };
  return {
    schema: "urn:algaguard:schema:mqtt:telemetry-ack:v1",
    schemaVersion: "1.0.0",
    messageId: randomUUID(),
    deviceId: envelope.deviceId,
    sentAt: new Date().toISOString(),
    correlationId: envelope.messageId,
    payload: {
      ackId: randomUUID(),
      batchId: payload.batchId,
      status: "ACCEPTED",
      acceptedThroughSequence: payload.lastSequence,
      receivedAt: new Date().toISOString(),
      duplicate,
    },
  };
}

export async function startMqttIngestion(
  service = new IngestionService(),
): Promise<MqttClient | undefined> {
  const url = process.env.MQTT_URL;
  if (!url) return undefined;
  const options = {
    clientId: `algaguard-ingestion-${randomUUID()}`,
    username: "development-ingestion",
    clean: true,
    reconnectPeriod: 2_000,
  };
  const client = await mqtt.connectAsync(url, options);
  await client.subscribeAsync("algaguard/v1/devices/#", { qos: 1 });
  client.on("message", (topic, bytes) => {
    if (!topic.endsWith("/telemetry")) return;
    void (async () => {
      try {
        const envelope = JSON.parse(bytes.toString()) as MqttEnvelope;
        const result = await service.ingest(topic, envelope, forwardTelemetry);
        process.stdout.write(
          `${JSON.stringify({ level: "info", component: "mqtt-ingestion", topic, deviceId: envelope.deviceId, status: result.status })}\n`,
        );
        if (result.status === "REJECTED") return;
        await client.publishAsync(
          `algaguard/v1/devices/${envelope.deviceId}/telemetry/ack`,
          JSON.stringify(
            acknowledgement(envelope, result.status === "DUPLICATE"),
          ),
          { qos: 1, retain: false },
        );
      } catch (error) {
        process.stderr.write(
          `${JSON.stringify({ level: "error", component: "mqtt-ingestion", message: error instanceof Error ? error.message : "unknown error" })}\n`,
        );
      }
    })();
  });
  return client;
}
