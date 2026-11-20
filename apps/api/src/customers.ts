import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  alias,
  type PgDatabase,
  type PgQueryResultHKT,
} from "drizzle-orm/pg-core";
import express, { type ErrorRequestHandler } from "express";
import { z } from "zod";
import { PinLimitError, requireAdmin, type AdminAuth } from "./admin-auth.js";
import { customers, idempotencyRequests, transactions } from "./db/schema.js";

const maximumBalance = 2_147_483_647;
const positiveMoney = z.number().int().min(1).max(maximumBalance);
const pageFields = {
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
};
const pageSchema = z.strictObject(pageFields);

const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((name) => !name.includes("\0"));
const memoSchema = z
  .string()
  .trim()
  .max(300)
  .refine((memo) => !memo.includes("\0"))
  .optional();
export const movementSchema = z.strictObject({
  amount: positiveMoney,
  memo: memoSchema,
});
export const renameSchema = z.strictObject({ name: nameSchema });
export const reversalInputSchema = z.strictObject({ memo: memoSchema });
export const bulkDeleteSchema = z.strictObject({
  customerIds: z.array(z.uuid()).min(1).max(100),
});
export const deleteAllSchema = z.strictObject({
  confirmation: z.literal("전체 삭제"),
  expectedCount: z.number().int().nonnegative(),
  pin: z.string().regex(/^[0-9]{6}$/),
});
export const registrationSchema = z.strictObject({
  name: nameSchema,
  initialAmount: positiveMoney,
  memo: memoSchema,
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
  ...pageFields,
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

const movementTransactionSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["credit", "debit", "reversal"]),
  reversesId: z.uuid().optional(),
  amount: z.number().int(),
  balanceAfter: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});
export const movementResponseSchema = z.object({
  customer: customerSchema,
  transaction: movementTransactionSchema,
});
export const transactionSchema = movementTransactionSchema.extend({
  kind: z.enum(["credit", "debit", "reversal"]),
  balanceAfter: z.number().int().nonnegative().nullable(),
  actorId: z.uuid(),
  memo: z.string().nullable(),
  reversesId: z.uuid().nullable(),
  reversedById: z.uuid().nullable(),
});
export const summarySchema = z.object({
  totalBalance: z.string(),
  customerCount: z.string(),
  totalUsed: z.string(),
});

class CustomerError extends Error {
  constructor(
    public status: 403 | 404 | 409 | 503,
    public code: string,
  ) {
    super(code);
  }
}

function keyConflict() {
  return new CustomerError(409, "idempotency_key_conflict");
}

type TransactionContext<T extends PgQueryResultHKT> = Parameters<
  Parameters<PgDatabase<T>["transaction"]>[0]
>[0];

async function idempotent<T extends PgQueryResultHKT, Result>(
  db: PgDatabase<T>,
  actorId: string,
  key: string,
  request: readonly unknown[],
  resultSchema: z.ZodType<Result>,
  work: (tx: TransactionContext<T>) => Promise<Result>,
) {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(request))
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
        // The unique constraint waits for the competing transaction before this read.
        const [existing] = await tx
          .select()
          .from(idempotencyRequests)
          .where(requestKey);
        if (existing?.fingerprint !== fingerprint) throw keyConflict();
        return resultSchema.parse(existing.response);
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
      if (legacy) throw keyConflict();

      const result = await work(tx);
      await tx
        .update(idempotencyRequests)
        .set({ response: result })
        .where(requestKey);
      return result;
    },
    { isolationLevel: "read committed" },
  );
}

async function record<T extends PgQueryResultHKT>(
  tx: TransactionContext<T>,
  values: typeof transactions.$inferInsert,
) {
  const [entry] = await tx
    .insert(transactions)
    .values({
      ...values,
      createdAt: sql`clock_timestamp()`,
    })
    .onConflictDoNothing({
      target: [transactions.actorId, transactions.idempotencyKey],
    })
    .returning({ id: transactions.id, createdAt: transactions.createdAt });
  if (!entry) throw keyConflict();
  return { id: entry.id, createdAt: entry.createdAt.toISOString() };
}

