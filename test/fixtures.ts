import type { TelemetryOutcome } from "../src/domain.js";

export const envelope = {
  schema: "urn:algaguard:schema:mqtt:telemetry-batch:v1" as const,
  schemaVersion: "1.0.0" as const,
  messageId: "10000000-0000-4000-8000-000000000001",
  deviceId: "AG-000001",
  sentAt: "2026-07-22T10:00:10Z",
  payload: {
    batchId: "20000000-0000-4000-8000-000000000001",
    firstSequence: "1",
    lastSequence: "1",
    sampleCount: 1,
    activeProfile: {
      profileId: "30000000-0000-4000-8000-000000000001",
      profileVersion: "1.0.0",
    },
    samples: [
      {
        sequence: "1",
        observedAt: "2026-07-22T10:00:09Z",
        timestampQuality: "NTP_SYNCED" as const,
        uptimeMs: "1000",
        values: { temperatureC: 24.1, ph: 7.2 },
      },
    ],
    isReplay: false,
    createdFromSd: false,
  },
};

export const acceptedOutcome: TelemetryOutcome = {
  batchId: envelope.payload.batchId,
  deviceId: envelope.deviceId,
  status: "ACCEPTED",
  acceptedThroughSequence: "1",
  duplicate: false,
  storedSamples: 1,
  receivedAt: "2026-07-22T10:00:11Z",
};

export const activeContext = {
  schema: "urn:algaguard:schema:internal:device-context:v1" as const,
  schemaVersion: "1.0.0" as const,
  deviceUuid: "40000000-0000-4000-8000-000000000001",
  deviceId: envelope.deviceId,
  organizationId: "50000000-0000-4000-8000-000000000001",
  status: "ACTIVE" as const,
  ownershipVersion: "1",
  resolvedAt: "2026-07-22T10:00:10Z",
  contextVersion: "1",
};
