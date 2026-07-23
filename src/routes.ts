import { Router } from "express";
import type { IngestionService } from "./domain.js";

export function createRouter(service: IngestionService) {
  const router = Router();
  router.get("/metrics", (_request, response) =>
    response.type("text/plain").send(service.metrics.render()),
  );
  return router;
}
