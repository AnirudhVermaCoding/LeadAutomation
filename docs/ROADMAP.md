# Roadmap (not built yet), with the reason

## Channels and integrations

- **WhatsApp coexistence** (clinic keeps its WhatsApp Business app number): needs Tech Provider / Solution Partner status and Embedded Signup v4; see ONBOARDING. Reason: a Meta business process you start, then an integration that can't be tested live until it is done.
- **Instagram DMs, Facebook Messenger, Google Business Profile messages:** each is its own channel with Meta / Google app review. Reason: weeks of review and per-channel send rules; the instant-reply promise already covers the main sources.
- **Portal APIs / CRM push (99acres, MagicBricks, Housing, Practo, JustDial):** no public push API; they sell CRM integrations per account. Reason: the email-forward and Zapier / Make paths work today.
- **Outlook / Office 365 calendar:** one more `CalendarProvider` adapter (Microsoft Graph subscriptions expire in ~3 days). Reason: separate Microsoft app registration and publisher verification; nobody has asked.
- **HubSpot and other CRM adapters, n8n bridge:** outbound webhooks + Zapier / Make cover it for now.
- **Outbound phone calls (service reminders, recall calls) and missed-call text-back.** Reason: inbound AI receptionist is built (optional, Vapi); outbound calling needs per-clinic DLT / TRAI registration, a registered caller id and consent records per call purpose, so it stays off until a clinic provides them. Promotional calling will not be built.
- **Voice transcripts and our own guard on spoken replies.** Reason: the vendor's model speaks between tool calls; we check every tool call and caller utterance, and store only the vendor's summary.
- **More voice vendors (Bolna, Exotel voicebot, Retell):** one `VoiceProvider` adapter each.
- **WhatsApp BSP adapters (Wati / Interakt / AiSensy):** add when a signed client uses one.

## Product

- **Plans, message / AI limits per plan, payments and subscriptions.** Reason: pricing is your decision; usage by month + CSV and paused-tenant enforcement exist, so you can invoice manually in the pilot.
- **White-label domains.**
- **Bulk reactivation campaigns and A/B testing.** Reason: one-to-one recall, lost-lead and stalled-treatment reminders are built (Recovery); bulk sends need marketing-template budgets and opt-in hygiene first.
- **Billing / accounting:** payment links only; no invoices, ledgers or gateway reconciliation. Treatment value and payments are what staff type on the plan.
- **Large-document RAG** (the assistant injects configured knowledge text).
- **Voice-note transcription** (needs a speech-to-text provider; today the customer is asked to type, by choice) and **photo understanding** (patient photos are never sent to an AI, by choice).
- **Per-task AI model routing in the Settings UI** (providers and budget are in the UI; routing stays JSON).
- **Two-way sync of blocked time from Google beyond the 60-day window, and appointments typed by hand in Google becoming InstantLead appointments.** Reason: imported as busy time (safe); mapping free-text events to patients is guesswork.
- **Patient-chosen alternative doctor during a leave rebooking** (today: same-time reassignment or new times).
- **"Doctor running late" detected automatically** (today: a staff button).
- **Data principal self-service** (patients request access / erasure themselves; today via the clinic).

## Platform

- **MFA / passkeys and password reset by email.** Reason: needs an email / SMS flow and recovery design.
- **Postgres WAL archiving / point-in-time recovery** (today: nightly logical dump, up to 24 h of loss). Managed Postgres with PITR is the easy route.
- **Pin the resolved IP for outbound webhook delivery** (closes the DNS-rebinding window) and a per-webhook delivery log / resend.
- **Dependabot and image scanning in CI.**
- **Automated retry of provider calls beyond pg-boss backoff** (circuit breakers): failover and holding replies cover the common outages.
- **Langfuse tracing** for assistant runs (`llm_runs` covers cost / latency).
- **LLM-played simulator leads** (personas are scripted).
- **pg-boss LISTEN/NOTIFY** once its wake-up behaviour under load is understood (today: fast polling).
- **Streaming LLM responses** (not useful for WhatsApp-length replies).
- **Native Gemini / xAI SDK adapters** if the OpenAI-compatible endpoints fall short in contract tests.
- **Move to TypeScript 7 / drizzle-orm 1.0** once typescript-eslint / drizzle ship stable support.
- **Rename `leads.phone_e_164` to `phone_e164`** (cosmetic).
- **Emergency-keyword matching for languages beyond English / Hindi / Hinglish.**
