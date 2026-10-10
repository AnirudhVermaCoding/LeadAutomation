# Privacy and the DPDP Act

How InstantLead handles personal data under India's Digital Personal Data Protection Act, 2023 and the
DPDP Rules. **The clinic is the Data Fiduciary** (it decides why leads are contacted); **the agency running
InstantLead is its Data Processor**, and should sign a data processing agreement with each clinic.
This document describes what the software does; it is not legal advice.

## What we store

| Data                                                   | Where                         | Why                                     |
| ------------------------------------------------------ | ----------------------------- | --------------------------------------- |
| Lead name, phone, email, source (form / ad / WhatsApp) | `leads`                       | To reply and book                       |
| Consent: notice text shown, time, IP, user agent, page | `consents`                    | Proof of consent                        |
| WhatsApp messages in both directions                   | `messages`, `conversations`   | The conversation itself                 |
| Answers to qualification questions, score              | `answers`, `leads.tier/score` | Qualification                           |
| Appointments                                           | `appointments`                | Booking and reminders                   |
| Opt-outs: keyed hash of the phone, not the phone       | `suppressions`                | Honour STOP forever, even after erasure |
| Audit trail (ids and actions, never personal data)     | `audit_log`                   | Accountability                          |
| AI usage (tokens, cost, latency; not message text)     | `llm_runs`                    | Cost control                            |

Logs redact phone, email, names, tokens and cookies. Per-clinic credentials (WhatsApp, Meta, Google tokens,
webhook secrets) are encrypted with AES-256-GCM and bound to the clinic, so they can't be moved between clinics.
Each clinic's data is isolated by Postgres row-level security.

### Phone calls, treatment plans, recovery (optional modules)

- **Calls** (phone agent): caller number (as the lead), time, duration, outcome and the vendor's call summary. No recordings or transcripts are stored by us; the vendor (Vapi) processes the audio and may keep recordings per its own settings, so configure retention there and name it as a processor. A call counts as consent for that conversation, with the disclosure read at the start as the notice.
- **Treatment plans**: the clinic's wording of a treatment, visit counts and dates, optional amounts. Administrative data entered by staff, not a medical record.
- **Opportunities and waitlist**: ids, reasons in plain words, statuses.
- Erasure deletes all of it with the lead; anonymization blanks call summaries, plan titles and family members' names; retention counts calls and plans as activity and never touches an open treatment or a future recall.

## Consent and notice

- Every lead needs consent: the hosted form shows the clinic's notice (Settings → Business) and records it with
  time, IP and page. API and CSV intake must send `consent.granted: true` (and should send the notice text shown).
  Leads without consent are rejected.
- Lead Ads: the clinic's notice goes into the form's custom disclaimer (see ONBOARDING).
- A lead who writes to the clinic on WhatsApp first is recorded with consent source `whatsapp_inbound`.

## Withdrawing consent (opt-out)

Replying **STOP** (also _unsubscribe_, _band karo_, _mat bhejo_, _बंद करो_ and other configured keywords),
or tapping a template's opt-out button, stops all messages at once: follow-ups, reminders and review requests
are cancelled and nothing more is sent. Staff can also opt a lead out from the Inbox.

## Data principal requests

| Request                          | How                                                                                                                                                                                                                                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access / correction              | Staff read and edit the lead in the Inbox; corrections are made there                                                                                                                                                                                                                               |
| **Erasure**                      | Inbox → open the lead → **Erase lead** (clinic admins), or `DELETE /v1/leads/:id`. Deletes the lead, messages, consents, answers, appointments and sequences. An audit row (ids only) records that it happened. The opt-out hash is kept so an erased person who said STOP is never contacted again |
| Portability / clinic offboarding | Settings → Integrations → **Download export** (`GET /v1/export`): config, leads, consents, conversations, messages, answers, appointments as JSON                                                                                                                                                   |
| Grievances                       | The clinic's contact details belong in its consent notice. Respond within the period the DPDP Rules require                                                                                                                                                                                         |

