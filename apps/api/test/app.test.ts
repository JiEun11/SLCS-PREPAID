import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";

afterEach(() => vi.unstubAllEnvs());

describe("API scaffold", () => {
  it("reports API readiness", async () => {
    await request(createApp()).get("/api/health").expect(200, { status: "ok" });
  });

  it("serves Swagger UI and its matching OpenAPI document in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const api = request(createApp());
    await api
      .get("/api/docs/")
      .expect(200)
      .expect(/Swagger UI/);
    await api
      .get("/api/openapi.json")
      .expect(200)
      .expect((response) => {
        expect(response.body.openapi).toBe("3.1.0");
        expect(
          response.body.paths["/api/health"].get.responses["200"],
        ).toBeDefined();
        const customers = response.body.paths["/api/customers"];
        expect(customers.post.parameters).toContainEqual(
          expect.objectContaining({ name: "Idempotency-Key", required: true }),
        );
        expect(
          customers.post.requestBody.content["application/json"].schema
            .required,
        ).toContain("initialAmount");
        expect(customers.get.responses["200"]).toBeDefined();
        expect(
          response.body.paths["/api/customers/{customerId}"].get.responses[
            "404"
          ],
        ).toBeDefined();
      });
  });

  it.each(["production", undefined])(
    "keeps docs disabled for NODE_ENV=%s",
    async (mode) => {
      vi.stubEnv("NODE_ENV", mode);
      const api = request(createApp());
      await api.get("/api/docs/").expect(404);
      await api.get("/api/openapi.json").expect(404);
    },
  );
});
