import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

const base = { DATABASE_URL: "postgresql://localhost/algaguard" };

test("MQTT transport limits have bounded defaults", () => {
  const config = loadConfig(base);
  assert.equal(config.HTTP_BODY_LIMIT, "256kb");
  assert.equal(config.MQTT_MAX_PACKET_BYTES, 262_144);
  assert.equal(config.MQTT_MAX_SAMPLES_PER_BATCH, 120);
  assert.equal(config.MQTT_QOS1_INFLIGHT, 32);
  assert.equal(config.MQTT_MAX_MESSAGES_PER_SECOND, 200);
});

test("configured MQTT transport requires TLS and service certificate paths", () => {
  assert.throws(() => loadConfig({ ...base, MQTT_URL: "mqtt://broker:1883" }));
  assert.throws(() => loadConfig({ ...base, MQTT_URL: "mqtts://broker:8884" }));
  assert.doesNotThrow(() =>
    loadConfig({
      ...base,
      MQTT_URL: "mqtts://broker:8884",
      MQTT_CA_PATH: "/run/pki/ca.crt",
      MQTT_CERTIFICATE_PATH: "/run/pki/ingestion.crt",
      MQTT_PRIVATE_KEY_PATH: "/run/pki/ingestion.key",
      MQTT_SERVER_NAME: "broker",
    }),
  );
  assert.throws(() =>
    loadConfig({ ...base, MQTT_MAX_PACKET_BYTES: "unlimited" }),
  );
  assert.throws(() =>
    loadConfig({ ...base, MQTT_MAX_SAMPLES_PER_BATCH: "121" }),
  );
});
