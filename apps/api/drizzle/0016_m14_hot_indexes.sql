CREATE INDEX "enrollments_lead" ON "enrollments" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "events_tenant_type_occurred" ON "events" USING btree ("tenant_id","type","occurred_at");--> statement-breakpoint
CREATE INDEX "leads_tenant_received" ON "leads" USING btree ("tenant_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "llm_runs_tenant_occurred" ON "llm_runs" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE INDEX "llm_runs_lead" ON "llm_runs" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "messages_lead_occurred" ON "messages" USING btree ("lead_id","occurred_at");