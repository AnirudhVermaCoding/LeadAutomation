# Onboarding a new clinic (target: live in under a day, no code changes)

Everything below is done in the dashboard (as agency admin) or in the client's Meta accounts.
The **Settings → Go-live checklist** tracks progress; a clinic is live when it shows 9/9.
Meta steps were checked against Meta's docs on 2026-10-01; Meta moves buttons around, so follow the names, not screenshots.

## 0. Before the call (agency, 10 min)

1. **Agency → New client**: name, slug, preset (`clinic_dental`, `clinic_skin`, `clinic_hair` or `real_estate`) and the clinic admin's email + a temporary password. The tenant starts in mock mode with sample content.
2. Send the client this list to have ready: services with durations and prices, opening hours, doctors/chairs, staff WhatsApp number for alerts, owner email for reports, Google review link, and admin access to their Meta Business account.

## 1. Business setup (with the client, ~1 h)

In **Settings** (each tab saves the whole config; errors appear in plain English in the save bar):

| Tab       | What to fill in                                                                                                                                                                          |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Business  | Business and assistant name, tone, languages, consent notice wording                                                                                                                     |
| Questions | Qualification questions and answer scores (presets are sensible; adjust wording)                                                                                                         |
| Knowledge | Services, prices, FAQs, location/parking. **Remove every `SAMPLE` text** — the checklist checks it                                                                                       |
| Booking   | Services + durations, bookable hours per weekday, resources (doctors/chairs), buffer, minimum notice, auto-confirm vs. staff-confirm, staff alert number/email, blocked dates (holidays) |
| Messages  | Follow-up timing, quiet hours, Google review link                                                                                                                                        |
| Reports   | Weekly report day and recipients, average visit value (used for "revenue from visits")                                                                                                   |

Then open **Demo sandbox** and play a patient end to end (form → reply → questions → booking).
Use **Export JSON** in Settings to keep a copy of the config; **Import JSON** clones it to the clinic's second branch.

## 2. WhatsApp (Meta Cloud API, ~1–2 h + Meta review time)

The client owns the WhatsApp Business Account (WABA); we get access to it.

