import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import mqtt, { type MqttClient } from "mqtt";
import type { ServiceConfig } from "./config.js";
import {
  brokerAuthenticatedIdentity,
  topicDevice,
  StaleDeviceContextError,
  type IngestionService,
  type MqttEnvelope,
  type TelemetryOutcome,
  type TrustedTelemetryBatch,
} from "./domain.js";

let cachedToken: { value: string; expiresAt: number } | undefined;

async function serviceToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 10_000)
    return cachedToken.value;
  const issuer =
    process.env.KEYCLOAK_ISSUER ?? "http://keycloak:8080/realms/algaguard";
  const secret = process.env.SERVICE_CLIENT_SECRET;
  if (!secret) throw new Error("SERVICE_CLIENT_SECRET is required");
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id:
        process.env.SERVICE_CLIENT_ID ?? "algaguard-mqtt-ingestion-service",
      client_secret: secret,
    }),
  });
  if (!response.ok) throw new Error("Service authentication failed");
  const body = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!body.access_token) throw new Error("Service token response invalid");
  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + (body.expires_in ?? 30) * 1000,
  };
  return cachedToken.value;
}

export async function forwardTelemetry(
  batch: TrustedTelemetryBatch,
  onRetry: () => void = () => {},
): Promise<TelemetryOutcome> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(
        `${process.env.TELEMETRY_SERVICE_URL ?? "http://telemetry-service:3000"}/v1/ingestion/batches`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${await serviceToken()}`,
            "x-correlation-id": batch.correlationId,
          },
          body: JSON.stringify(batch),
        },
      );
      if (response.ok) return (await response.json()) as TelemetryOutcome;
      if (response.status === 409) throw new StaleDeviceContextError();
      lastError = new Error(`Telemetry rejected batch with ${response.status}`);
      if (response.status < 500) throw lastError;
    } catch (error) {
      if (error instanceof StaleDeviceContextError) throw error;
      lastError = error;
    }
    if (attempt < 2) {
      onRetry();
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Telemetry durable commit failed");
}

function acknowledgement(envelope: MqttEnvelope, outcome: TelemetryOutcome) {
  return {
    schema: "urn:algaguard:schema:mqtt:telemetry-ack:v1",
    schemaVersion: "1.0.0",
    messageId: randomUUID(),
    deviceId: envelope.deviceId,
    sentAt: new Date().toISOString(),
    correlationId: envelope.correlationId ?? envelope.messageId,
    payload: {
      ackId: randomUUID(),
      batchId: envelope.payload.batchId,
      status: outcome.status,
      acceptedThroughSequence: outcome.acceptedThroughSequence,
      receivedAt: outcome.receivedAt,
      duplicate: outcome.duplicate,
      ...(outcome.rejectedSequences
        ? { rejectedSequences: outcome.rejectedSequences }
        : {}),
      ...(outcome.errors ? { errors: outcome.errors } : {}),
    },
  };
}

export async function startMqttIngestion(
  service: IngestionService,
  config: ServiceConfig,
): Promise<MqttClient | undefined> {
  const url = config.MQTT_URL;
  if (!url) return undefined;
  const [ca, cert, key] = await Promise.all([
    readFile(config.MQTT_CA_PATH!),
    readFile(config.MQTT_CERTIFICATE_PATH!),
    readFile(config.MQTT_PRIVATE_KEY_PATH!),
  ]);
  const client = await mqtt.connectAsync(url, {
    clientId: config.MQTT_CLIENT_ID,
    ca,
    cert,
    key,
    servername: config.MQTT_SERVER_NAME!,
    rejectUnauthorized: true,
    protocolVersion: 5,
    clean: false,
    keepalive: config.MQTT_KEEPALIVE_SECONDS,
    reconnectPeriod: config.MQTT_RECONNECT_DELAY_MS,
    queueQoSZero: false,
    properties: {
      maximumPacketSize: config.MQTT_MAX_PACKET_BYTES,
      receiveMaximum: config.MQTT_QOS1_INFLIGHT,
      sessionExpiryInterval: config.MQTT_SESSION_EXPIRY_SECONDS,
    },
  });
  await client.subscribeAsync("algaguard/v1/devices/+/telemetry", { qos: 1 });
  let rateWindowStarted = Date.now();
  let messagesInWindow = 0;
  client.on("message", (topic, bytes) => {
    void (async () => {
      try {
        if (Date.now() - rateWindowStarted >= 1000) {
          rateWindowStarted = Date.now();
          messagesInWindow = 0;
        }
        messagesInWindow += 1;
        if (messagesInWindow > config.MQTT_MAX_MESSAGES_PER_SECOND) {
          service.metrics.increment("rate_limited");
          return;
        }
        if (bytes.length > config.MQTT_MAX_PACKET_BYTES) {
          service.metrics.increment("rejected");
          return;
        }
        const envelope = JSON.parse(bytes.toString()) as unknown;
        // This subscriber is the sole process boundary that can construct the
        // broker-authenticated identity. EMQX mTLS and ACL tests prove the topic binding.
        const identity = brokerAuthenticatedIdentity(topicDevice(topic) ?? "");
        const result = await service.ingest(
          topic,
          envelope,
          identity,
          forwardTelemetry,
        );
        if (result.status === "REJECTED" && "reason" in result) return;
        const parsed = envelope as MqttEnvelope;
        await client.publishAsync(
          `algaguard/v1/devices/${parsed.deviceId}/telemetry/ack`,
          JSON.stringify(acknowledgement(parsed, result.outcome)),
          { qos: 1, retain: false },
        );
      } catch (error) {
        process.stderr.write(
          `${JSON.stringify({
            level: "error",
            component: "mqtt-ingestion",
            message: error instanceof Error ? error.message : "unknown error",
          })}\n`,
        );
      }
    })();
  });
  return client;
}
