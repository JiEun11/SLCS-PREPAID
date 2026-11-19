CREATE TABLE "idempotency_requests" (
	"actor_id" uuid NOT NULL,
	"key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_requests_actor_id_key_pk" PRIMARY KEY("actor_id","key")
);
--> statement-breakpoint
ALTER TABLE "idempotency_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "balance_after" integer;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_balance_after_nonnegative" CHECK ("transactions"."balance_after" >= 0);