1. In the client's Meta Business portfolio, **create a Meta app** with the "Connect with customers through WhatsApp" use case (or reuse the agency's app — one app can serve all clients; the webhook is shared).
2. **Add and verify the business phone number** in WhatsApp Manager (a number not already used in the WhatsApp app). Set the display name; Meta reviews it.
3. **Permanent token:** Business Settings → System users → add a system user (admin), assign the app and the WABA, generate a token with `whatsapp_business_messaging`, `whatsapp_business_management` and `business_management`.
4. **Webhook (once per Meta app):** App → WhatsApp → Configuration: callback URL `https://<your-domain>/webhooks/meta`, verify token = `META_VERIFY_TOKEN` from the server's `.env`; subscribe to the **`messages`** field. `META_APP_SECRET` must be the app's secret (signatures are checked on every call).
5. **Subscribe the app to the client's WABA:** `POST https://graph.facebook.com/v23.0/<WABA_ID>/subscribed_apps` with the token (otherwise that number's messages never reach us).
6. **Dashboard → Settings → Integrations → WhatsApp:** paste the _phone number ID_ (not the phone number) and the token. Press **Test** — it checks the number with Meta.
7. **Templates:** submit every template in [TEMPLATES-TO-SUBMIT.md](TEMPLATES-TO-SUBMIT.md) in WhatsApp Manager, English and Hindi, exact names. Approval usually takes minutes to a day. As each is approved, mark it **Approved** in Settings → Messages (until then the system won't send it; first replies to form leads need `il_first_reply`).
8. Send a real test: submit the clinic's website form with your own number. The checklist ticks "Real WhatsApp message delivered" when Meta confirms delivery.

## 3. Lead sources (~30 min)

- **Website form:** Settings → Integrations → Website form gives an embeddable `<iframe>` (hosted at `/f/<key>`) and the plain URL. It records the consent notice shown.
- **Their own form / CRM / website backend:** Settings → Integrations → API keys → create a key; they `POST /v1/leads` with `Authorization: Bearer <key>` and `{ phone, name?, email?, consent: { granted: true, notice_text?, page_url?, ip? } }`. Up to 120 leads/min per IP.
- **CSV import** of existing enquiries: `POST /v1/leads/import` (columns `phone, consent, name, email, language`; rows without consent are rejected).
- **Facebook / Instagram Lead Ads:**
  1. Page token for a user with advertiser access on the Page, with `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `ads_management` and `leads_retrieval`.
  2. In the same Meta app, subscribe the **Page** object's webhook to **`leadgen`** (same callback URL), then `POST /v23.0/<PAGE_ID>/subscribed_apps?subscribed_fields=leadgen` with the Page token.
  3. Settings → Integrations → Lead Ads: Page ID + token.
  4. In each lead form, add the clinic's consent notice (Settings → Business) as the **custom disclaimer**, and include a phone number question.
- **Click-to-WhatsApp ads** need nothing extra: the first message arrives on the connected number.

## 4. AI assistant (5 min)

- **Provider:** every clinic starts on Anthropic (Claude) only. To allow another provider (OpenAI, Google Gemini,
  xAI) for this clinic, first **tell the clinic and get their OK**, then add the provider's name to the consent
  notice (Settings → Business) and to `ai.allowed_providers` (Settings → Import/Export JSON). The config won't
  save until the notice names it. See [PRIVACY.md](PRIVACY.md#ai-providers) for what each provider receives.
- **Budget:** `ai.monthly_cost_cap_usd` (default $50). The agency gets an alert email at 80%. At 100%, new
  conversations are handed to staff until the next month or a higher cap. Agency → Usage shows % used.
- **Services' "Good first step for"** (Settings → Booking): list the concerns each service is for, in patients'
  words ("bleeding gums", "hair fall"). When someone describes a problem, the assistant suggests that service and
  offers to book. It never diagnoses or suggests medicines.
- **Emergency phrases** (Settings → Questions → safety): keep them specific ("face swelling", "bleeding a lot").
  A bare "pain" or "bleeding" would send ordinary patients an ambulance message.
- **Try it:** in Demo sandbox, describe a symptom, ask two questions in one message, ask "are you a bot?", send a
  photo, and paste a vendor pitch. The last one should be tagged "Not a lead" in the Inbox. If the junk filter is
  wrong, use **Mark as real lead**.

## 5. Appointments after booking (15 min with the front desk)

- **Several doctors / agents:** Settings → Booking hours: one row per day _per person_ ("Dr Mehta", "Dr Rao").
  - The assistant books any free one, or only the one a customer asks for. It remembers that preference for
    reschedules.
  - Today and staff alerts show who the booking is with.
- **Staff confirmation (clinics):** WhatsApp bookings arrive as "pending" and the customer gets a "request received"
  message. Then:
  - If nobody taps **Confirm**, staff get a WhatsApp nudge after 30 minutes and again after 2 hours of opening time.
  - At the deadline (the evening before, or 4 hours before at the latest) the booking **auto-confirms**: the
    customer gets the confirmation and normal reminders, and staff get a note.
  - Turn this off with `booking.auto_confirm_pending: false` (nudges only).
- **What the customer receives:**
  1. booking confirmation
  2. the 24 h reminder with Confirm / Reschedule / Cancel
  3. the 2 h reminder
  4. after the visit, the review request (if marked Completed) or a rebooking offer (if marked No-show)

  If they don't tap Confirm on the 24 h reminder, staff are told about 4 hours before the visit, so they can call.

- **Leave or closure:** Settings → Booking → Blocked times. Pick the person (or "Everyone" for a closure) and the
  hours. Bookings already inside that time are listed. Nothing is sent until staff tap **Tell them & offer new
  times**:
  - a booking moves to another free doctor at the same time, where possible (they keep their time)
  - otherwise the customer gets an apology with a **[Show new times]** button, and the assistant rebooks them

  Today shows a banner while any booking inside blocked time hasn't been told.

- **Running late:** Today → choose 15 / 30 / 45 / 60 min → **Running late**. Everyone still booked today is told
  once (a bigger delay later sends again).
- **Mark every visit:** Completed or No-show on Today. Unmarked visits are highlighted. Staff get one reminder at
  closing time (and the next morning) listing them, and the weekly report shows how many were left unmarked.
- **Templates:** three more to submit (see TEMPLATES-TO-SUBMIT.md): `il_appointment_change`, `il_running_late`
  and `il_staff_update`.

## 6. Optional

- **Google Calendar** (one-way: bookings appear in the clinic's calendar): Settings → Integrations → Connect Google Calendar. Needs `GOOGLE_CLIENT_ID/SECRET` on the server.
- **Webhooks** to their CRM / Zapier / Make: Settings → Integrations → Webhooks (see [OPERATIONS.md](OPERATIONS.md#outbound-webhooks) for the signature format).
- **Staff accounts:** create `client_staff` users (Inbox, Today, Sandbox; no settings or erasure).

## 7. Hand-over (15 min)

Show the front desk **Today** (Confirm / Completed / No-show — completion triggers the review request, no-show the recovery message) and **Inbox** (Take over pauses the AI for that patient; Hand back resumes it). Tell the owner when the first weekly report arrives.

## Done when

- Go-live checklist 9/9.
- A real form lead got a WhatsApp reply within a minute and could book.
- Owner and front desk know Today and Inbox.
