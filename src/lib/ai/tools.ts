import type { AiAgentConfig } from '@/types'
import { supabaseAdmin } from './admin-client'
import type { ToolSchema } from './providers/types'
import { computeAvailableSlots, resolveDurationMinutes } from './booking/availability'
import { parseDateStr, zonedTimeToUtc } from './booking/timezone'
import { createAppointment, rescheduleAppointment, cancelAppointment } from './booking/manage'
import { sendEmail, EmailNotConfiguredError } from '@/lib/email/resend'

// ------------------------------------------------------------
// Five tools the AI agent can call. Every executor is HARD-SCOPED to the
// trusted (accountId, contactId, conversationId) the webhook resolved
// before the agent ever ran — never to anything the model outputs. Tools
// whose target is inherently "the current customer" take NO
// customer-identifying parameter in their schema at all, so there is no
// argument for a manipulated model to even try to override. Every DB
// query still additionally filters by account_id — same defense-in-depth
// as the contact-ownership check in automations/engine.ts
// (runAutomationsForTrigger) and the scoped lookups in meta-send.ts.
//
// An executor never throws for an expected business condition (contact
// not found, lead creation not configured, etc.) — it returns a result
// object the model can react to and relay to the customer. Only a genuine
// infrastructure failure (DB unreachable) throws, and the agent loop
// (agent.ts) catches that to end the turn gracefully.
// ------------------------------------------------------------

export interface ToolContext {
  accountId: string
  contactId: string
  conversationId: string
  config: AiAgentConfig
}

export type ToolResult = Record<string, unknown>

interface ToolDefinition {
  schema: ToolSchema
  execute: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>
}

