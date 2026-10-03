CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"lead_id" uuid,
	"provider" text NOT NULL,
	"provider_call_id" text NOT NULL,
	"direction" text DEFAULT 'in' NOT NULL,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"duration_sec" integer,
	"after_hours" boolean DEFAULT false NOT NULL,
	"summary" text,
	"outcome" text,
	"transferred" boolean DEFAULT false NOT NULL,
	"escalated" boolean DEFAULT false NOT NULL,
	"tool_results" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calls_tenantId_providerCallId_unique" UNIQUE("tenant_id","provider_call_id")
);
--> statement-breakpoint
ALTER TABLE "calls" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"lead_id" uuid,
	"kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"priority" integer NOT NULL,
	"reason" text NOT NULL,
	"recommended_action" text NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"ai_acted" boolean DEFAULT false NOT NULL,
	"acted_at" timestamp with time zone,
	"outcome" text,
	"outcome_at" timestamp with time zone,
	"value_inr" numeric(12, 2),
	"value_source" text,
	"treatment_plan_id" uuid,
	"appointment_id" uuid,
	"slot_starts_at" timestamp with time zone,
	"slot_resource" text,
	"slot_service" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opportunities_tenantId_kind_subjectKey_unique" UNIQUE("tenant_id","kind","subject_key")
);
--> statement-breakpoint
ALTER TABLE "opportunities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "slot_offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"waitlist_entry_id" uuid NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"offered_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slot_offers_opportunityId_leadId_unique" UNIQUE("opportunity_id","lead_id")
);
--> statement-breakpoint
ALTER TABLE "slot_offers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "treatment_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"attendee_name" text,
	"title" text NOT NULL,
	"service" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"visits_planned" integer,
	"visits_done" integer DEFAULT 0 NOT NULL,
	"visit_interval_days" integer,
	"next_visit_due_at" timestamp with time zone,
	"recall_due_at" timestamp with time zone,
	"value_inr" numeric(12, 2),
	"paid_inr" numeric(12, 2),
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "treatment_plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "waitlist_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid DEFAULT nullif(current_setting('app.tenant_id', true), '')::uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"service" text NOT NULL,
	"resource" text,
	"attendee_name" text,
	"appointment_id" uuid,
	"from_date" text,
	"to_date" text,
	"part_of_day" text,
	"status" text DEFAULT 'waiting' NOT NULL,
	"source" text NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "waitlist_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "treatment_plan_id" uuid;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "lead_id" uuid;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "voice_in_key" text;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_treatment_plan_id_treatment_plans_id_fk" FOREIGN KEY ("treatment_plan_id") REFERENCES "public"."treatment_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_offers" ADD CONSTRAINT "slot_offers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_offers" ADD CONSTRAINT "slot_offers_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_offers" ADD CONSTRAINT "slot_offers_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slot_offers" ADD CONSTRAINT "slot_offers_waitlist_entry_id_waitlist_entries_id_fk" FOREIGN KEY ("waitlist_entry_id") REFERENCES "public"."waitlist_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plans" ADD CONSTRAINT "treatment_plans_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_plans" ADD CONSTRAINT "treatment_plans_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calls_lead_started" ON "calls" USING btree ("lead_id","started_at");--> statement-breakpoint
CREATE INDEX "calls_tenant_started" ON "calls" USING btree ("tenant_id","started_at");--> statement-breakpoint
CREATE INDEX "opportunities_tenant_status_priority" ON "opportunities" USING btree ("tenant_id","status","priority" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "opportunities_lead" ON "opportunities" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "slot_offers_opportunity_status" ON "slot_offers" USING btree ("opportunity_id","status");--> statement-breakpoint
CREATE INDEX "treatment_plans_tenant_status_due" ON "treatment_plans" USING btree ("tenant_id","status","next_visit_due_at");--> statement-breakpoint
CREATE INDEX "treatment_plans_lead" ON "treatment_plans" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "waitlist_tenant_status_service" ON "waitlist_entries" USING btree ("tenant_id","status","service","joined_at");--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_one_open_per_person" ON "waitlist_entries" USING btree ("tenant_id","lead_id","service",lower(coalesce("attendee_name", ''))) WHERE "waitlist_entries"."status" = 'waiting';--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_treatment_plan_id_treatment_plans_id_fk" FOREIGN KEY ("treatment_plan_id") REFERENCES "public"."treatment_plans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_lead_occurred" ON "events" USING btree ("lead_id","occurred_at");--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_voiceInKey_unique" UNIQUE("voice_in_key");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "calls" AS PERMISSIVE FOR ALL TO "instantlead_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "opportunities" AS PERMISSIVE FOR ALL TO "instantlead_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "slot_offers" AS PERMISSIVE FOR ALL TO "instantlead_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "treatment_plans" AS PERMISSIVE FOR ALL TO "instantlead_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "waitlist_entries" AS PERMISSIVE FOR ALL TO "instantlead_app" USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
UPDATE "events" SET "lead_id" = ("payload"->>'leadId')::uuid WHERE "lead_id" IS NULL AND "payload"->>'leadId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
