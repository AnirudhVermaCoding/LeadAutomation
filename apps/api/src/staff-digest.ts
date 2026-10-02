import { formatSlot, localParts, zonedTimeToUtc } from '@instantlead/core';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { getActiveConfig } from './config-store.ts';
import { withTenant, type Db } from './db/client.ts';
import { appointments, events, leads } from './db/schema.ts';
import { emit, type LeadDeps } from './leads.ts';
import { sendStaffNote, type NotifyDeps } from './notify.ts';

/**
 * Visits nobody marked Completed / No-show: no review request or recovery message goes out
 * for them, and the report undercounts. At closing time (and again after opening the next
 * morning while any are left) staff get one note listing them. Hourly cron; deduped per day+slot.
 */
export async function runStaffDigest(
  deps: LeadDeps & NotifyDeps & { db: Db; system: { listTenants(): Promise<{ id: string }[]> } },
) {
  const now = deps.clock.now();
  const sent: string[] = [];
  for (const { id: tenantId } of await deps.system.listTenants()) {
    const due = await withTenant(deps.db, tenantId, async (tx) => {
      const config = (await getActiveConfig(tx))?.config;
      if (!config) return null;
      const tz = config.locale.timezone;
      const local = localParts(now, tz);
      const today = config.locale.business_hours.filter((h) => h.days.includes(local.weekday));
      if (!today.length) return null;
      const open = today.map((h) => h.open).sort()[0]!;
      const close = today
        .map((h) => h.close)
        .sort()
        .at(-1)!;
      const at = (hhmm: string) => zonedTimeToUtc(local.date, hhmm, tz).getTime();
      const t = now.getTime();
      const slot =
        t >= at(close) && t < at(close) + 65 * 60_000
          ? 'evening'
          : t >= at(open) + 30 * 60_000 && t < at(open) + 95 * 60_000
            ? 'morning'
            : null;
      if (!slot) return null;
      const key = `${local.date}:${slot}`;
      const [already] = await tx
        .select({ id: events.id })
        .from(events)
        .where(and(eq(events.type, 'staff.unmarked_digest'), sql`${events.payload}->>'key' = ${key}`));
      if (already) return null;
      const unmarked = await tx
        .select({
          name: leads.name,
          phone: leads.phoneE164,
          startsAt: appointments.startsAt,
          service: appointments.service,
        })
        .from(appointments)
        .innerJoin(leads, eq(leads.id, appointments.leadId))
        .where(
          and(
            inArray(appointments.status, ['pending', 'scheduled', 'confirmed']),
            lt(appointments.endsAt, now),
            sql`${appointments.startsAt} > ${new Date(t - 7 * 86_400_000)}`,
          ),
        )
        .orderBy(appointments.startsAt);
      if (!unmarked.length) return null;
      await emit(tx, deps.clock, 'staff.unmarked_digest', { key, count: unmarked.length });
      const list = unmarked
        .slice(0, 6)
        .map((u) => `${u.name?.split(/\s+/)[0] ?? u.phone} ${formatSlot(u.startsAt, tz)}`)
        .join(', ');
      return {
        key,
        note: `${unmarked.length} visit${unmarked.length === 1 ? ' is' : 's are'} not marked yet (${list}${unmarked.length > 6 ? ', …' : ''}); tap Completed or No-show on Today so reviews and rebooking messages go out`,
      };
    });
    if (!due) continue;
    await sendStaffNote(deps, tenantId, due.note, `digest:${due.key}`);
    sent.push(tenantId);
  }
  return sent;
}