async function getCustomerDetails(ctx: ToolContext): Promise<ToolResult> {
  const { data, error } = await supabaseAdmin()
    .from('contacts')
    .select('name, phone, email, company')
    .eq('id', ctx.contactId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (error) throw new Error(`get_customer_details failed: ${error.message}`)
  if (!data) return { found: false }
  return { found: true, ...data }
}

const UPDATE_CUSTOMER_ALLOWED_FIELDS = ['name', 'email', 'company'] as const

async function updateCustomer(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const update: Record<string, string> = {}
  for (const field of UPDATE_CUSTOMER_ALLOWED_FIELDS) {
    const value = args[field]
    if (typeof value === 'string' && value.trim()) {
      update[field] = value.trim()
    }
  }
  if (Object.keys(update).length === 0) {
    return { updated: false, reason: 'no valid fields supplied' }
  }
  update.updated_at = new Date().toISOString()

  const { error } = await supabaseAdmin()
    .from('contacts')
    .update(update)
    .eq('id', ctx.contactId)
    .eq('account_id', ctx.accountId)
  if (error) throw new Error(`update_customer failed: ${error.message}`)
  return { updated: true, fields: Object.keys(update).filter((k) => k !== 'updated_at') }
}

async function createLead(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const pipelineId = ctx.config.default_pipeline_id
  const stageId = ctx.config.default_stage_id
  if (!pipelineId || !stageId) {
    return {
      created: false,
      reason: 'lead creation is not configured for this business yet',
    }
  }
  const title = typeof args.title === 'string' ? args.title.trim() : ''
  if (!title) {
    return { created: false, reason: 'title is required' }
  }
  const value = typeof args.value === 'number' ? args.value : 0

  const db = supabaseAdmin()
  // Match the account's configured default currency, same rationale as
  // automations/engine.ts's create_deal step (issue #218) — falls back to
  // USD if the row is somehow missing the value.
  const { data: acct } = await db
    .from('accounts')
    .select('default_currency')
    .eq('id', ctx.accountId)
    .maybeSingle()

  const { error } = await db.from('deals').insert({
    account_id: ctx.accountId,
    pipeline_id: pipelineId,
    stage_id: stageId,
    contact_id: ctx.contactId,
    title,
    value,
    currency: (acct as { default_currency?: string } | null)?.default_currency ?? 'USD',
    status: 'open',
  })
  if (error) throw new Error(`create_lead failed: ${error.message}`)
  return { created: true, title, value }
}

async function assignToHuman(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const reason = typeof args.reason === 'string' ? args.reason.trim() : 'agent requested handoff'
  const { error } = await supabaseAdmin()
    .from('conversations')
    .update({
      status: 'pending',
      mode: 'human_active',
      updated_at: new Date().toISOString(),
    })
    .eq('id', ctx.conversationId)
    .eq('account_id', ctx.accountId)
  if (error) throw new Error(`assign_to_human failed: ${error.message}`)
  return { assigned: true, reason }
}

/**
 * No RAG/embeddings — a simple case-insensitive substring match over the
 * account's structured FAQs + services. Sufficient at the scale a single
 * business's configured knowledge realistically reaches; revisit only if
 * an account starts uploading a large document corpus.
 */
async function searchBusinessKnowledge(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
  if (!query) return { matches: [] }

  const faqMatches = (ctx.config.faqs ?? [])
    .filter(
      (f) =>
        f.question.toLowerCase().includes(query) || f.answer.toLowerCase().includes(query),
    )
    .map((f) => ({ type: 'faq', question: f.question, answer: f.answer }))

  const serviceMatches = (ctx.config.services ?? [])
    .filter(
      (s) =>
        s.name.toLowerCase().includes(query) ||
        (s.description ?? '').toLowerCase().includes(query),
    )
    .map((s) => ({ type: 'service', name: s.name, price: s.price, description: s.description }))

  const matches = [...faqMatches, ...serviceMatches]
  return matches.length > 0 ? { matches } : { matches: [], note: 'no matching info found' }
}

async function sendEmailTool(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const subject = typeof args.subject === 'string' ? args.subject.trim() : ''
  const body = typeof args.body === 'string' ? args.body.trim() : ''
  if (!subject || !body) {
    return { sent: false, reason: 'subject and body are required' }
  }

  const { data: contact, error } = await supabaseAdmin()
    .from('contacts')
    .select('email')
    .eq('id', ctx.contactId)
    .eq('account_id', ctx.accountId)
    .maybeSingle()
  if (error) throw new Error(`send_email failed: ${error.message}`)
  if (!contact?.email) {
    return { sent: false, reason: "the customer doesn't have an email on file" }
  }

  try {
    await sendEmail({ to: contact.email, subject, text: body })
  } catch (err) {
    if (err instanceof EmailNotConfiguredError) {
      return { sent: false, reason: 'email is not set up for this business yet' }
    }
    throw err
  }
  return { sent: true }
}

// ------------------------------------------------------------
// Booking tools (Phase 3). Slot math lives in ./booking/availability.ts
// (pure, unit-tested independently) — these executors just load/save
// the `appointments` rows and call into that math. All three mutating
// tools (create/reschedule/cancel) re-derive business-hours + conflict
// validity server-side rather than trusting the model already checked —
// the model calling check_availability first is a prompt convention
// (see prompt.ts), not something enforced here, so every guard has to
// hold even if the model skips straight to create_booking.
//
// reschedule_booking/cancel_booking take an `appointment_id` the model
// supplies — the one deliberate exception to "no tool schema takes a
// customer-identifying parameter" (see the module docstring above). A
// contact can have more than one booking, so the model needs to name
// which one; hard scoping still holds because every lookup additionally
// filters by the trusted contact_id + account_id, so a wrong or
// cross-tenant id simply matches no row rather than someone else's
// booking.
// ------------------------------------------------------------

/** Active staff for the account, or [] if the account doesn't use staff
 *  at all — callers branch on that to preserve the pre-staff single
 *  shared-calendar behavior. */
async function loadActiveStaff(
  accountId: string,
): Promise<{ id: string; name: string; working_hours: { day: number; open: string; close: string }[] }[]> {
  const { data, error } = await supabaseAdmin()
    .from('staff_members')
    .select('id, name, working_hours')
    .eq('account_id', accountId)
    .eq('active', true)
  if (error) throw new Error(`staff lookup failed: ${error.message}`)
  return (data ?? []) as {
    id: string
    name: string
    working_hours: { day: number; open: string; close: string }[]
  }[]
}

/** A staff member with no working_hours of their own inherits the
 *  account's business hours — see 031_ai_staff_booking.sql. */
function effectiveStaffWindows(
  staff: { working_hours: { day: number; open: string; close: string }[] },
  accountWindows: { day: number; open: string; close: string }[],
) {
  return staff.working_hours.length > 0 ? staff.working_hours : accountWindows
}

async function checkAvailability(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const dateStr = typeof args.date === 'string' ? args.date.trim() : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return { slots: [], reason: 'date must be in YYYY-MM-DD format' }
  }
  const accountWindows = ctx.config.business_hours?.windows ?? []
  const timezone = ctx.config.business_hours?.timezone || 'UTC'

  const serviceArg = typeof args.service === 'string' ? args.service.trim() : ''
  const durationMinutes = resolveDurationMinutes(
    serviceArg,
    ctx.config.services ?? [],
    ctx.config.default_appointment_duration_minutes ?? 30,
  )

  let dayStartUtc: Date
  try {
    const { year, month, day } = parseDateStr(dateStr)
    dayStartUtc = zonedTimeToUtc(year, month, day, 0, 0, timezone)
  } catch {
    return { slots: [], reason: 'date must be a real calendar date' }
  }
  // A generous +/- buffer around the target civil day rather than a
  // tight midnight-to-midnight bound — sidesteps DST-transition edge
  // cases in the query itself; computeAvailableSlots' own overlap check
  // does the precise filtering against whatever this returns.
  const rangeStart = new Date(dayStartUtc.getTime() - 24 * 3_600_000).toISOString()
  const rangeEnd = new Date(dayStartUtc.getTime() + 48 * 3_600_000).toISOString()

  const activeStaff = await loadActiveStaff(ctx.accountId)
  const staffArg = typeof args.staff === 'string' ? args.staff.trim() : ''

  // No staff configured on this account at all — original single
  // shared-calendar behavior, unchanged from pre-staff Phase 3.
  if (activeStaff.length === 0) {
    if (accountWindows.length === 0) {
      return { slots: [], reason: 'business hours are not configured for this business yet' }
    }
    const { data, error } = await supabaseAdmin()
      .from('appointments')
      .select('starts_at, ends_at')
      .eq('account_id', ctx.accountId)
      .eq('status', 'booked')
      .gte('starts_at', rangeStart)
      .lt('starts_at', rangeEnd)
    if (error) throw new Error(`check_availability failed: ${error.message}`)
    const slots = computeAvailableSlots({
      dateStr,
      timezone,
      windows: accountWindows,
      durationMinutes,
      existing: (data ?? []) as { starts_at: string; ends_at: string }[],
    })
    return slots.length > 0
      ? { slots: slots.map((s) => s.start) }
      : { slots: [], note: 'no available slots that day' }
  }

  // Staff configured — resolve to a specific one if the customer asked
  // for a specific person, otherwise check everyone active.
  let targetStaff = activeStaff
  if (staffArg) {
    const match = activeStaff.find((s) => s.name.toLowerCase() === staffArg.toLowerCase())
    if (!match) {
      return {
        slots: [],
        reason: `unknown staff member — available: ${activeStaff.map((s) => s.name).join(', ')}`,
      }
    }
    targetStaff = [match]
  }

  const staffIds = targetStaff.map((s) => s.id)
  const { data, error } = await supabaseAdmin()
    .from('appointments')
    .select('staff_id, starts_at, ends_at')
    .eq('account_id', ctx.accountId)
    .eq('status', 'booked')
    .in('staff_id', staffIds)
    .gte('starts_at', rangeStart)
    .lt('starts_at', rangeEnd)
  if (error) throw new Error(`check_availability failed: ${error.message}`)

  const byStaff = new Map<string, { starts_at: string; ends_at: string }[]>()
  for (const row of (data ?? []) as { staff_id: string; starts_at: string; ends_at: string }[]) {
    const list = byStaff.get(row.staff_id) ?? []
    list.push(row)
    byStaff.set(row.staff_id, list)
  }

  // Union of every checked staff member's free times — the customer
  // cares that *a* slot exists, not who holds it; create_booking
  // re-resolves an actual staff assignment when the booking happens.
  const allStarts = new Set<string>()
  for (const staff of targetStaff) {
    const windows = effectiveStaffWindows(staff, accountWindows)
    if (windows.length === 0) continue
    const slots = computeAvailableSlots({
      dateStr,
      timezone,
      windows,
      durationMinutes,
      existing: byStaff.get(staff.id) ?? [],
    })
    for (const s of slots) allStarts.add(s.start)
  }
  const sorted = [...allStarts].sort().slice(0, 12)
  return sorted.length > 0 ? { slots: sorted } : { slots: [], note: 'no available slots that day' }
}

