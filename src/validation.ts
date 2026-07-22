import { Ajv } from "ajv";
const schema = {
  type: "object",
  additionalProperties: true,
  required: ["schema", "schemaVersion", "messageId", "deviceId", "payload"],
  properties: {
    schema: { type: "string" },
    schemaVersion: { type: "string" },
    messageId: { type: "string", format: "uuid" },
    deviceId: { type: "string", pattern: "^AG-[0-9]{6}$" },
    payload: { type: "object" },
  },
} as const;
export function createAjv() {
  const ajv = new Ajv({ allErrors: true });
  ajv.addFormat(
    "uuid",
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  return ajv.compile(schema);
}
