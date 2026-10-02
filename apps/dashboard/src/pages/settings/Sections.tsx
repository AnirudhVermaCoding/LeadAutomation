import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { TenantConfig } from '../../api.ts';
import { Button, Card, Field, Input, Select, Textarea } from '../../ui.tsx';
import type { Edit } from '../Settings.tsx';

type Props = { draft: TenantConfig; edit: Edit };
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const LANGS = [
  ['en', 'English'],
  ['hi', 'Hindi'],
  ['hinglish', 'Hinglish'],
] as const;

/** Comma-separated list input that keeps what you type until you leave the field. */
function ListInput({
  value,
  onChange,
  placeholder,
}: {
  value: readonly (string | number)[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <Input
      value={text ?? value.join(', ')}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text !== null)
          onChange(
            text
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          );
        setText(null);
      }}
    />
  );
}
const num = (v: string) => (v === '' ? 0 : Number(v));

function RemoveButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <Button variant="ghost" size="sm" onClick={onClick} aria-label={label}>
      <Trash2 className="size-3.5" aria-hidden />
    </Button>
  );
}

export function BusinessSection({ draft, edit }: Props) {
  const { brand, locale } = draft;
  return (
    <>
      <Card title="Brand and assistant">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Business name">
            <Input
              value={brand.business_name}
              onChange={(e) => edit((d) => void (d.brand.business_name = e.target.value))}
            />
          </Field>
          <Field label="Assistant name" hint="What the WhatsApp assistant calls itself">
            <Input
              value={brand.assistant_name}
              onChange={(e) => edit((d) => void (d.brand.assistant_name = e.target.value))}
            />
          </Field>
          <Field label="Tone" hint="e.g. warm and brief, like a good receptionist">
            <Input value={brand.tone} onChange={(e) => edit((d) => void (d.brand.tone = e.target.value))} />
          </Field>
          <Field label="Default language">
            <Select
              value={brand.default_language}
              onChange={(e) =>
                edit(
                  (d) => void (d.brand.default_language = e.target.value as typeof d.brand.default_language),
                )
              }
            >
              {LANGS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </Select>
          </Field>
          <fieldset className="sm:col-span-2">
            <legend className="text-xs font-medium text-slate-700">Languages the assistant replies in</legend>
            <div className="mt-1 flex gap-4">
              {LANGS.map(([v, l]) => (
                <label key={v} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={brand.languages.includes(v)}
                    onChange={(e) =>
                      edit((d) => {
                        d.brand.languages = e.target.checked
                          ? [...d.brand.languages, v]
                          : d.brand.languages.filter((x) => x !== v);
                      })
                    }
                  />
                  {l}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </Card>

      <Card title="Hours">
        <div className="space-y-3">
          {locale.business_hours.map((h, i) => (
            <div key={i} className="flex flex-wrap items-end gap-3 rounded-lg bg-slate-50 p-3">
              <fieldset>
                <legend className="text-xs font-medium text-slate-700">Days</legend>
                <div className="mt-1 flex flex-wrap gap-2">
                  {WEEKDAYS.map((day) => (
                    <label key={day} className="flex items-center gap-1 text-xs capitalize">
                      <input
                        type="checkbox"
                        checked={h.days.includes(day)}
                        onChange={(e) =>
                          edit((d) => {
                            const row = d.locale.business_hours[i]!;
                            row.days = e.target.checked
                              ? [...row.days, day]
                              : row.days.filter((x) => x !== day);
                          })
                        }
                      />
                      {day}
                    </label>
                  ))}
                </div>
              </fieldset>
              <Field label="Open">
                <Input
                  type="time"
                  value={h.open}
                  onChange={(e) => edit((d) => void (d.locale.business_hours[i]!.open = e.target.value))}
                />
              </Field>
              <Field label="Close">
                <Input
                  type="time"
                  value={h.close}
                  onChange={(e) => edit((d) => void (d.locale.business_hours[i]!.close = e.target.value))}
                />
              </Field>
              <RemoveButton
                label="Remove hours row"
                onClick={() => edit((d) => void d.locale.business_hours.splice(i, 1))}
              />
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              edit((d) => void d.locale.business_hours.push({ days: ['sun'], open: '10:00', close: '14:00' }))
            }
          >
            <Plus className="size-3.5" aria-hidden /> Add hours
          </Button>
          <div className="grid gap-4 border-t border-slate-100 pt-4 sm:grid-cols-3">
            <Field label="Time zone">
              <Input
                value={locale.timezone}
                onChange={(e) => edit((d) => void (d.locale.timezone = e.target.value))}
              />
            </Field>
            <Field label="Quiet hours start" hint="No follow-ups or reminders between these times">
              <Input
                type="time"
                value={locale.quiet_hours.start}
                onChange={(e) => edit((d) => void (d.locale.quiet_hours.start = e.target.value))}
              />
            </Field>
            <Field label="Quiet hours end">
              <Input
                type="time"
                value={locale.quiet_hours.end}
                onChange={(e) => edit((d) => void (d.locale.quiet_hours.end = e.target.value))}
              />
            </Field>
          </div>
        </div>
      </Card>

      <Card title="Consent and opt-out">
        <div className="space-y-4">
          <Field
            label="Consent notice"
            hint="Shown on forms and stored with every lead as evidence. You can use {{business_name}}."
          >
            <Textarea
              value={draft.intake.consent_notice_text}
              onChange={(e) => edit((d) => void (d.intake.consent_notice_text = e.target.value))}
            />
          </Field>
          <Field
            label="Opt-out keywords"
            hint="Comma-separated. One-word keywords must be the whole message."
          >
            <ListInput
              value={draft.intake.opt_out_keywords}
              onChange={(v) => edit((d) => void (d.intake.opt_out_keywords = v))}
            />
          </Field>
        </div>
      </Card>
    </>
  );
}

export function QualificationSection({ draft, edit }: Props) {
  const q = draft.qualification;
  return (
    <>
      <Card title="Questions the assistant asks">
        <div className="space-y-3">
          {q.questions.map((x, i) => (
            <div key={i} className="grid gap-3 rounded-lg bg-slate-50 p-3 sm:grid-cols-[1fr_2fr_auto]">
              <Field label="Key">
                <Input
                  value={x.key}
                  onChange={(e) => edit((d) => void (d.qualification.questions[i]!.key = e.target.value))}
                />
              </Field>
              <Field label="What to find out">
                <Input
                  value={x.hint}
                  onChange={(e) => edit((d) => void (d.qualification.questions[i]!.hint = e.target.value))}
                />
              </Field>
              <div className="flex items-end">
                <RemoveButton
                  label={`Remove question ${x.key}`}
                  onClick={() => edit((d) => void d.qualification.questions.splice(i, 1))}
                />
              </div>
              <Field label="Type">
                <Select
                  value={x.type}
                  onChange={(e) =>
                    edit((d) => void (d.qualification.questions[i]!.type = e.target.value as typeof x.type))
                  }
                >
                  {['choice', 'text', 'yes_no', 'number', 'date'].map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Options"
                hint="For choice questions, comma-separated (lowercase_with_underscores)"
              >
                <ListInput
                  value={x.options ?? []}
                  onChange={(v) =>
                    edit((d) => void (d.qualification.questions[i]!.options = v.length ? v : undefined))
                  }
                />
              </Field>
              <div className="flex items-end gap-3">
                <Field label="Weight">
                  <Input
                    type="number"
                    min={0}
                    max={10}
                    className="w-20"
                    value={x.weight}
                    onChange={(e) =>
                      edit((d) => void (d.qualification.questions[i]!.weight = num(e.target.value)))
                    }
                  />
                </Field>
                <label className="flex items-center gap-1.5 pb-2 text-sm">
                  <input
                    type="checkbox"
                    checked={x.required}
                    onChange={(e) =>
                      edit((d) => void (d.qualification.questions[i]!.required = e.target.checked))
                    }
                  />
                  Required
                </label>
              </div>
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              edit(
                (d) =>
                  void d.qualification.questions.push({
                    key: 'new_question',
                    hint: '',
                    type: 'text',
                    required: false,
                    weight: 1,
                  }),
              )
            }
          >
            <Plus className="size-3.5" aria-hidden /> Add question
          </Button>
        </div>
      </Card>
      <Card title="Scoring">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Hot at score ≥">
            <Input
              type="number"
              value={q.scoring.hot}
              onChange={(e) => edit((d) => void (d.qualification.scoring.hot = num(e.target.value)))}
            />
          </Field>
          <Field label="Warm at score ≥">
            <Input
              type="number"
              value={q.scoring.warm}
              onChange={(e) => edit((d) => void (d.qualification.scoring.warm = num(e.target.value)))}
            />
          </Field>
          <Field label="Max messages per qualification">
            <Input
              type="number"
              value={q.max_turns}
              onChange={(e) => edit((d) => void (d.qualification.max_turns = num(e.target.value)))}
            />
          </Field>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Score = sum of weights of answered questions (scaled by option scores). Computed by code, never by
          the AI.
        </p>
      </Card>
      <Card title="Safety">
        <div className="space-y-4">
          <Field
            label="Emergency keywords"
            hint="Any of these in a message: the fixed reply below is sent and a person takes over. Comma-separated."
          >
            <ListInput
              value={q.safety.emergency_keywords}
              onChange={(v) => edit((d) => void (d.qualification.safety.emergency_keywords = v))}
            />
          </Field>
          <Field label="Emergency reply">
            <Textarea
              value={q.safety.emergency_response}
              onChange={(e) => edit((d) => void (d.qualification.safety.emergency_response = e.target.value))}
            />
          </Field>
          {(['hi', 'hinglish'] as const).map((lang) => (
            <Field
              key={lang}
              label={`Emergency reply in ${lang === 'hi' ? 'Hindi' : 'Hinglish'} (optional)`}
              hint="Sent when the customer writes in this language; otherwise the reply above."
            >
              <Textarea
                value={q.safety.emergency_response_i18n?.[lang] ?? ''}
                onChange={(e) =>
                  edit((d) => {
                    const s = d.qualification.safety;
                    s.emergency_response_i18n = {
                      ...s.emergency_response_i18n,
                      [lang]: e.target.value || undefined,
                    };
                  })
                }
              />
            </Field>
          ))}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={q.safety.no_medical_advice}
              onChange={(e) =>
                edit((d) => void (d.qualification.safety.no_medical_advice = e.target.checked))
              }
            />
            Never give medical advice (clinics)
          </label>
        </div>
      </Card>
    </>
  );
}

export function KnowledgeSection({ draft, edit }: Props) {
  return (
    <Card
      title="What the assistant knows"
      actions={
        <span className="text-xs text-slate-500">
          It may use only this — never invents prices or doctors.
        </span>
      }
    >
      <div className="space-y-3">
        {draft.qualification.knowledge.map((k, i) => (
          <div key={i} className="space-y-2 rounded-lg bg-slate-50 p-3">
            <div className="flex items-end gap-2">
              <Field label="Title">
                <Input
                  value={k.title}
                  onChange={(e) => edit((d) => void (d.qualification.knowledge[i]!.title = e.target.value))}
                />
              </Field>
              <RemoveButton
                label={`Remove ${k.title}`}
                onClick={() => edit((d) => void d.qualification.knowledge.splice(i, 1))}
              />
            </div>
            <Textarea
              rows={3}
              value={k.content}
              onChange={(e) => edit((d) => void (d.qualification.knowledge[i]!.content = e.target.value))}
              aria-label={`${k.title} content`}
            />
          </div>
        ))}
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            edit((d) => void d.qualification.knowledge.push({ title: 'New topic', content: '' }))
          }
        >
          <Plus className="size-3.5" aria-hidden /> Add topic
        </Button>
      </div>
    </Card>
  );
}

export function BookingSection({ draft, edit }: Props) {
  const b = draft.booking;
  return (
    <Card title="Services and booking rules">
      <div className="space-y-3">
        {b.services.map((s, i) => (
          <div key={i} className="space-y-2 rounded-lg border border-slate-100 p-3">
            <div className="flex items-end gap-2">
              <Field label="Service">
                <Input
                  value={s.name}
                  onChange={(e) => edit((d) => void (d.booking.services[i]!.name = e.target.value))}
                />
              </Field>
              <Field label="Minutes">
                <Input
                  type="number"
                  className="w-24"
                  value={s.duration_minutes}
                  onChange={(e) =>
                    edit((d) => void (d.booking.services[i]!.duration_minutes = num(e.target.value)))
                  }
                />
              </Field>
              <RemoveButton
                label={`Remove ${s.name}`}
                onClick={() => edit((d) => void d.booking.services.splice(i, 1))}
              />
            </div>
            <Field
              label="Good first step for"
              hint="Concerns in customers' words, comma-separated. The assistant suggests this service when someone describes one of them."
            >
              <ListInput
                value={s.suitable_for ?? []}
                placeholder="tooth pain, bleeding gums, sensitivity"
                onChange={(list) =>
                  edit((d) => void (d.booking.services[i]!.suitable_for = list.length ? list : undefined))
                }
              />
            </Field>
          </div>
        ))}
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            edit((d) => void d.booking.services.push({ name: 'New service', duration_minutes: 30 }))
          }
        >
          <Plus className="size-3.5" aria-hidden /> Add service
        </Button>
        <div className="grid gap-4 border-t border-slate-100 pt-4 sm:grid-cols-4">
          <Field label="Slot every (min)">
            <Input
              type="number"
              value={b.slot_minutes}
              onChange={(e) => edit((d) => void (d.booking.slot_minutes = num(e.target.value)))}
            />
          </Field>
          <Field label="Buffer (min)">
            <Input
              type="number"
              value={b.buffer_minutes}
              onChange={(e) => edit((d) => void (d.booking.buffer_minutes = num(e.target.value)))}
            />
          </Field>
          <Field label="Times offered">
            <Input
              type="number"
              min={1}
              max={5}
              value={b.offer_slots}
              onChange={(e) => edit((d) => void (d.booking.offer_slots = num(e.target.value)))}
            />
          </Field>
          <Field label="Bookings">
            <Select
              value={b.mode}
              onChange={(e) => edit((d) => void (d.booking.mode = e.target.value as typeof b.mode))}
            >
              <option value="staff_confirm">Staff confirm each</option>
              <option value="auto_confirm">Confirm automatically</option>
            </Select>
          </Field>
          <Field label="Alert staff by">
            <Select
              value={b.staff_notify.channel}
              onChange={(e) =>
                edit(
                  (d) =>
                    void (d.booking.staff_notify.channel = e.target.value as typeof b.staff_notify.channel),
                )
              }
            >
              <option value="whatsapp">WhatsApp</option>
              <option value="email">Email</option>
            </Select>
          </Field>
          <Field label={b.staff_notify.channel === 'email' ? 'Staff email' : 'Staff WhatsApp number'}>
            <Input
              value={b.staff_notify.to}
              onChange={(e) => edit((d) => void (d.booking.staff_notify.to = e.target.value))}
            />
          </Field>
        </div>
      </div>
    </Card>
  );
}

export function MessagesSection({ draft, edit }: Props) {
  const s = draft.sequences;
  return (
    <Card title="Follow-ups, reminders and reviews">
      <div className="space-y-4">
        <div>
          <p className="mb-2 text-xs font-medium text-slate-700">Follow-ups to leads who go quiet</p>
          {s.followup.steps.map((step, i) => (
            <div key={i} className="mb-2 flex items-end gap-2">
              <Field label={`Follow-up ${i + 1} after (hours)`}>
                <Input
                  type="number"
                  className="w-28"
                  value={step.after_hours}
                  onChange={(e) =>
                    edit((d) => void (d.sequences.followup.steps[i]!.after_hours = num(e.target.value)))
                  }
                />
              </Field>
              <Field label="Channel">
                <Select
                  value={step.channel}
                  onChange={(e) =>
                    edit(
                      (d) =>
                        void (d.sequences.followup.steps[i]!.channel = e.target.value as typeof step.channel),
                    )
                  }
                >
                  <option value="whatsapp">WhatsApp</option>
                  <option value="email">Email</option>
                  <option value="email_or_whatsapp">Email if known, else WhatsApp</option>
                </Select>
              </Field>
              <RemoveButton
                label="Remove follow-up"
                onClick={() => edit((d) => void d.sequences.followup.steps.splice(i, 1))}
              />
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              edit((d) => void d.sequences.followup.steps.push({ after_hours: 168, channel: 'whatsapp' }))
            }
          >
            <Plus className="size-3.5" aria-hidden /> Add follow-up
          </Button>
        </div>
        <div className="grid gap-4 border-t border-slate-100 pt-4 sm:grid-cols-3">
          <Field label="Reminders before appointment (hours)" hint="Comma-separated, e.g. 24, 2">
            <ListInput
              value={s.reminders.before_hours}
              onChange={(v) =>
                edit((d) => void (d.sequences.reminders.before_hours = v.map(Number).filter((n) => n > 0)))
              }
            />
          </Field>
          <Field label="No-show message after (hours)">
            <Input
              type="number"
              value={s.no_show_recovery.after_hours}
              onChange={(e) =>
                edit((d) => void (d.sequences.no_show_recovery.after_hours = num(e.target.value)))
              }
            />
          </Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input
              type="checkbox"
              checked={s.no_show_recovery.enabled}
              onChange={(e) => edit((d) => void (d.sequences.no_show_recovery.enabled = e.target.checked))}
            />
            Send no-show recovery
          </label>
          <Field label="Google review link">
            <Input
              type="url"
              value={s.review_request.google_review_link ?? ''}
              onChange={(e) =>
                edit(
                  (d) => void (d.sequences.review_request.google_review_link = e.target.value || undefined),
                )
              }
            />
          </Field>
          <Field label="Review request after visit (hours)">
            <Input
              type="number"
              value={s.review_request.after_hours}
              onChange={(e) =>
                edit((d) => void (d.sequences.review_request.after_hours = num(e.target.value)))
              }
            />
          </Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input
              type="checkbox"
              checked={s.review_request.enabled}
              onChange={(e) => edit((d) => void (d.sequences.review_request.enabled = e.target.checked))}
            />
            Ask for a review
          </label>
        </div>
      </div>
    </Card>
  );
}

export function ReportsSection({ draft, edit }: Props) {
  const r = draft.reports;
  return (
    <Card title="Weekly report">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Send on">
          <Select
            value={r.weekly_day}
            onChange={(e) => edit((d) => void (d.reports.weekly_day = e.target.value as typeof r.weekly_day))}
          >
            {WEEKDAYS.map((d) => (
              <option key={d} value={d} className="capitalize">
                {d}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Send to" hint="Comma-separated emails">
          <ListInput value={r.send_to} onChange={(v) => edit((d) => void (d.reports.send_to = v))} />
        </Field>
        <Field
          label="Also on WhatsApp"
          hint="One-line summary to these numbers, e.g. +919876543210. Needs the report template approved."
        >
          <ListInput
            value={r.whatsapp_to ?? []}
            onChange={(v) => edit((d) => void (d.reports.whatsapp_to = v.length ? v : undefined))}
          />
        </Field>
        <Field label="Average visit value (₹)" hint="Used to estimate revenue recovered">
          <Input
            type="number"
            value={r.avg_transaction_value}
            onChange={(e) => edit((d) => void (d.reports.avg_transaction_value = num(e.target.value)))}
          />
        </Field>
      </div>
    </Card>
  );
}

/** Rules for changing and confirming bookings. */
export function BookingPolicySection({ draft, edit }: Props) {
  const b = draft.booking;
  return (
    <Card title="Changes, cancellations and confirmation">
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Customers can change or cancel up to (hours before the visit)"
            hint="Inside this window the assistant hands the request to your team. Staff can always change bookings. Default 2."
          >
            <Input
              type="number"
              min={0}
              value={b.change_notice_hours ?? 2}
              onChange={(e) => edit((d) => void (d.booking.change_notice_hours = num(e.target.value)))}
            />
          </Field>
          <label className="flex items-start gap-2 text-sm">
            <input
              className="mt-1"
              type="checkbox"
              checked={b.auto_confirm_pending ?? true}
              onChange={(e) => edit((d) => void (d.booking.auto_confirm_pending = e.target.checked))}
            />
            <span>
              Confirm automatically if staff do not
              <span className="block text-xs text-slate-500">
                Staff-confirm bookings are confirmed for the customer at the deadline (the evening before, or
                4 hours before). Untick to only remind staff.
              </span>
            </span>
          </label>
        </div>
        <Field
          label="Cancellation policy"
          hint="Shown to customers who ask or who are too late to cancel, for example: Please give 24 hours notice; late cancellations are charged 50%."
        >
          <Textarea
            value={b.cancellation_policy ?? ''}
            maxLength={500}
            onChange={(e) => edit((d) => void (d.booking.cancellation_policy = e.target.value || undefined))}
          />
        </Field>
      </div>
    </Card>
  );
}

const PROVIDERS = [
  ['anthropic', 'Anthropic (Claude)'],
  ['openai', 'OpenAI'],
  ['gemini', 'Google Gemini'],
  ['xai', 'xAI (Grok)'],
] as const;

/** Which AI may read conversations, how much it may spend, and how long data is kept. */
export function AiPrivacySection({ draft, edit }: Props) {
  const ai = draft.ai ?? { allowed_providers: ['anthropic' as const], monthly_cost_cap_usd: 50 };
  const privacy = draft.privacy ?? { retention_days: 365, mode: 'anonymize' as const };
  return (
    <>
      <Card title="AI assistant">
        <div className="space-y-4">
          <Field
            label="AI providers allowed to process this business's conversations"
            hint="Anthropic is the default. Adding another provider means telling your customers: name it in the consent notice (Business tab) or the config will not save."
          >
            <div className="flex flex-wrap gap-4">
              {PROVIDERS.map(([key, label]) => (
                <label key={key} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={ai.allowed_providers.includes(key)}
                    onChange={(e) =>
                      edit((d) => {
                        const cur = d.ai ?? {
                          allowed_providers: ['anthropic' as const],
                          monthly_cost_cap_usd: 50,
                        };
                        const set = new Set(cur.allowed_providers);
                        if (e.target.checked) set.add(key);
                        else set.delete(key);
                        d.ai = { ...cur, allowed_providers: [...set] };
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </div>
          </Field>
          <Field
            label="Monthly AI budget (US$)"
            hint="You are warned at 80%. At 100% new conversations go to your team until next month or a higher budget."
          >
            <Input
              type="number"
              className="w-40"
              min={0}
              value={ai.monthly_cost_cap_usd}
              onChange={(e) =>
                edit((d) => {
                  const cur = d.ai ?? { allowed_providers: ['anthropic' as const], monthly_cost_cap_usd: 50 };
                  d.ai = { ...cur, monthly_cost_cap_usd: num(e.target.value) };
                })
              }
            />
          </Field>
          <p className="text-xs text-slate-500">
            Per-task model routing is advanced: use Export / Import JSON (the ai.routing field).
          </p>
        </div>
      </Card>
      <Card title="How long we keep customer data">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="After this many idle days (0 = never)"
            hint="Idle = no message or appointment. Anyone with an upcoming appointment is kept."
          >
            <Input
              type="number"
              min={0}
              value={privacy.retention_days}
              onChange={(e) =>
                edit(
                  (d) =>
                    void (d.privacy = { ...(d.privacy ?? privacy), retention_days: num(e.target.value) }),
                )
              }
            />
          </Field>
          <Field label="Then" hint="Anonymise keeps the counts for reports and removes the person.">
            <Select
              value={privacy.mode}
              onChange={(e) =>
                edit(
                  (d) =>
                    void (d.privacy = {
                      ...(d.privacy ?? privacy),
                      mode: e.target.value as 'anonymize' | 'delete',
                    }),
                )
              }
            >
              <option value="anonymize">Anonymise</option>
              <option value="delete">Delete</option>
            </Select>
          </Field>
        </div>
      </Card>
    </>
  );
}