async function listUpcomingBookings(ctx: ToolContext): Promise<ToolResult> {
  const { data, error } = await supabaseAdmin()
    .from('appointments')
    .select('id, service, starts_at, ends_at, staff_id')
    .eq('account_id', ctx.accountId)
    .eq('contact_id', ctx.contactId)
    .eq('status', 'booked')
    .gte('starts_at', new Date().toISOString())
    .order('starts_at', { ascending: true })
    .limit(10)
  if (error) throw new Error(`list_upcoming_bookings failed: ${error.message}`)

  const rows = (data ?? []) as {
    id: string
    service: string
    starts_at: string
    ends_at: string
    staff_id: string | null
  }[]
  const staffIds = [...new Set(rows.map((r) => r.staff_id).filter((id): id is string => Boolean(id)))]
  const staffNames = new Map<string, string>()
  if (staffIds.length > 0) {
    const { data: staffRows } = await supabaseAdmin()
      .from('staff_members')
      .select('id, name')
      .in('id', staffIds)
    for (const s of (staffRows ?? []) as { id: string; name: string }[]) staffNames.set(s.id, s.name)
  }

  return {
    bookings: rows.map((r) => ({
      id: r.id,
      service: r.service,
      starts_at: r.starts_at,
      ends_at: r.ends_at,
      staff: r.staff_id ? (staffNames.get(r.staff_id) ?? null) : null,
    })),
  }
}

