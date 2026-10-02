ALTER TABLE "conversations" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "summary_up_to" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "leads" ADD COLUMN "not_a_lead" text;--> statement-breakpoint
ALTER TABLE "llm_runs" ADD COLUMN "guard_violations" jsonb;