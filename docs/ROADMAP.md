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
- ONBOARDING (M8) must cover: Meta webhook URL `/webhooks/meta` + verify token, subscribing the page to `leadgen`, and adding the tenant's consent notice as the Lead Ads form's custom disclaimer.
- Langfuse tracing for assistant runs (`llm_runs` covers cost/latency for now).
- LLM-played simulator leads (v0 personas are scripted).
- Rename `leads.phone_e_164` to `phone_e164` (drizzle snake_case artefact; cosmetic).
