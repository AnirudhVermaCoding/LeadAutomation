import { and, eq, inArray } from 'drizzle-orm';
import { attendeeOf, BookingError, type BookingDeps } from './booking.ts';
import { getActiveConfig } from './config-store.ts';
import { withTenant } from './db/client.ts';
import { ACTIVE_APPOINTMENT_STATUSES, appointments, leads, waitlistEntries } from './db/schema.ts';
import { emit } from './leads.ts';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Put someone on the waitlist for a service (assistant tool or staff). If they already hold an upcoming
 * booking for that service, the entry is for an earlier time and accepting an offer moves that booking.
 * One open entry per person and service (partial unique index): joining twice is a no-op.
 */
export async function joinWaitlist(
  deps: BookingDeps,
  tenantId: string,
  input: {
    leadId: string;
    service: string;
    fromDate?: string | undefined;
    toDate?: string | undefined;
    partOfDay?: 'morning' | 'afternoon' | 'evening' | undefined;
    forName?: string | null | undefined;
    resource?: string | undefined;
    source: 'assistant' | 'staff';
  },
) {
  return withTenant(deps.db, tenantId, async (tx) => {
    const config = (await getActiveConfig(tx))?.config;
    if (!config) throw new Error('tenant has no config');
    const service = config.booking.services.find((s) => s.name.toLowerCase() === input.service.toLowerCase());
    if (!service) throw new BookingError('unknown_service', `Unknown service "${input.service}"`);
    for (const d of [input.fromDate, input.toDate])
      if (d !== undefined && !DATE.test(d)) throw new BookingError('unavailable', `Bad date ${d}`);
    const [lead] = await tx.select({ name: leads.name }).from(leads).where(eq(leads.id, input.leadId));
    if (!lead) throw new BookingError('no_appointment', 'Lead not found');
    const attendee = attendeeOf(lead, input.forName) ?? null;
    const [held] = (
      await tx
        .select({ id: appointments.id, attendee: appointments.attendeeName })
        .from(appointments)
        .where(
          and(
            eq(appointments.leadId, input.leadId),
            eq(appointments.service, service.name),
            inArray(appointments.status, [...ACTIVE_APPOINTMENT_STATUSES]),
          ),
        )
    ).filter((a) => (a.attendee ?? '').toLowerCase() === (attendee ?? '').toLowerCase());
    const [row] = await tx
      .insert(waitlistEntries)
      .values({
        leadId: input.leadId,
        service: service.name,
        resource: input.resource ?? null,
        attendeeName: attendee,
        appointmentId: held?.id ?? null,
        fromDate: input.fromDate ?? null,
        toDate: input.toDate ?? null,
        partOfDay: input.partOfDay ?? null,
        source: input.source,
        joinedAt: deps.clock.now(),
      })
      .onConflictDoNothing()
      .returning({ id: waitlistEntries.id });
    if (row)
      await emit(tx, deps.clock, 'waitlist.joined', {
        leadId: input.leadId,
        entryId: row.id,
        service: service.name,
      });
    return { joined: true, already_waiting: !row, wants_earlier_than_current_booking: Boolean(held) };
  });
}
