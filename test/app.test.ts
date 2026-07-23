import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { buildApp } from "../src/app.js";
test("liveness and correlation middleware are available", async () => {
  const response = await request(buildApp())
    .get("/health/live")
    .set("x-correlation-id", "test-correlation");
  assert.equal(response.status, 200);
  assert.equal(response.body.service, "algaguard-mqtt-ingestion-service");
  assert.equal(response.headers["x-correlation-id"], "test-correlation");
});
test("unknown routes use problem details", async () => {
  const response = await request(buildApp()).get("/missing");
  assert.equal(response.status, 404);
  assert.match(
    response.headers["content-type"] ?? "",
    /application\/problem\+json/,
  );
});

test("HTTP cannot supply broker or certificate identity headers", async () => {
  for (const header of [
    "x-device-id",
    "x-authenticated-device-id",
    "x-client-cert",
  ]) {
    const response = await request(buildApp())
      .get("/health/live")
      .set(header, "spoofed");
    assert.equal(response.status, 400);
    assert.equal(response.body.code, "UNTRUSTED_PROXY_IDENTITY");
  }
});
