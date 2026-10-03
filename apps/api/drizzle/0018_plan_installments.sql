CREATE TABLE "plan_installments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"amount_inr" numeric(12, 2) NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_installments_planId_seq_unique" UNIQUE("plan_id","seq")
);
--> statement-breakpoint
ALTER TABLE "plan_installments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "plan_installments" ADD CONSTRAINT "plan_installments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_installments" ADD CONSTRAINT "plan_installments_plan_id_treatment_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."treatment_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_installments" ADD CONSTRAINT "plan_installments_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_installments_tenant_status_due" ON "plan_installments" USING btree ("tenant_id","status","due_at");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "plan_installments" AS PERMISSIVE FOR ALL TO "instantlead_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);