const reversal = alias(transactions, "reversal");
const entryFields = {
  id: transactions.id,
  kind: transactions.kind,
  amount: transactions.amount,
  balanceAfter: transactions.balanceAfter,
  actorId: transactions.actorId,
  memo: transactions.memo,
  createdAt: transactions.createdAt,
  reversesId: transactions.reversesId,
};
function entryResponse(
  entry: {
    id: string;
    kind: (typeof transactions.$inferSelect)["kind"];
    amount: number;
    balanceAfter: number | null;
    actorId: string;
    memo: string | null;
    createdAt: Date;
    reversesId: string | null;
  },
  reversedById: string | null,
) {
  const {
    id,
    kind,
    amount,
    balanceAfter,
    actorId,
    memo,
    createdAt,
    reversesId,
  } = entry;
  return {
    id,
    kind,
    amount,
    balanceAfter,
    actorId,
    memo,
    createdAt: createdAt.toISOString(),
    reversesId,
    reversedById,
  };
}

export function createCustomerService<T extends PgQueryResultHKT>(
  db: PgDatabase<T>,
) {
  return {
    register(
      actorId: string,
      key: string,
      input: z.infer<typeof registrationSchema>,
    ) {
      // Keep the original fingerprint format for requests recorded by Phase 3-1.
      return idempotent(
        db,
        actorId,
        key,
        [
          "register-customer",
          input.name,
          input.initialAmount,
          ...(input.memo ? [input.memo] : []),
        ],
        registrationResponseSchema,
        async (tx) => {
          const [customer] = await tx
            .insert(customers)
            .values({ name: input.name, balance: input.initialAmount })
            .returning();
          const charge = await record(tx, {
            customerId: customer.id,
            actorId,
            kind: "credit",
            amount: input.initialAmount,
            balanceAfter: customer.balance,
            memo: input.memo || null,
            idempotencyKey: key,
          });
          return {
            customer: customerResponse(customer),
            transaction: {
              ...charge,
              kind: "credit" as const,
              amount: input.initialAmount,
              balanceAfter: customer.balance,
            },
          };
        },
      );
    },

    move(
      actorId: string,
      key: string,
      customerId: string,
      kind: "credit" | "debit" | "reversal",
      target: number | string,
      memo?: string,
    ) {
      return idempotent(
        db,
        actorId,
        key,
        [kind, customerId, target, ...(memo ? [memo] : [])],
        movementResponseSchema,
        async (tx) => {
          const [customer] = await tx
            .select()
            .from(customers)
            .where(
              and(eq(customers.id, customerId), isNull(customers.deletedAt)),
            )
            .for("update");
          if (!customer) throw new CustomerError(404, "customer_not_found");

          let signedAmount: number;
          let reversesId: string | undefined;
          if (typeof target === "string") {
            const [original] = await tx
              .select({ ...entryFields, reversedById: reversal.id })
              .from(transactions)
              .leftJoin(reversal, eq(reversal.reversesId, transactions.id))
              .where(
                and(
                  eq(transactions.customerId, customerId),
                  eq(transactions.id, target),
                ),
              );
            if (!original)
              throw new CustomerError(404, "transaction_not_found");
            if (original.kind === "reversal" || original.reversedById)
              throw new CustomerError(409, "transaction_not_reversible");
            reversesId = original.id;
            signedAmount = -original.amount;
          } else {
            signedAmount = kind === "credit" ? target : -target;
          }
          const balance = customer.balance + signedAmount;
          if (balance < 0) throw new CustomerError(409, "insufficient_balance");
          if (balance > maximumBalance)
            throw new CustomerError(409, "balance_limit");

          await tx
            .update(customers)
            .set({ balance })
            .where(eq(customers.id, customerId));
          const entry = await record(tx, {
            customerId,
            actorId,
            kind,
            amount: signedAmount,
            balanceAfter: balance,
            memo: memo || null,
            reversesId,
            idempotencyKey: key,
          });
          return {
            customer: customerResponse({ ...customer, balance }),
            transaction: {
              ...entry,
              kind,
              amount: signedAmount,
              reversesId,
              balanceAfter: balance,
            },
          };
        },
      );
    },

    async rename(id: string, name: string) {
      const [customer] = await db
        .update(customers)
        .set({ name })
        .where(and(eq(customers.id, id), isNull(customers.deletedAt)))
        .returning();
      if (!customer) throw new CustomerError(404, "customer_not_found");
      return customerResponse(customer);
    },

    async softDelete(ids: string[]) {
      const result = await db
        .update(customers)
        .set({ deletedAt: sql`now()` })
        .where(and(inArray(customers.id, ids), isNull(customers.deletedAt)))
        .returning({ id: customers.id });
      return { deletedCount: result.length };
    },

    async deleteAll(expectedCount: number) {
      return db.transaction(async (tx) => {
        // Exclude writers and SELECT FOR UPDATE while checking the count.
        await tx.execute(sql`lock table ${customers} in exclusive mode`);
        const [current] = await tx
          .select({ count: sql<string>`count(*)::text` })
          .from(customers)
          .where(isNull(customers.deletedAt));
        if (current.count !== String(expectedCount))
          throw new CustomerError(409, "customer_count_changed");
        await tx
          .update(customers)
          .set({ deletedAt: sql`now()` })
          .where(isNull(customers.deletedAt));
        return { deletedCount: expectedCount };
      });
    },

    async history(
      customerId: string,
      { limit = 20, offset = 0 }: z.output<typeof pageSchema>,
    ) {
      const [customer] = await db
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.id, customerId));
      if (!customer) throw new CustomerError(404, "customer_not_found");
      const entries = await db
        .select({ ...entryFields, reversedById: reversal.id })
        .from(transactions)
        .leftJoin(reversal, eq(reversal.reversesId, transactions.id))
        .where(eq(transactions.customerId, customerId))
        .orderBy(desc(transactions.createdAt), desc(transactions.id))
        .limit(limit)
        .offset(offset);
      return entries.map((entry) => entryResponse(entry, entry.reversedById));
    },

    async summary() {
      const [totals] = await db
        .select({
          totalBalance: sql<string>`coalesce(sum(${customers.balance}), 0)::text`,
          customerCount: sql<string>`count(*)::text`,
          totalUsed: sql<string>`(select coalesce(sum(-original.amount::bigint), 0)::text from ${transactions} as original where original.kind = 'debit' and not exists (select 1 from ${transactions} as correction where correction.reverses_id = original.id))`,
        })
        .from(customers)
        .where(isNull(customers.deletedAt));
      return totals;
    },

    async list({ q, limit = 20, offset = 0 }: z.output<typeof listSchema>) {
      const pattern = q?.replace(/[!%_]/g, "!$&");
      // Balance and latest transaction come from the same statement snapshot.
      const latest = db
        .select({
          ...entryFields,
          reversedById: sql<string | null>`${reversal.id}`.as("reversed_by_id"),
        })
        .from(transactions)
        .leftJoin(reversal, eq(reversal.reversesId, transactions.id))
        .where(eq(transactions.customerId, customers.id))
        .orderBy(desc(transactions.createdAt), desc(transactions.id))
        .limit(1)
        .as("latest_transaction");
      const rows = await db
        .select()
        .from(customers)
        .leftJoinLateral(latest, sql`true`)
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
      return rows.map(
        ({ customers: customer, latest_transaction: recent }) => ({
          ...customerResponse(customer),
          recentTransaction:
            recent && entryResponse(recent, recent.reversedById),
        }),
      );
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

  router.get("/summary", async (_request, response) => {
    response.json(await service.summary());
  });

  router.get("/:customerId/transactions", async (request, response) => {
    const id = customerIdSchema.safeParse(request.params.customerId);
    const page = pageSchema.safeParse(request.query);
    if (!id.success || !page.success) {
      response.status(400).json({ error: "invalid_request" });
      return;
    }
    response.json({ transactions: await service.history(id.data, page.data) });
  });

  for (const [path, kind] of [
    ["credits", "credit"],
    ["debits", "debit"],
  ] as const) {
    router.post(
      "/:customerId/" + path,
      express.json(),
      async (request, response) => {
        const id = customerIdSchema.safeParse(request.params.customerId);
        const input = movementSchema.safeParse(request.body);
        const key = keySchema.safeParse(request.get("Idempotency-Key"));
        if (!id.success || !input.success || !key.success) {
          response.status(400).json({ error: "invalid_request" });
          return;
        }
        const result = await service.move(
          response.locals.adminId,
          key.data,
          id.data.toLowerCase(),
          kind,
          input.data.amount,
          input.data.memo,
        );
        response.status(201).json(result);
      },
    );
  }

  router.post(
    "/:customerId/transactions/:transactionId/reversal",
    express.json(),
    async (request, response) => {
      const customer = customerIdSchema.safeParse(request.params.customerId);
      const target = customerIdSchema.safeParse(request.params.transactionId);
      const key = keySchema.safeParse(request.get("Idempotency-Key"));
      const input = reversalInputSchema.safeParse(request.body);
      if (
        !customer.success ||
        !target.success ||
        !key.success ||
        !input.success
      ) {
        response.status(400).json({ error: "invalid_request" });
        return;
      }
      response
        .status(201)
        .json(
          await service.move(
            response.locals.adminId,
            key.data,
            customer.data.toLowerCase(),
            "reversal",
            target.data.toLowerCase(),
            input.data.memo,
          ),
        );
    },
  );

  router.patch("/:customerId", express.json(), async (request, response) => {
    const customer = customerIdSchema.safeParse(request.params.customerId);
    const input = renameSchema.safeParse(request.body);
    if (!customer.success || !input.success) {
      response.status(400).json({ error: "invalid_request" });
      return;
    }
    response.json(await service.rename(customer.data, input.data.name));
  });

  router.delete("/:customerId", async (request, response) => {
    const customer = customerIdSchema.safeParse(request.params.customerId);
    if (!customer.success) {
      response.status(400).json({ error: "invalid_request" });
      return;
    }
    response.json(await service.softDelete([customer.data]));
  });

  router.post("/bulk-delete", express.json(), async (request, response) => {
    const input = bulkDeleteSchema.safeParse(request.body);
    if (!input.success) {
      response.status(400).json({ error: "invalid_request" });
      return;
    }
    response.json(await service.softDelete(input.data.customerIds));
  });

  router.post("/delete-all", express.json(), async (request, response) => {
    const input = deleteAllSchema.safeParse(request.body);
    if (!input.success) {
      response.status(400).json({ error: "invalid_request" });
      return;
    }
    const token = request.get("authorization")?.slice(7) ?? "";
    let verified: boolean;
    try {
      if (!adminAuth?.reauthenticate)
        throw new Error("Reauthentication unavailable");
      verified = await adminAuth.reauthenticate(
        token,
        response.locals.adminId,
        input.data.pin,
      );
    } catch (error) {
      if (error instanceof PinLimitError) throw error;
      throw new CustomerError(503, "authentication_unavailable");
    }
    if (!verified) throw new CustomerError(403, "reauthentication_failed");
    response.json(await service.deleteAll(input.data.expectedCount));
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
    if (error instanceof PinLimitError) {
      response
        .set("Retry-After", String(Math.ceil(error.retryMs / 1000)))
        .status(429)
        .json({ error: "pin_rate_limited" });
      return;
    }
    if (error instanceof CustomerError) {
      response.status(error.status).json({ error: error.code });
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
