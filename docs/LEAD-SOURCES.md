# Lead sources

Every source ends in the same place: a lead with the consent evidence recorded, and a WhatsApp reply within a minute.

| Source                                                                   | How                                                                             | Status                                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Website form                                                             | Hosted form `/f/<key>` (iframe)                                                 | built                                                                   |
| Their own form / CRM / website backend                                   | `POST /v1/leads` with an API key                                                | built                                                                   |
| CSV of old enquiries                                                     | `POST /v1/leads/import` (consent column required)                               | built                                                                   |
| Facebook / Instagram Lead Ads                                            | Meta webhook `leadgen`                                                          | built                                                                   |
| Click-to-WhatsApp ads, people messaging first                            | WhatsApp inbound                                                                | built                                                                   |
| **Portal emails** (99acres, MagicBricks, Housing.com, Practo, JustDial…) | Forward the portal's notification emails to the clinic's secret address (below) | built, parser fixtures are synthetic                                    |
| Zapier / Make                                                            | `POST /v1/leads` (below)                                                        | documented                                                              |
| Instagram DMs, Facebook Messenger, Google Business Profile messages      |                                                                                 | roadmap (Meta / Google app review; each is its own channel)             |
| Portal APIs / CRM push                                                   |                                                                                 | roadmap (no public push API; portals sell CRM integrations per account) |

## Portal emails

**Settings → Integrations → Leads from portal emails → Create address** gives `https://<domain>/webhooks/email-in/<secret>`.
Anything that can POST an email there works (JSON `{from, subject, text, html}`, or the form fields Mailgun / SendGrid
inbound parse send):

1. **Zapier / Make:** trigger "Email by Zapier" / "Mailhook" (or Gmail "new email matching a search"), action "Webhooks → POST" to the address with `from`, `subject`, `text`.
2. **Mailgun / SendGrid inbound parse:** point a route for e.g. `leads@yourdomain.in` at the address; have the portal send to it (or auto-forward from the clinic's inbox).
3. **Cloudflare Email Workers:** a worker that reads the message and `fetch`es the address.

The parser reads labelled lines ("Name:", "Mobile:", "Email:", "Requirement:", also HTML table rows) and falls back to any
Indian mobile number in the body. An email without a phone number is acknowledged but creates nothing (the dashboard event log
records `lead.email_unparsed`). Rotate the address any time (the old one stops working).

**Verify per portal in the pilot:** the fixtures in `packages/integrations/src/lead-email.test.ts` are _synthetic_, shaped like
portal emails. Forward one real notification from each portal the client uses and check the lead appears with the right name and
number; adjust the label list in `lead-email.ts` if a portal uses other wording.

**Consent:** the customer asked the portal to be contacted about the enquiry; the lead is recorded with source
`portal_email` and that notice text. The clinic should confirm this basis with the portal's terms (and DPDP counsel) before relying on it.

## Zapier / Make into the API

Create an API key (Settings → Integrations → API keys), then POST:

```http
POST /v1/leads
Authorization: Bearer il_…
Content-Type: application/json

{ "phone": "+919876543210", "name": "Priya", "consent": { "granted": true, "notice_text": "…", "page_url": "https://…" } }
```
