# Google Calendar (two-way)

What it does for a clinic or agent:

- **Out:** every booking (and reschedule, cancel, reassignment) is written to their Google Calendar. Completed and no-show
  visits stay on it, marked "Done —" / "No-show —".
- **In:** anything their team puts on a linked calendar (leave, a meeting, a booking taken by phone) blocks those times, so
  the assistant never offers them. The sync reads times only, never titles or attendees.
- **Conflicts:** if an event lands on top of an existing booking, Settings → Booking → Blocked times (badge
  "from Google Calendar") and the Today banner list the affected bookings. **Nothing is sent to the patient** until staff tap
  "Tell them & offer new times".

## How it works

| Piece          | Behaviour                                                                                                                                                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model          | One Google account per clinic. One calendar per doctor / agent, plus an optional clinic-wide calendar (its events block everyone). Mapped in Settings → Integrations → Google Calendar.                                                                                                      |
| Freshness      | `events.watch` push channel per calendar (webhook `POST /webhooks/google-calendar`, token-checked), a 5-minute sweep as the fallback (this is also the only layer on localhost / without public HTTPS), a nightly full re-sync, and a narrow check against Google right before each booking. |
| Sync           | Incremental (`syncToken`). A 410 triggers a full re-sync. Window: 1 day back to 60 days ahead.                                                                                                                                                                                               |
| Our own events | Tagged `extendedProperties.private.instantlead_appt`, so they are never read back as busy.                                                                                                                                                                                                   |
| Event mapping  | Free ("transparent") events, events the owner declined, working-location events: ignored. Tentative: busy. All-day (busy): the whole local day. Recurring events are expanded.                                                                                                               |
| Google down    | Booking still goes through (the database constraint still prevents double booking among ourselves); sync goes stale and the agency is alerted after 30 minutes.                                                                                                                              |
| Access revoked | `invalid_grant` marks the connection "Reconnect needed": a banner in the dashboard, an agency alert, no retry storm. Reconnecting recovers.                                                                                                                                                  |

## Scopes

- `https://www.googleapis.com/auth/calendar.events`: read and write events, and authorizes `events.list` and `events.watch`.
  FreeBusy is deliberately **not** used (it needs `calendar`, `calendar.readonly` or `calendar.freebusy`, which are wider).
- `https://www.googleapis.com/auth/calendar.calendarlist.readonly`: only for the "Add a calendar" picker. Connections made
  without it still work: staff type the calendar's email address instead.

## What you must do in Google Cloud (once, as the agency)

Verified against Google's docs on 2026-10-02.

1. Create a Google Cloud project and **enable the Google Calendar API**.
2. **OAuth consent screen** (Google Auth platform): app name, support email, **authorized domain** (your domain), a **public
   homepage** and a **privacy policy** on that same domain that says how you access, use, store and share Google user data
   (calendar times are read; events we write contain the patient's first name, service and phone; nothing is shared).
3. Add the two scopes above. The console shows each scope's sensitivity (Google's docs don't list it per scope; treat both as
   sensitive).
4. **Credentials → OAuth client (Web application):** authorized redirect URI `https://<your-domain>/v1/integrations/google/callback`.
   Put the client id and secret in the server's `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
5. **Verify the domain** in Google Search Console with an account that is Owner or Editor on the project.
6. **Publish the app** (Publishing status → In production) and **submit for verification**. Google asks for:
   - the homepage and privacy-policy URLs;
   - an unlisted YouTube demo video, in English, showing the consent screen, the OAuth client id in the browser address bar,
     and how each scope is used (events appear in the calendar; times from the calendar remove slots);
   - a justification per scope, including why narrower scopes don't work ("FreeBusy needs a wider scope than calendar.events").
     Typical time for sensitive scopes: 3–5 business days.
7. **Until verification is done:**
   - While the project is in **Testing**, refresh tokens expire after **7 days** (Google's documented rule for Testing
     projects), so the clinic's calendar would silently stop syncing weekly. Only use Testing for your own demos.
   - For a pilot, publish **In production** without verification: users see an "unverified app" warning screen and there is a
     cap on users while unverified (check the exact cap in your console). Or add the pilot clinic's Google account as a test
     user and reconnect it weekly.
8. Push notifications need your public HTTPS URL to have a valid certificate (Caddy provides one). The domain must be reachable
   from Google. If it is not, the sweep still keeps busy time fresh within ~5 minutes.

Other reasons a refresh token dies (so "Reconnect needed" can appear in production): the user revoked access, 6 months unused,
or more than 100 live tokens for one Google account and client id.

## Operating notes

- Settings → Integrations → Google Calendar shows each calendar's last check, whether live updates are on, and how many
  external events are blocking time. **Sync now** forces a full re-sync. **Disconnect** stops the channels, forgets Google busy
  time and the token; events already written to the calendar stay there.
- Erasing a lead (or retention) removes their events from Google through the `calendar-remove` job.
- Mock mode needs no credentials: an in-memory Google per clinic ("Connect Google Calendar (demo)"); `pnpm demo` scenario 6
  (`staffBlocksTimeInGoogle`) walks through the flow. Dev endpoints: `/v1/dev/google/connect`, `/external-event`, `/revoke`.
- Outlook / Office 365 is on the roadmap behind the same `CalendarProvider` interface.