async function createBooking(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const startTimeStr = typeof args.start_time === 'string' ? args.start_time.trim() : ''
  return createAppointment(supabaseAdmin(), {
    accountId: ctx.accountId,
    contactId: ctx.contactId,
    conversationId: ctx.conversationId,
    config: ctx.config,
    service: typeof args.service === 'string' ? args.service.trim() : '',
    start: startTimeStr ? new Date(startTimeStr) : new Date(NaN),
    notes: typeof args.notes === 'string' ? args.notes : null,
    staffName: typeof args.staff === 'string' ? args.staff.trim() : undefined,
    createdBy: 'ai',
  })
}

async function rescheduleBooking(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const newStartStr = typeof args.new_start_time === 'string' ? args.new_start_time.trim() : ''
  return rescheduleAppointment(supabaseAdmin(), {
    accountId: ctx.accountId,
    contactId: ctx.contactId,
    config: ctx.config,
    appointmentId: typeof args.appointment_id === 'string' ? args.appointment_id.trim() : '',
    newStart: newStartStr ? new Date(newStartStr) : new Date(NaN),
  })
}

async function cancelBooking(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return cancelAppointment(supabaseAdmin(), {
    accountId: ctx.accountId,
    contactId: ctx.contactId,
    appointmentId: typeof args.appointment_id === 'string' ? args.appointment_id.trim() : '',
  })
}

