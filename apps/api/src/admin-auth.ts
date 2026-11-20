import type { RequestHandler } from "express";

export const isPin = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9]{6}$/.test(value);

export class PinLimitError extends Error {
  constructor(public retryMs: number) {
    super("PIN attempts exhausted");
  }
}

export interface AdminAuth {
  signInWithPin?(
    pin: string,
  ): Promise<{ access_token: string; refresh_token: string } | null>;
  getUserId(token: string): Promise<string | null>;
  isAdmin(userId: string): Promise<boolean>;
  reauthenticate?(token: string, userId: string, pin: string): Promise<boolean>;
}

export function requireAdmin(auth?: AdminAuth): RequestHandler {
  return async (request, response, next) => {
    const token = /^Bearer ([^\s,]+)$/i.exec(
      request.get("authorization") ?? "",
    )?.[1];
    if (!token) {
      response
        .set("WWW-Authenticate", "Bearer")
        .status(401)
        .json({ error: "unauthorized" });
      return;
    }

    const unavailable = (stage: string) => {
      response.status(503).json({
        error: "authentication_unavailable",
        ...(process.env.NODE_ENV === "development" ? { stage } : {}),
      });
    };

    if (!auth) {
      unavailable("configuration");
      return;
    }

    let stage = "supabase_auth";
    try {
      const userId = await auth.getUserId(token);
      if (!userId) {
        response
          .set("WWW-Authenticate", 'Bearer error="invalid_token"')
          .status(401)
          .json({ error: "unauthorized" });
        return;
      }

      stage = "admin_lookup";
      if (!(await auth.isAdmin(userId))) {
        response.status(403).json({ error: "forbidden" });
        return;
      }

      response.locals.adminId = userId;
      next();
    } catch {
      unavailable(stage);
    }
  };
}
