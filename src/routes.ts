import { Router } from "express";
import { z } from "zod";
import { IngestionService, type MqttEnvelope } from "./domain.js";
import { forwardTelemetry } from "./transport.js";
export const router = Router();
const service = new IngestionService();
router.post("/ingestion/messages", async (request, response) => {
  const topic = z.string().parse(request.header("x-mqtt-topic"));
  const result = await service.ingest(
    topic,
    request.body as MqttEnvelope,
    forwardTelemetry,
  );
  response.status(result.status === "REJECTED" ? 422 : 200).json(result);
});
