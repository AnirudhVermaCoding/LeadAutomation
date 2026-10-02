# Demo script (10 minutes, mock mode, no credentials)

**Setup (before the call):** `pnpm db:local`, `pnpm db:migrate && pnpm db:seed`, `pnpm build && pnpm dev`.
Sign in at http://localhost:3000 as `admin@demo-clinic.test` / `dev-demo-password`. Have a second
tab on **Today**. Optional: run `pnpm demo` once beforehand; it proves all four flows and fills Reports.

The story: _"Clinics lose most enquiries because nobody replies for hours. Here is what happens to an
enquiry when InstantLead is switched on."_

## 1. The enquiry (2 min) — Demo sandbox

1. Open **Demo sandbox**. Enter the prospect's name and a fake number, press **Submit the website form**.
2. Point at the clock on the reply: the WhatsApp template arrives in about a second (the promise is under 60 s, around the clock).
   _"This is the approved WhatsApp template, the only kind of message WhatsApp allows before the patient writes."_
3. Tap a quick-reply button, or type _"Hi, I need teeth whitening"_.

## 2. Qualification and booking (3 min)

1. The assistant asks one question at a time (how soon, which treatment), in the clinic's tone.
   Show Hindi or Hinglish: type _"mujhe braces lagwane hain"_; it answers in Hinglish.
2. Ask _"how much is whitening?"_: the price comes from the clinic's own knowledge, never invented.
3. Answer _"this week"_: it offers three real free slots from the clinic's hours. Reply **1**.
4. Right panel, **What the clinic sees**: the lead is scored (hot / warm / cold) with the answers captured, and the staff alert has gone out.
5. Second tab, **Today**: the booking is there. Press **Confirm** if the clinic uses staff confirmation.

Optional safety beat: type _"I have severe chest pain"_. It gives the emergency message and hands over to staff; the AI pauses.

## 3. Reminders, no-shows, reviews (2 min) — Fast-forward

1. **Fast-forward +22 hours**: the 24 h reminder arrives with _Confirm / Reschedule / Cancel_ buttons. Tap **Confirm**.
2. Fast-forward to the visit, then on **Today** press **No-show**: the recovery message offers to rebook.
   _(Or press **Completed**: three hours later the Google review request goes out.)_
3. _"Every one of these is automatic and stops itself the moment the patient replies, books or opts out."_

## 3b. When plans change (1 min) — Settings → Booking, Today

- Block "Dr Mehta, Thursday" in Blocked times: the bookings already inside it are listed, and nothing has been sent
  yet. Tap **Tell them & offer new times**. Back in the Sandbox, the patient gets a polite apology with a
  [Show new times] button; tapping it offers new free times.
- On Today, tap **Running late** (30 min): everyone still booked today gets a heads-up.

## 4. The silent lead (1 min)

New form lead, don't reply. **+2 days**: friendly follow-up. **+3 days**: last follow-up. Two days later the lead
is marked _unresponsive_ and never chased again. Typing **STOP** at any point opts them out for good.

## 5. Inbox and takeover (1 min) — Inbox

Open the conversation: full thread, delivery ticks, answers, appointment. **Take over** pauses the AI so the front
desk can reply themselves; **Hand back to AI** resumes it.

## 6. The owner's Monday email (1 min) — Reports

Show the funnel (enquiries → replied → qualified → booked → visited), median first-reply time, show rate and
"revenue from visits", then **Preview report email**. _"Counted from the records, not estimated by AI."_

## Questions that come up

- **Is this the official WhatsApp?** Yes, the Meta Cloud API with the clinic's own verified number. No unofficial apps, so no bans.
- **What does it cost to run?** WhatsApp charges per template message (utility is cheap; follow-ups are marketing). AI cost is capped per lead. Both appear on the report.
- **Patient data?** Hosted in India, consent recorded per lead, STOP honoured instantly, retention and erasure built in (see PRIVACY.md).
- **Our existing website and Facebook ads?** Embed our form, or post to our API; Lead Ads connect directly. Go-live in under a day.
