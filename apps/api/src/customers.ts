import { createHash } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import express, { type ErrorRequestHandler } from "express";
import { z } from "zod";
import { requireAdmin, type AdminAuth } from "./admin-auth.js";
import { customers, idempotencyRequests, transactions } from "./db/schema.js";

export const registrationSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .refine((name) => !name.includes("\0")),
  initialAmount: z.number().int().min(1).max(2_147_483_647),
});
export const keySchema = z.string().regex(/^[!-+\x2D-~]{1,128}$/);
export const customerIdSchema = z.uuid();
const listSchema = z.strictObject({
  q: z
    .string()
    .trim()
    .max(120)
    .refine((q) => !q.includes("\0"))
    .optional(),
  limit: z
    .string()
    .regex(/^[1-9][0-9]{0,2}$/)
    .pipe(z.coerce.number<string>().max(100))
    .optional(),
  offset: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,8})$/)
    .pipe(z.coerce.number<string>())
    .optional(),
});

export const customerSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  balance: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});
export const registrationResponseSchema = z.object({
  customer: customerSchema,
  transaction: z.object({
    id: z.uuid(),
    kind: z.literal("credit"),
    amount: z.number().int().positive(),
    balanceAfter: z.number().int().nonnegative(),
    createdAt: z.iso.datetime(),
  }),
});

function customerResponse({
  id,
  name,
  balance,
  createdAt,
}: typeof customers.$inferSelect) {
  return { id, name, balance, createdAt: createdAt.toISOString() };
}

class IdempotencyConflict extends Error {}

export function createCustomerService<T extends PgQueryResultHKT>(
  db: PgDatabase<T>,
) {
  return {
    async register(
      actorId: string,
      key: string,
      input: z.infer<typeof registrationSchema>,
    ) {
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify([
            "register-customer",
            input.name,
            input.initialAmount,
          ]),
        )
        .digest("hex");
      const requestKey = and(
        eq(idempotencyRequests.actorId, actorId),
        eq(idempotencyRequests.key, key),
      );

      return db.transaction(
        async (tx) => {
          const [claim] = await tx
            .insert(idempotencyRequests)
            .values({ actorId, key, fingerprint })
            .onConflictDoNothing()
            .returning({ key: idempotencyRequests.key });
          if (!claim) {
            // The unique constraint waits for a competing transaction before this read.
            const [existing] = await tx
              .select()
              .from(idempotencyRequests)
              .where(requestKey);
            if (existing?.fingerprint !== fingerprint)
              throw new IdempotencyConflict();
            return registrationResponseSchema.parse(existing.response);
          }

          const [legacy] = await tx
            .select({ id: transactions.id })
            .from(transactions)
            .where(
              and(
                eq(transactions.actorId, actorId),
                eq(transactions.idempotencyKey, key),
              ),
            );
          if (legacy) throw new IdempotencyConflict();

          const [customer] = await tx
            .insert(customers)
            .values({ name: input.name, balance: input.initialAmount })
            .returning();
          const [charge] = await tx
            .insert(transactions)
            .values({
              customerId: customer.id,
              actorId,
              kind: "credit",
              amount: input.initialAmount,
              balanceAfter: customer.balance,
              idempotencyKey: key,
            })
            .onConflictDoNothing({
              target: [transactions.actorId, transactions.idempotencyKey],
            })
            .returning({
              id: transactions.id,
              createdAt: transactions.createdAt,
            });
          if (!charge) throw new IdempotencyConflict();

          const result = {
            customer: customerResponse(customer),
            transaction: {
              id: charge.id,
              kind: "credit" as const,
              amount: input.initialAmount,
              balanceAfter: customer.balance,
              createdAt: charge.createdAt.toISOString(),
            },
          };
          await tx
            .update(idempotencyRequests)
            .set({ response: result })
            .where(requestKey);
          return result;
        },
        { isolationLevel: "read committed" },
      );
    },

    async list({ q, limit = 20, offset = 0 }: z.output<typeof listSchema>) {
      const pattern = q?.replace(/[!%_]/g, "!$&");
      const rows = await db
        .select()
        .from(customers)
        .where(
          and(
            isNull(customers.deletedAt),
            pattern
              ? sql`${customers.name} ilike ${"%" + pattern + "%"} escape '!'`
              : undefined,
          ),
        )
        .orderBy(asc(customers.createdAt), asc(customers.id))
        .limit(limit)
        .offset(offset);
      return rows.map(customerResponse);
    },

    async find(id: string) {
      const [customer] = await db
        .select()
        .from(customers)
        .where(and(eq(customers.id, id), isNull(customers.deletedAt)));
      return customer && customerResponse(customer);
    },
  };
}

export type CustomerService = ReturnType<typeof createCustomerService>;

export function createCustomerRouter(
  adminAuth?: AdminAuth,
  service?: CustomerService,
) {
  const router = express.Router();
  router.use(requireAdmin(adminAuth));

  if (!service) {
    router.use((_request, response) => {
      response.status(503).json({ error: "customer_service_unavailable" });
    });
    return router;
  }

  router.post("/", express.json(), async (request, response) => {
    const input = registrationSchema.safeParse(request.body);
    const key = keySchema.safeParse(request.get("Idempotency-Key"));
    if (!input.success || !key.success) {
      response.status(400).json({ error: "invalid_request" });
      return;
    }
    const result = await service.register(
      response.locals.adminId,
      key.data,
      input.data,
    );
    response.status(201).json(result);
  });

  router.get("/", async (request, response) => {
    const query = listSchema.safeParse(request.query);
    if (!query.success) {
      response.status(400).json({ error: "invalid_request" });
      return;
    }
    response.json({ customers: await service.list(query.data) });
  });

  router.get("/:customerId", async (request, response) => {
    const id = customerIdSchema.safeParse(request.params.customerId);
    if (!id.success) {
      response.status(400).json({ error: "invalid_request" });
      return;
    }
    const customer = await service.find(id.data);
    if (!customer) {
      response.status(404).json({ error: "customer_not_found" });
      return;
    }
    response.json(customer);
  });

  const handleError: ErrorRequestHandler = (
    error: unknown,
    _request,
    response,
    next,
  ) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    if (error instanceof IdempotencyConflict) {
      response.status(409).json({ error: "idempotency_key_conflict" });
      return;
    }
    if (
      error instanceof Error &&
      "status" in error &&
      (error.status === 400 || error.status === 413 || error.status === 415)
    ) {
      response.status(error.status).json({ error: "invalid_request" });
      return;
    }
    response.status(500).json({ error: "internal_error" });
  };
  router.use(handleError);
  return router;
}
