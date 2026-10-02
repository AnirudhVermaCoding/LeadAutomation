# Roadmap (out of scope for v0)

From the spec (§13):

- Voice calling and missed-call text-back (telephony)
- Instagram / Messenger channels
- Large-document RAG (v0 injects configured knowledge text)
- Billing / subscriptions
- White-label domains
- Database reactivation / recall campaigns
- A/B testing
- HubSpot and other CRM adapters
- n8n bridge

Deferred during the build:

- WhatsApp BSP adapters (Wati / Interakt / AiSensy) — add when a signed client uses one.
- Move to TypeScript 7 once typescript-eslint supports it.
- Move to drizzle-orm 1.0 once stable.
- Re-opt-in flow after opt-out (v0: opt-out is permanent per phone per tenant).
- Opt-out confirmation message ("you won't hear from us again") — v0 opts out silently.
- Treat Meta error 131050 (user stopped marketing messages) as a marketing-only suppression.
- Sync template approval status from Meta's API instead of marking it by hand.
- Langfuse tracing for assistant runs (`llm_runs` covers cost/latency for now).
- LLM-played simulator leads (v0 personas are scripted).
- Rename `leads.phone_e_164` to `phone_e164` (drizzle snake_case artefact; cosmetic).
- Two-way calendar sync (read busy times from Google Calendar).
- Cancellation template (v0 can only tell a lead their appointment is cancelled inside the 24 h window).
- Resource preferences (book a specific doctor) — v0 picks the first free resource.
- Weekly report and agency alerts over WhatsApp (v0: email).
- Retry / discard actions for dead-lettered jobs in the Agency view (v0: list only).
- pg-boss LISTEN/NOTIFY for live queues once its wake-up behaviour under load is understood (v0 polls fast).
- Automated off-site backups (v0: documented cron + `pg_dump`).
- Data principal self-service (patients request access/erasure themselves; v0 goes through the clinic).
- Pin the resolved IP for webhook delivery (closes the DNS-rebinding window left by resolve-then-fetch) and a per-webhook delivery log / resend.
- Voice-note transcription (needs a speech-to-text provider; v0 asks the customer to type, by choice).
- Photo understanding (vision models; v0 never sends patient photos to an AI, by choice).
- Streaming LLM responses (not useful for WhatsApp-length replies today).
- Native Gemini / xAI SDK adapters if the OpenAI-compatible endpoints fall short in contract tests.
- Emergency reply in the lead's language (v0: the configured text, usually English).
- Per-tenant `ai.*` settings in the Settings UI (v0: edit via config JSON import/export).
- "Doctor running late" detected automatically from the queue (v0: a staff button).
- Patient-chosen alternative doctor during a leave rebooking (v0: same-time reassignment, or new times).
- Calendar sync of blocked times from Google Calendar (v0: blocked in the dashboard).
