ALTER TABLE "leads" ADD COLUMN "marketing_opt_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "provider_status" text;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "status_reason" text;--> statement-breakpoint
ALTER TABLE "templates" ADD COLUMN "synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "waba_id" text;--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_wabaId_unique" UNIQUE("waba_id");