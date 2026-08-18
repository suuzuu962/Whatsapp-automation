import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { buildSystemPrompt } from '@/lib/ai/prompt'
import type { AiAgentConfig } from '@/types'

/**
 * GET /api/ai/agent-config
 *
 * Returns the caller's account's AI agent config, or null if it hasn't
 * been set up yet. Any account member can read (RLS: ai_agent_config_select).
 */
export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const { data, error } = await ctx.supabase
      .from('ai_agent_config')
      .select('*')
      .eq('account_id', ctx.accountId)
      .maybeSingle()
    if (error) {
      console.error('[ai/agent-config GET] fetch failed:', error.message)
      return NextResponse.json({ error: 'Failed to load configuration' }, { status: 500 })
    }
    return NextResponse.json({ config: data ?? null })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/agent-config
 *
 * Saves the structured wizard fields and regenerates
 * `generated_system_prompt` server-side from them — the business owner
 * never edits the prompt text directly (see src/lib/ai/prompt.ts).
 * Admin-only (matches whatsapp_config's admin-gated write policy).
 */
export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = await request.json().catch(() => null)
    if (!body) {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const {
      enabled,
      business_profile,
      agent_persona,
      services,
      business_hours,
      faqs,
      escalation_rules,
      restricted_topics,
      default_pipeline_id,
      default_stage_id,
      provider_priority,
      consequential_action_mode,
      default_appointment_duration_minutes,
      appointment_reminder_offsets_minutes,
      reminder_template_name,
      reminder_template_language,
    } = body as Partial<AiAgentConfig>

    // Build the row we'll persist first so buildSystemPrompt sees the
    // same values that get saved, not a stale previously-loaded row.
    const draftConfig: AiAgentConfig = {
      id: '',
      account_id: ctx.accountId,
      enabled: Boolean(enabled),
      business_profile: business_profile ?? {},
      agent_persona: agent_persona ?? {},
      services: services ?? [],
      business_hours: business_hours ?? {},
      faqs: faqs ?? [],
      escalation_rules: escalation_rules ?? [],
      restricted_topics: restricted_topics ?? [],
      default_pipeline_id: default_pipeline_id ?? null,
      default_stage_id: default_stage_id ?? null,
      provider_priority: provider_priority ?? [],
      consequential_action_mode:
        consequential_action_mode === 'require_approval' ? 'require_approval' : 'auto',
      default_appointment_duration_minutes:
        typeof default_appointment_duration_minutes === 'number' &&
        default_appointment_duration_minutes > 0
          ? default_appointment_duration_minutes
          : 30,
      appointment_reminder_offsets_minutes: Array.isArray(appointment_reminder_offsets_minutes)
        ? appointment_reminder_offsets_minutes.filter((n) => typeof n === 'number' && n > 0)
        : [1440, 120],
      reminder_template_name:
        typeof reminder_template_name === 'string' && reminder_template_name.trim()
          ? reminder_template_name.trim()
          : null,
      reminder_template_language:
        typeof reminder_template_language === 'string' && reminder_template_language.trim()
          ? reminder_template_language.trim()
          : 'en_US',
      created_at: '',
      updated_at: '',
    }

    const row = {
      account_id: ctx.accountId,
      enabled: draftConfig.enabled,
      business_profile: draftConfig.business_profile,
      agent_persona: draftConfig.agent_persona,
      services: draftConfig.services,
      business_hours: draftConfig.business_hours,
      faqs: draftConfig.faqs,
      escalation_rules: draftConfig.escalation_rules,
      restricted_topics: draftConfig.restricted_topics,
      default_pipeline_id: draftConfig.default_pipeline_id,
      default_stage_id: draftConfig.default_stage_id,
      provider_priority: draftConfig.provider_priority,
      consequential_action_mode: draftConfig.consequential_action_mode,
      default_appointment_duration_minutes: draftConfig.default_appointment_duration_minutes,
      appointment_reminder_offsets_minutes: draftConfig.appointment_reminder_offsets_minutes,
      reminder_template_name: draftConfig.reminder_template_name,
      reminder_template_language: draftConfig.reminder_template_language,
      generated_system_prompt: buildSystemPrompt(draftConfig),
      updated_at: new Date().toISOString(),
    }

    const { data: existing } = await ctx.supabase
      .from('ai_agent_config')
      .select('id')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (existing) {
      const { error } = await ctx.supabase
        .from('ai_agent_config')
        .update(row)
        .eq('account_id', ctx.accountId)
      if (error) {
        console.error('[ai/agent-config POST] update failed:', error.message)
        return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
      }
    } else {
      const { error } = await ctx.supabase.from('ai_agent_config').insert(row)
      if (error) {
        console.error('[ai/agent-config POST] insert failed:', error.message)
        return NextResponse.json({ error: 'Failed to save configuration' }, { status: 500 })
      }
    }

    return NextResponse.json({ success: true, generated_system_prompt: row.generated_system_prompt })
  } catch (err) {
    return toErrorResponse(err)
  }
}