export const TOOL_DEFINITIONS: Record<string, ToolDefinition> = {
  get_customer_details: {
    schema: {
      name: 'get_customer_details',
      description:
        "Look up the current customer's stored details (name, phone, email, company). Always refers to the customer in this conversation — never takes an id.",
      input_schema: { type: 'object', properties: {} },
    },
    execute: (ctx) => getCustomerDetails(ctx),
  },
  update_customer: {
    schema: {
      name: 'update_customer',
      description:
        "Update the current customer's name, email, or company. Only include fields the customer actually gave you.",
      input_schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          email: { type: 'string' },
          company: { type: 'string' },
        },
      },
    },
    execute: (ctx, args) => updateCustomer(ctx, args),
  },
  create_lead: {
    schema: {
      name: 'create_lead',
      description:
        'Create a sales lead for the current customer once they show real interest in a service.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short description of the lead.' },
          value: { type: 'number', description: 'Estimated deal value, if known.' },
        },
        required: ['title'],
      },
    },
    execute: (ctx, args) => createLead(ctx, args),
  },
  assign_to_human: {
    schema: {
      name: 'assign_to_human',
      description:
        'Hand this conversation off to a human team member. Use when the customer asks for a person, reports a complaint, or when you are not confident you can help correctly.',
      input_schema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Brief reason for the handoff.' },
        },
        required: ['reason'],
      },
    },
    execute: (ctx, args) => assignToHuman(ctx, args),
  },
  search_business_knowledge: {
    schema: {
      name: 'search_business_knowledge',
      description:
        "Search this business's configured FAQs and services for an answer. Use before answering any factual question about the business — never guess.",
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
    },
    execute: (ctx, args) => searchBusinessKnowledge(ctx, args),
  },
  send_email: {
    schema: {
      name: 'send_email',
      description:
        "Send an email to the current customer's email on file — for things better suited to email than WhatsApp (a detailed confirmation, an invoice, a document). Never use it as a substitute for the WhatsApp reply itself; always still reply on WhatsApp too.",
      input_schema: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['subject', 'body'],
      },
    },
    execute: (ctx, args) => sendEmailTool(ctx, args),
  },
  check_availability: {
    schema: {
      name: 'check_availability',
      description:
        'Check what appointment slots are open on a given date. Always call this before create_booking or reschedule_booking — never guess or invent a time.',
      input_schema: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Date to check, in YYYY-MM-DD format.' },
          service: {
            type: 'string',
            description: 'Service name, if known — affects how long each slot needs to be.',
          },
          staff: {
            type: 'string',
            description:
              'A specific staff member the customer asked for, by name. Omit to check availability across everyone.',
          },
        },
        required: ['date'],
      },
    },
    execute: (ctx, args) => checkAvailability(ctx, args),
  },
  list_upcoming_bookings: {
    schema: {
      name: 'list_upcoming_bookings',
      description:
        "List the current customer's upcoming booked appointments. Always call this before reschedule_booking or cancel_booking to find the correct appointment_id — never guess one. Always refers to the customer in this conversation — never takes an id.",
      input_schema: { type: 'object', properties: {} },
    },
    execute: (ctx) => listUpcomingBookings(ctx),
  },
  create_booking: {
    schema: {
      name: 'create_booking',
      description:
        'Book an appointment for the current customer at a specific time you already confirmed is available via check_availability.',
      input_schema: {
        type: 'object',
        properties: {
          service: { type: 'string', description: 'Which service to book.' },
          start_time: {
            type: 'string',
            description: 'Exact start time as an ISO 8601 date-time, e.g. 2026-08-20T09:00:00+05:30.',
          },
          staff: {
            type: 'string',
            description:
              'A specific staff member the customer asked for, by name. Omit to auto-assign whoever is available.',
          },
          notes: { type: 'string', description: 'Any extra detail the customer gave, optional.' },
        },
        required: ['service', 'start_time'],
      },
    },
    execute: (ctx, args) => createBooking(ctx, args),
  },
  reschedule_booking: {
    schema: {
      name: 'reschedule_booking',
      description:
        'Move an existing booking to a new time. Get the appointment_id from list_upcoming_bookings first, and confirm the new time is open via check_availability.',
      input_schema: {
        type: 'object',
        properties: {
          appointment_id: { type: 'string' },
          new_start_time: { type: 'string', description: 'New start time as an ISO 8601 date-time.' },
        },
        required: ['appointment_id', 'new_start_time'],
      },
    },
    execute: (ctx, args) => rescheduleBooking(ctx, args),
  },
  cancel_booking: {
    schema: {
      name: 'cancel_booking',
      description:
        'Cancel an existing booking. Get the appointment_id from list_upcoming_bookings first.',
      input_schema: {
        type: 'object',
        properties: {
          appointment_id: { type: 'string' },
          reason: { type: 'string', description: "Why the customer is cancelling, optional." },
        },
        required: ['appointment_id'],
      },
    },
    execute: (ctx, args) => cancelBooking(ctx, args),
  },
}

export function listToolSchemas(): ToolSchema[] {
  return Object.values(TOOL_DEFINITIONS).map((t) => t.schema)
}

/**
 * Executes one tool call by name against the hard-bound context. Unknown
 * tool names (a model hallucinating a tool that doesn't exist) return an
 * error result rather than throwing — keeps the turn alive so the agent
 * can tell the customer something went wrong instead of dropping the
 * message entirely.
 */
export async function executeTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = TOOL_DEFINITIONS[name]
  if (!tool) {
    return { error: `unknown tool: ${name}` }
  }
  try {
    return await tool.execute(ctx, args)
  } catch (err) {
    console.error(`[ai] tool ${name} failed:`, err)
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
