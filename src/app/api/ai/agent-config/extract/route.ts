import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  buildAvailableProviders,
  generateWithFallback,
} from '@/lib/ai/providers/router'

/**
 * POST /api/ai/agent-config/extract
 *
 * Wizard step 2: turns the business owner's freeform description into a
 * draft of the structured config fields, for them to review/edit in
 * step 3 — never saved directly. This is the ONLY place in the AI
 * feature that lets a raw prompt drive anything, and even then only as
 * a one-time drafting aid whose output is a fully editable form, not a
 * runtime instruction.
 */
export async function POST(request: Request) {
  try {
    // Admin-only, same permission as saving the config — but this route
    // doesn't need the account context itself, just the auth/role check.
    await requireRole('admin')
    const body = await request.json().catch(() => null)
    const description = typeof body?.description === 'string' ? body.description.trim() : ''
    if (!description) {
      return NextResponse.json({ error: 'description is required' }, { status: 400 })
    }

    const providers = buildAvailableProviders()
    if (providers.length === 0) {
      return NextResponse.json(
        { error: 'No AI provider configured on this deployment (set ANTHROPIC_API_KEY or OPENAI_API_KEY).' },
        { status: 503 },
      )
    }

    let output
    try {
      output = await generateWithFallback(providers, (provider) =>
        provider.generateReply({
          systemPrompt: EXTRACTION_SYSTEM_PROMPT,
          history: [{ role: 'user', content: description }],
          tools: [],
        }),
      )
    } catch (err) {
      console.error('[ai/agent-config/extract] provider call failed:', err)
      return NextResponse.json({ error: 'AI extraction failed — try again.' }, { status: 502 })
    }

    const raw = (output.text ?? '').trim()
    const jsonText = stripCodeFence(raw)
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonText)
    } catch {
      console.error('[ai/agent-config/extract] model returned non-JSON:', raw)
      return NextResponse.json(
        { error: 'Could not parse the extracted configuration — try rephrasing your description.' },
        { status: 502 },
      )
    }

    return NextResponse.json({ extracted: normalizeExtracted(parsed) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

const EXTRACTION_SYSTEM_PROMPT = `You turn a business owner's freeform description of their business into a structured JSON draft. Output ONLY a single JSON object — no prose, no markdown code fences, no explanation.

Shape (omit a field if the description doesn't mention it — do not invent values):
{
  "business_profile": { "name": string, "type": string, "description": string },
  "agent_persona": { "name": string, "tone": string, "languages": string[] },
  "services": [{ "name": string, "price": string, "description": string, "duration_minutes": number }],
  "faqs": [{ "question": string, "answer": string }],
  "restricted_topics": string[],
  "business_hours": { "timezone": string, "windows": [{ "day": number, "open": string, "close": string }] }
}

business_hours.windows.day is 0=Sunday..6=Saturday. open/close are 24-hour "HH:MM" strings. If the description gives a day range like "Monday to Saturday, 9 AM to 7 PM", expand it into one window object per day in that range — do not collapse it into a single entry. Only set timezone if the description names a city/country/timezone you can confidently map to an IANA zone (e.g. "Bangalore" -> "Asia/Kolkata"); omit it otherwise rather than guessing.

Only include information the owner actually stated. Never fabricate prices, hours, durations, or services that weren't mentioned.`

function stripCodeFence(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return fenceMatch ? fenceMatch[1].trim() : text
}

interface ExtractedConfig {
  business_profile?: { name?: string; type?: string; description?: string }
  agent_persona?: { name?: string; tone?: string; languages?: string[] }
  services?: { name: string; price?: string; description?: string; duration_minutes?: number }[]
  faqs?: { question: string; answer: string }[]
  restricted_topics?: string[]
  business_hours?: { timezone?: string; windows?: { day: number; open: string; close: string }[] }
}

/** Defensive normalization — a model can omit fields or get a type
 *  slightly wrong; never let a malformed field crash the review step. */
function normalizeExtracted(parsed: unknown): ExtractedConfig {
  const p = (parsed ?? {}) as Record<string, unknown>
  return {
    business_profile: isRecord(p.business_profile) ? p.business_profile as ExtractedConfig['business_profile'] : undefined,
    agent_persona: isRecord(p.agent_persona) ? p.agent_persona as ExtractedConfig['agent_persona'] : undefined,
    services: Array.isArray(p.services) ? p.services.filter(isRecord) as ExtractedConfig['services'] : undefined,
    faqs: Array.isArray(p.faqs) ? p.faqs.filter(isRecord) as ExtractedConfig['faqs'] : undefined,
    restricted_topics: Array.isArray(p.restricted_topics)
      ? p.restricted_topics.filter((t): t is string => typeof t === 'string')
      : undefined,
    business_hours: isRecord(p.business_hours) ? normalizeBusinessHours(p.business_hours) : undefined,
  }
}

function normalizeBusinessHours(raw: Record<string, unknown>): ExtractedConfig['business_hours'] {
  const windows = Array.isArray(raw.windows)
    ? raw.windows
        .filter(isRecord)
        .filter(
          (w): w is { day: number; open: string; close: string } =>
            typeof w.day === 'number' &&
            w.day >= 0 &&
            w.day <= 6 &&
            typeof w.open === 'string' &&
            typeof w.close === 'string',
        )
    : undefined
  return {
    timezone: typeof raw.timezone === 'string' ? raw.timezone : undefined,
    windows,
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}
