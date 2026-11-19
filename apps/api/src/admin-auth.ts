import type { RequestHandler } from "express";

export interface AdminAuth {
  getUserId(token: string): Promise<string | null>;
  isAdmin(userId: string): Promise<boolean>;
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

    if (!auth) {
      response.status(503).json({ error: "authentication_unavailable" });
      return;
    }

    try {
      const userId = await auth.getUserId(token);
      if (!userId) {
        response
          .set("WWW-Authenticate", 'Bearer error="invalid_token"')
          .status(401)
          .json({ error: "unauthorized" });
        return;
      }

      if (!(await auth.isAdmin(userId))) {
        response.status(403).json({ error: "forbidden" });
        return;
      }

      response.locals.adminId = userId;
      next();
    } catch {
      response.status(503).json({ error: "authentication_unavailable" });
    }
  };
}
