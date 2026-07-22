import { createAjv } from "./validation.js";
export interface MqttEnvelope {
  schema: string;
  schemaVersion: string;
  messageId: string;
  deviceId: string;
  payload: Record<string, unknown>;
}
export function topicDevice(topic: string) {
  return /^algaguard\/v1\/devices\/(?<deviceId>AG-[0-9]{6})\/(?:telemetry|status|command-results)$/.exec(
    topic,
  )?.groups?.deviceId;
}
export class IngestionService {
  private readonly accepted = new Set<string>();
  async ingest(
    topic: string,
    envelope: MqttEnvelope,
    durableForward: (value: MqttEnvelope) => Promise<void>,
  ) {
    const deviceId = topicDevice(topic);
    if (!deviceId || deviceId !== envelope.deviceId)
      return { status: "REJECTED", reason: "DEVICE_TOPIC_MISMATCH" } as const;
    if (!createAjv()(envelope))
      return { status: "REJECTED", reason: "INVALID_ENVELOPE" } as const;
    if (this.accepted.has(envelope.messageId))
      return { status: "DUPLICATE" } as const;
    await durableForward(envelope);
    this.accepted.add(envelope.messageId);
    return { status: "ACCEPTED", applicationAck: true } as const;
  }
}
