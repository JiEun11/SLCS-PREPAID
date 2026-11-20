import express from "express";
import swaggerUi from "swagger-ui-express";
import { createCustomerRouter, type CustomerService } from "./customers.js";
import { customerPaths } from "./customer-openapi.js";
import {
  isPin,
  PinLimitError,
  requireAdmin,
  type AdminAuth,
} from "./admin-auth.js";

const healthPath = "/api/health";
const adminPath = "/api/admin/me";
const openApi = {
  openapi: "3.1.0",
  info: { title: "SLCS PREPAID API", version: "0.1.0" },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    },
  },
  paths: {
    ...customerPaths,
    [adminPath]: {
      get: {
        summary: "관리자 권한 확인",
        security: [{ bearerAuth: [] }],
        responses: {
          "200": { description: "관리자" },
          "401": { description: "인증 실패" },
          "403": { description: "관리자 권한 없음" },
          "503": { description: "인증 서비스 사용 불가" },
        },
      },
    },
    [healthPath]: {
      get: {
        summary: "API 상태 확인",
        responses: {
          "200": {
            description: "API 응답 가능",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["status"],
                  properties: { status: { const: "ok" } },
                },
              },
            },
          },
        },
      },
    },
  },
};

export function createApp(
  adminAuth?: AdminAuth,
  customerService?: CustomerService,
) {
  const app = express();
  app.disable("x-powered-by");
  app.get(healthPath, (_request, response) => response.json({ status: "ok" }));

  app.post(
    "/api/admin/pin",
    express.json({ limit: "1kb" }),
    async (request, response) => {
      response.set("Cache-Control", "no-store");
      if (!isPin(request.body?.pin)) {
        response.status(400).json({ error: "invalid_request" });
        return;
      }
      if (!adminAuth?.signInWithPin) {
        response.status(503).json({ error: "authentication_unavailable" });
        return;
      }
      try {
        const session = await adminAuth.signInWithPin(request.body.pin);
        if (!session) {
          response.status(401).json({ error: "invalid_pin" });
          return;
        }
        response.json(session);
      } catch (error) {
        if (error instanceof PinLimitError) {
          response
            .set("Retry-After", String(Math.ceil(error.retryMs / 1000)))
            .status(429)
            .json({ error: "pin_rate_limited" });
          return;
        }
        response.status(503).json({ error: "authentication_unavailable" });
      }
    },
  );

  app.get(adminPath, requireAdmin(adminAuth), (_request, response) =>
    response.json({ role: "admin" }),
  );

  app.use("/api/customers", createCustomerRouter(adminAuth, customerService));

  if (process.env.NODE_ENV === "development") {
    app.get("/api/openapi.json", (_request, response) =>
      response.json(openApi),
    );
    app.use(
      "/api/docs",
      swaggerUi.serve,
      swaggerUi.setup(undefined, {
        swaggerOptions: { url: "/api/openapi.json", validatorUrl: null },
      }),
    );
  }

  return app;
}