## Retention

Each clinic sets `privacy.retention_days` and `privacy.mode` in its config (presets: 365 days, `anonymize`).
A daily job (02:30 UTC) processes leads with no activity since then (no new message, no appointment, including upcoming ones):

- `anonymize` (default): name, email and phone removed, message text replaced with `[removed]`, answers and consent
  evidence deleted. Counts stay, so reports remain correct.
- `delete`: the lead and everything about it is deleted.

Leave `privacy` out to keep data until erased manually. Every run is audited.

## Processors and where data goes

| Service                             | What it receives                                                                                                                                    | Notes                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Meta (WhatsApp Cloud API, Lead Ads) | Phone, message text                                                                                                                                 | The channel itself                                                     |
| AI provider(s), see below           | Conversation text (identifiers redacted), first name, clinic knowledge                                                                              | Only providers the clinic allows and its notice names; default Google  |
| Resend                              | Staff alerts, weekly reports (counts, no patient lists)                                                                                             | Only with `RESEND_API_KEY`                                             |
| Google Calendar                     | Out: appointment time, service, patient first name and phone. In: only the time of other events (titles and attendees are never read, never stored) | Only if the clinic connects it; erasure removes our events from Google |
| Client webhooks                     | Lead name, phone, email, status                                                                                                                     | Only to URLs the clinic adds                                           |

Host the database and app in India (e.g. an AWS/GCP/DigitalOcean Mumbai or Bangalore region, see OPERATIONS).
Cross-border transfer is allowed by the Act except to countries the government restricts. Check the list before
adding a processor.

## AI providers

The assistant runs on Google Gemini Flash-Lite (decision 134). Gemini is the only AI provider (decision 141): no other provider's code or key is in the product.

- **Only Google receives customer text:** `ai.allowed_providers` can only be `['gemini']`, and the router refuses
  any non-Gemini model at run time, so there is no fallback to another provider during an outage (the
  conversation goes to staff instead). The router also skips Gemini when the consent notice doesn't name
  Google, so an old notice never covers it silently. Enforced in code and covered by tests.
- **Demo clinics never reach Gemini:** a clinic on the mock WhatsApp channel gets the rule-based fake for every
  AI task, even when the server has a key (decision 142).
- **Disclosure:** the consent notice must name Google. The presets say replies "may be written by an AI assistant
  (processed by Google Gemini)" (before 2026-10-04: "processed by Anthropic"). Saving a config fails until the
  notice names Google. A clinic set up before the switch must be told, and its notice updated, before it gets AI
  replies again.
- **Minimisation:** before any text goes to a provider, phone numbers, email addresses and Aadhaar/PAN-like numbers
  in customer messages are replaced with `[phone]`, `[email]`, `[id number]`. Photos and voice notes are never
  sent to an AI. The lead's first name stays (replies use it).
- **No training on customer data:** Google's terms, checked on 2026-10-02:

  | Provider      | Trains on API data?                                                              | Retention          | What to use                                                       |
  | ------------- | -------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------- |
  | Google Gemini | **Free tier: yes, content is used to improve Google's products. Paid tier: no.** | Per Google's terms | **Paid tier only**; never put a free-tier key in `GEMINI_API_KEY` |

  Re-check these before go-live; terms change.

- **Data location:** Google processes data outside India. That is allowed under the DPDP Act unless the
  government restricts the destination country; record the provider in the clinic's DPA.

## Breaches

If personal data is exposed, the agency records it in the **breach register**
(`POST /v1/admin/breaches`, agency admins only): when it was detected, what happened, how many people,
when the Data Protection Board was told, when affected people were told. The DPDP Rules require telling the
Board and affected people without delay, with a detailed report within 72 hours.
Steps are in [OPERATIONS.md](OPERATIONS.md#incident-personal-data-breach).

## Children

Clinics may get enquiries about children. The assistant talks only to the adult who enquires. Don't run
lead ads aimed at under-18s; processing a child's data needs verifiable parental consent under the Act.
