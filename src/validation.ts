import { z } from "zod";

const decimalSequence = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const extensionMap = z.record(z.string(), z.unknown());
const profileReference = z
  .object({
    profileId: z.string().uuid(),
    profileVersion: z
      .string()
      .regex(
        /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
      ),
  })
  .strict();
const parameterValues = z
  .object({
    temperatureC: z.number().optional(),
    ph: z.number().min(0).max(14).optional(),
    lightLux: z.number().min(0).optional(),
    nitrateMgL: z.number().min(0).optional(),
    phosphateMgL: z.number().min(0).optional(),
    potassiumMgL: z.number().min(0).optional(),
    batteryPercent: z.number().min(0).max(100).optional(),
    batteryVoltageV: z.number().min(0).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "values must not be empty");
const qualityFlag = z.enum([
  "SIMULATED",
  "SENSOR_UNAVAILABLE",
  "OUT_OF_EXPECTED_RANGE",
  "CLOCK_UNSYNCED",
  "SD_RECOVERED",
  "ESTIMATED",
]);
const telemetrySample = z
  .object({
    sequence: decimalSequence,
    observedAt: z.string().datetime().optional(),
    timestampQuality: z.enum(["NTP_SYNCED", "RTC_HOLDOVER", "UNSYNCED"]),
    uptimeMs: decimalSequence,
    values: parameterValues,
    qualityFlags: z.array(qualityFlag).max(6).optional(),
    simulationScenario: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .optional(),
    extensions: extensionMap.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.timestampQuality === "UNSYNCED" && value.observedAt) {
      context.addIssue({
        code: "custom",
        message: "UNSYNCED samples omit observedAt",
      });
    }
    if (value.timestampQuality !== "UNSYNCED" && !value.observedAt) {
      context.addIssue({
        code: "custom",
        message: "synchronized samples require observedAt",
      });
    }
    if (
      value.qualityFlags?.includes("SIMULATED") &&
      !value.simulationScenario
    ) {
      context.addIssue({
        code: "custom",
        message: "simulated samples require simulationScenario",
      });
    }
  });

export const telemetryEnvelopeSchema = z
  .object({
    schema: z.literal("urn:algaguard:schema:mqtt:telemetry-batch:v1"),
    schemaVersion: z.literal("1.0.0"),
    messageId: z.string().uuid(),
    deviceId: z.string().regex(/^AG-[0-9]{6}$/),
    sentAt: z.string().datetime(),
    correlationId: z.string().uuid().optional(),
    traceparent: z
      .string()
      .regex(/^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/)
      .optional(),
    extensions: extensionMap.optional(),
    payload: z
      .object({
        batchId: z.string().uuid(),
        firstSequence: decimalSequence,
        lastSequence: decimalSequence,
        sampleCount: z.number().int().min(1).max(120),
        activeProfile: profileReference,
        samples: z.array(telemetrySample).min(1).max(120),
        isReplay: z.boolean().optional(),
        createdFromSd: z.boolean().optional(),
        extensions: extensionMap.optional(),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.sampleCount !== value.samples.length) {
          context.addIssue({ code: "custom", message: "sampleCount mismatch" });
        }
        if (value.samples[0]?.sequence !== value.firstSequence) {
          context.addIssue({
            code: "custom",
            message: "firstSequence mismatch",
          });
        }
        if (value.samples.at(-1)?.sequence !== value.lastSequence) {
          context.addIssue({
            code: "custom",
            message: "lastSequence mismatch",
          });
        }
        for (let index = 1; index < value.samples.length; index += 1) {
          if (
            BigInt(value.samples[index]!.sequence) <=
            BigInt(value.samples[index - 1]!.sequence)
          ) {
            context.addIssue({
              code: "custom",
              message: "sequences must increase",
            });
          }
        }
      }),
  })
  .strict();
