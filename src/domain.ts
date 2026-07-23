import { telemetryEnvelopeSchema } from "./validation.js";

export type MqttEnvelope = ReturnType<typeof telemetryEnvelopeSchema.parse>;
export interface DeviceContext {
  schema: "urn:algaguard:schema:internal:device-context:v1";
  schemaVersion: "1.0.0";
  deviceUuid: string;
  deviceId: string;
  organizationId: string;
  status: "ACTIVE";
  ownershipVersion: string;
  resolvedAt: string;
  tankId?: string | undefined;
  contextVersion?: string | undefined;
}
export type DeviceContextResolver = (
  deviceId: string,
) => Promise<DeviceContext>;
export interface TrustedTelemetryBatch {
  batchId: string;
  deviceUuid: string;
  deviceId: string;
  organizationId: string;
  ownershipVersion: string;
  correlationId: string;
  activeProfile: MqttEnvelope["payload"]["activeProfile"];
  samples: MqttEnvelope["payload"]["samples"];
}
export class DeviceContextError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export class StaleDeviceContextError extends Error {
  constructor() {
    super("STALE_DEVICE_CONTEXT");
  }
}
export interface TelemetryOutcome {
  batchId: string;
  deviceId: string;
  status: "ACCEPTED" | "PARTIALLY_ACCEPTED" | "REJECTED" | "DUPLICATE";
  acceptedThroughSequence: string | null;
  duplicate: boolean;
  storedSamples: number;
  rejectedSequences?: string[];
  errors?: Array<{
    code: string;
    message: string;
    retryable: boolean;
    path?: string;
  }>;
  receivedAt: string;
}
export interface IngestionRecord {
  messageId: string;
  deviceId: string;
  topic: string;
  batchId: string;
  outcome: TelemetryOutcome;
  acceptedAt: string;
}
export interface IngestionRepository {
  find(messageId: string): Promise<IngestionRecord | undefined>;
  record(value: Omit<IngestionRecord, "acceptedAt">): Promise<IngestionRecord>;
  health(): Promise<void>;
  close(): Promise<void>;
}

export function topicDevice(topic: string) {
  return /^algaguard\/v1\/devices\/(?<deviceId>AG-[0-9]{6})\/telemetry$/.exec(
    topic,
  )?.groups?.deviceId;
}

export class Metrics {
  private values = {
    accepted: 0,
    rejected: 0,
    duplicate: 0,
    retry: 0,
    context_resolved: 0,
    context_rejected: 0,
  };

  increment(name: keyof Metrics["values"]) {
    this.values[name] += 1;
  }

  render() {
    return `${Object.entries(this.values)
      .map(([name, value]) => `algaguard_ingestion_${name}_total ${value}`)
      .join("\n")}\n`;
  }
}

export class IngestionService {
  constructor(
    private readonly repository: IngestionRepository,
    private readonly resolveDeviceContext: DeviceContextResolver,
    readonly metrics = new Metrics(),
  ) {}

  async ingest(
    topic: string,
    input: unknown,
    authenticatedDeviceId: string,
    durableForward: (
      value: TrustedTelemetryBatch,
      onRetry: () => void,
    ) => Promise<TelemetryOutcome>,
  ) {
    const supplied = input as {
      organizationId?: unknown;
      payload?: { organizationId?: unknown };
    } | null;
    if (
      supplied &&
      (supplied.organizationId !== undefined ||
        supplied.payload?.organizationId !== undefined)
    ) {
      this.metrics.increment("rejected");
      return {
        status: "REJECTED",
        reason: "UNTRUSTED_ORGANIZATION_CONTEXT",
      } as const;
    }
    const parsed = telemetryEnvelopeSchema.safeParse(input);
    if (!parsed.success) {
      this.metrics.increment("rejected");
      return { status: "REJECTED", reason: "INVALID_CONTRACT" } as const;
    }
    const envelope = parsed.data;
    const deviceId = topicDevice(topic);
    if (
      !deviceId ||
      deviceId !== envelope.deviceId ||
      authenticatedDeviceId !== deviceId
    ) {
      this.metrics.increment("rejected");
      return {
        status: "REJECTED",
        reason: "DEVICE_TOPIC_IDENTITY_MISMATCH",
      } as const;
    }
    let context: DeviceContext;
    try {
      context = await this.resolveDeviceContext(deviceId);
    } catch (error) {
      this.metrics.increment("context_rejected");
      this.metrics.increment("rejected");
      if (error instanceof DeviceContextError) {
        return { status: "REJECTED", reason: error.code } as const;
      }
      throw error;
    }
    if (context.deviceId !== deviceId || context.status !== "ACTIVE") {
      this.metrics.increment("context_rejected");
      this.metrics.increment("rejected");
      return {
        status: "REJECTED",
        reason: "INVALID_DEVICE_CONTEXT",
      } as const;
    }
    this.metrics.increment("context_resolved");
    const prior = await this.repository.find(envelope.messageId);
    if (prior) {
      this.metrics.increment("duplicate");
      return {
        status: "DUPLICATE",
        outcome: {
          ...prior.outcome,
          status: "DUPLICATE" as const,
          duplicate: true,
          storedSamples: 0,
        },
      } as const;
    }
    const trustedBatch = (value: DeviceContext): TrustedTelemetryBatch => ({
      batchId: envelope.payload.batchId,
      deviceUuid: value.deviceUuid,
      deviceId: value.deviceId,
      organizationId: value.organizationId,
      ownershipVersion: value.ownershipVersion,
      correlationId: envelope.correlationId ?? envelope.messageId,
      activeProfile: envelope.payload.activeProfile,
      samples: envelope.payload.samples,
    });
    const onRetry = () => this.metrics.increment("retry");
    let outcome: TelemetryOutcome;
    try {
      outcome = await durableForward(trustedBatch(context), onRetry);
    } catch (error) {
      if (!(error instanceof StaleDeviceContextError)) throw error;
      onRetry();
      context = await this.resolveDeviceContext(deviceId);
      if (context.deviceId !== deviceId || context.status !== "ACTIVE") {
        throw new DeviceContextError("INVALID_DEVICE_CONTEXT");
      }
      this.metrics.increment("context_resolved");
      outcome = await durableForward(trustedBatch(context), onRetry);
    }
    const stored = await this.repository.record({
      messageId: envelope.messageId,
      deviceId: envelope.deviceId,
      topic,
      batchId: envelope.payload.batchId,
      outcome,
    });
    this.metrics.increment(
      outcome.status === "DUPLICATE"
        ? "duplicate"
        : outcome.status === "REJECTED"
          ? "rejected"
          : "accepted",
    );
    return {
      status: outcome.status,
      outcome: stored.outcome,
      applicationAck: true,
    } as const;
  }
}

export class MemoryIngestionRepository implements IngestionRepository {
  private readonly values = new Map<string, IngestionRecord>();

  async find(id: string) {
    return structuredClone(this.values.get(id));
  }

  async record(value: Omit<IngestionRecord, "acceptedAt">) {
    const prior = this.values.get(value.messageId);
    if (prior) return structuredClone(prior);
    const stored = {
      ...structuredClone(value),
      acceptedAt: new Date().toISOString(),
    };
    this.values.set(value.messageId, stored);
    return stored;
  }

  async health() {}
  async close() {}
}
