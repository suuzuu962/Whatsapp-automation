'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Sparkles, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SettingsPanelHead } from './settings-panel-head';
import { RequireRole } from '@/components/auth/require-role';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import type { AiAgentConfig, AiFaq, AiService, MessageTemplate } from '@/types';
import { DAY_LABELS, type DayRow, emptyDayRows, windowsToDayRows, dayRowsToWindows } from './day-rows';
import { StaffManagementCard } from './staff-management';

// ------------------------------------------------------------
// Setup wizard: describe → AI extracts a structured draft → the owner
// reviews/edits the structured fields → save. The freeform description
// is a one-time drafting aid (step 1) — what actually gets saved and
// what the runtime prompt is generated from is always the structured
// fields the owner reviewed, never the raw text itself. See
// src/lib/ai/prompt.ts for how these compile into the runtime prompt.
// ------------------------------------------------------------

type FormState = {
  enabled: boolean;
  business_name: string;
  business_type: string;
  business_description: string;
  agent_name: string;
  agent_tone: string;
  agent_languages: string;
  services: AiService[];
  faqs: AiFaq[];
  restricted_topics: string;
  escalation_rules: string;
  default_pipeline_id: string;
  default_stage_id: string;
  provider_priority: string[];
  consequential_action_mode: 'auto' | 'require_approval';
  business_hours_timezone: string;
  business_hours_days: DayRow[];
  default_appointment_duration_minutes: string;
  reminder_offsets_minutes: number[];
  reminder_template_name: string;
};

const EMPTY_FORM: FormState = {
  enabled: false,
  business_name: '',
  business_type: '',
  business_description: '',
  agent_name: '',
  agent_tone: '',
  agent_languages: '',
  services: [],
  faqs: [],
  restricted_topics: '',
  escalation_rules: '',
  default_pipeline_id: '',
  default_stage_id: '',
  provider_priority: [],
  consequential_action_mode: 'auto',
  business_hours_timezone: '',
  business_hours_days: emptyDayRows(),
  default_appointment_duration_minutes: '30',
  reminder_offsets_minutes: [1440, 120],
  reminder_template_name: '',
};

function configToForm(config: AiAgentConfig): FormState {
  return {
    enabled: config.enabled,
    business_name: config.business_profile?.name ?? '',
    business_type: config.business_profile?.type ?? '',
    business_description: config.business_profile?.description ?? '',
    agent_name: config.agent_persona?.name ?? '',
    agent_tone: config.agent_persona?.tone ?? '',
    agent_languages: (config.agent_persona?.languages ?? []).join(', '),
    services: config.services ?? [],
    faqs: config.faqs ?? [],
    restricted_topics: (config.restricted_topics ?? []).join(', '),
    escalation_rules: (config.escalation_rules ?? []).join('\n'),
    default_pipeline_id: config.default_pipeline_id ?? '',
    default_stage_id: config.default_stage_id ?? '',
    provider_priority: config.provider_priority ?? [],
    consequential_action_mode: config.consequential_action_mode ?? 'auto',
    business_hours_timezone: config.business_hours?.timezone ?? '',
    business_hours_days: windowsToDayRows(config.business_hours?.windows),
    default_appointment_duration_minutes: String(config.default_appointment_duration_minutes ?? 30),
    reminder_offsets_minutes: config.appointment_reminder_offsets_minutes ?? [1440, 120],
    reminder_template_name: config.reminder_template_name ?? '',
  };
}

function formToPayload(form: FormState) {
  return {
    enabled: form.enabled,
    business_profile: {
      name: form.business_name.trim(),
      type: form.business_type.trim(),
      description: form.business_description.trim(),
    },
    agent_persona: {
      name: form.agent_name.trim(),
      tone: form.agent_tone.trim(),
      languages: splitCommaList(form.agent_languages),
    },
    services: form.services.filter((s) => s.name.trim()),
    faqs: form.faqs.filter((f) => f.question.trim() && f.answer.trim()),
    restricted_topics: splitCommaList(form.restricted_topics),
    escalation_rules: form.escalation_rules
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean),
    default_pipeline_id: form.default_pipeline_id.trim() || null,
    default_stage_id: form.default_stage_id.trim() || null,
    provider_priority: form.provider_priority,
    consequential_action_mode: form.consequential_action_mode,
    business_hours: {
      timezone: form.business_hours_timezone.trim() || undefined,
      windows: dayRowsToWindows(form.business_hours_days),
    },
    default_appointment_duration_minutes: Math.max(1, Number(form.default_appointment_duration_minutes) || 30),
    appointment_reminder_offsets_minutes: form.reminder_offsets_minutes,
    reminder_template_name: form.reminder_template_name.trim() || null,
  };
}

function splitCommaList(s: string): string[] {
  return s
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

export function AiAgentConfigPanel() {
  const { accountId } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [hasExistingConfig, setHasExistingConfig] = useState(false);
  const [showWizardIntro, setShowWizardIntro] = useState(true);
  const [description, setDescription] = useState('');
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [approvedTemplates, setApprovedTemplates] = useState<MessageTemplate[]>([]);

  useEffect(() => {
    if (!accountId) return;
    (async () => {
      const { data } = await createClient()
        .from('message_templates')
        .select('*')
        .eq('account_id', accountId)
        .eq('status', 'Approved')
        .order('name', { ascending: true });
      if (data) setApprovedTemplates(data as MessageTemplate[]);
    })();
  }, [accountId]);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/agent-config');
      const data = await res.json();
      if (data.config) {
        setForm(configToForm(data.config as AiAgentConfig));
        setHasExistingConfig(true);
        setShowWizardIntro(false);
      }
    } catch {
      toast.error('Failed to load AI agent configuration');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  async function handleExtract() {
    if (!description.trim()) {
      toast.error('Describe your business first');
      return;
    }
    setExtracting(true);
    try {
      const res = await fetch('/api/ai/agent-config/extract', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Extraction failed');
        return;
      }
      const ex = data.extracted ?? {};
      setForm((prev) => ({
        ...prev,
        business_name: ex.business_profile?.name ?? prev.business_name,
        business_type: ex.business_profile?.type ?? prev.business_type,
        business_description: ex.business_profile?.description ?? description,
        agent_name: ex.agent_persona?.name ?? prev.agent_name,
        agent_tone: ex.agent_persona?.tone ?? prev.agent_tone,
        agent_languages: ex.agent_persona?.languages?.join(', ') ?? prev.agent_languages,
        services: ex.services?.length ? ex.services : prev.services,
        faqs: ex.faqs?.length ? ex.faqs : prev.faqs,
        restricted_topics: ex.restricted_topics?.join(', ') ?? prev.restricted_topics,
        business_hours_timezone: ex.business_hours?.timezone ?? prev.business_hours_timezone,
        business_hours_days: ex.business_hours?.windows?.length
          ? windowsToDayRows(ex.business_hours.windows)
          : prev.business_hours_days,
      }));
      setShowWizardIntro(false);
      toast.success('Draft generated — review and edit before saving.');
    } catch {
      toast.error('Extraction failed');
    } finally {
      setExtracting(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch('/api/ai/agent-config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(formToPayload(form)),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to save');
        return;
      }
      setHasExistingConfig(true);
      toast.success('AI agent configuration saved');
    } catch {
      toast.error('Failed to save');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div>
      <SettingsPanelHead
        title="AI Agent"
        description="Configure an AI assistant that replies on WhatsApp when no automation or flow already handles the message. Describe your business once, review the structured draft, then edit anything before turning it on."
      />

      <RequireRole
        min="admin"
        fallback={
          <Alert>
            <AlertTitle>Admin access required</AlertTitle>
            <AlertDescription>
              Ask an account admin to configure the AI agent.
            </AlertDescription>
          </Alert>
        }
      >
        <div className="space-y-6">
          {!hasExistingConfig && showWizardIntro && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Sparkles className="h-4 w-4" /> Describe your business
                </CardTitle>
                <CardDescription>
                  Write a few sentences about your business and what the agent should help
                  with. This is only used to draft the fields below — you review and edit
                  everything before it goes live, and this text itself is never saved as-is.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="We are a dental clinic in Bangalore. We offer cleaning, consultation, and implants. We're open Monday to Saturday, 9 AM to 7 PM."
                  rows={4}
                />
                <div className="flex items-center gap-2">
                  <Button onClick={handleExtract} disabled={extracting}>
                    {extracting ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Generating draft…
                      </>
                    ) : (
                      'Generate draft configuration'
                    )}
                  </Button>
                  <Button variant="ghost" onClick={() => setShowWizardIntro(false)}>
                    Skip and fill in manually
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {(hasExistingConfig || !showWizardIntro) && (
            <>
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Status</CardTitle>
                </CardHeader>
                <CardContent className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {form.enabled ? 'AI agent is active' : 'AI agent is off'}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      When on, the agent replies to conversations Flows and Automations
                      didn&apos;t already handle.
                    </p>
                  </div>
                  <Switch
                    checked={form.enabled}
                    onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Business profile</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <Label>Business name</Label>
                      <Input
                        value={form.business_name}
                        onChange={(e) => setForm((f) => ({ ...f, business_name: e.target.value }))}
                      />
                    </div>
                    <div>
                      <Label>Business type</Label>
                      <Input
                        value={form.business_type}
                        onChange={(e) => setForm((f) => ({ ...f, business_type: e.target.value }))}
                        placeholder="e.g. dental clinic, hotel, spa"
                      />
                    </div>
                  </div>
                  <div>
                    <Label>Description</Label>
                    <Textarea
                      value={form.business_description}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, business_description: e.target.value }))
                      }
                      rows={2}
                    />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Agent persona</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <Label>Agent name</Label>
                    <Input
                      value={form.agent_name}
                      onChange={(e) => setForm((f) => ({ ...f, agent_name: e.target.value }))}
                      placeholder="e.g. Aria"
                    />
                  </div>
                  <div>
                    <Label>Tone</Label>
                    <Input
                      value={form.agent_tone}
                      onChange={(e) => setForm((f) => ({ ...f, agent_tone: e.target.value }))}
                      placeholder="warm, professional, concise"
                    />
                  </div>
                  <div>
                    <Label>Languages</Label>
                    <Input
                      value={form.agent_languages}
                      onChange={(e) => setForm((f) => ({ ...f, agent_languages: e.target.value }))}
                      placeholder="English, Hindi"
                    />
                  </div>
                </CardContent>
              </Card>

              <ListEditor
                title="Services"
                description="Shown to the agent so it never has to guess prices or offerings."
                items={form.services}
                onChange={(services) => setForm((f) => ({ ...f, services }))}
                empty={{ name: '', price: '', description: '' }}
                renderRow={(item, update) => (
                  <div className="grid flex-1 gap-2 sm:grid-cols-4">
                    <Input
                      value={item.name}
                      onChange={(e) => update({ ...item, name: e.target.value })}
                      placeholder="Service name"
                    />
                    <Input
                      value={item.price ?? ''}
                      onChange={(e) => update({ ...item, price: e.target.value })}
                      placeholder="Price (optional)"
                    />
                    <Input
                      value={item.description ?? ''}
                      onChange={(e) => update({ ...item, description: e.target.value })}
                      placeholder="Description (optional)"
                    />
                    <Input
                      type="number"
                      min={1}
                      value={item.duration_minutes ?? ''}
                      onChange={(e) =>
                        update({
                          ...item,
                          duration_minutes: e.target.value ? Number(e.target.value) : undefined,
                        })
                      }
                      placeholder="Minutes (optional)"
                    />
                  </div>
                )}
              />

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Business hours & booking</CardTitle>
                  <CardDescription>
                    Powers the AI&apos;s check_availability/create_booking/reschedule_booking/
                    cancel_booking tools. Leave every day off if this business doesn&apos;t take
                    bookings — the agent won&apos;t offer to book anything without at least one day
                    configured here.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <Label>Timezone (IANA, e.g. Asia/Kolkata)</Label>
                      <div className="flex gap-2">
                        <Input
                          value={form.business_hours_timezone}
                          onChange={(e) =>
                            setForm((f) => ({ ...f, business_hours_timezone: e.target.value }))
                          }
                          placeholder="Asia/Kolkata"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setForm((f) => ({
                              ...f,
                              business_hours_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                            }))
                          }
                        >
                          Use my timezone
                        </Button>
                      </div>
                    </div>
                    <div>
                      <Label>Default appointment length (minutes)</Label>
                      <Input
                        type="number"
                        min={1}
                        value={form.default_appointment_duration_minutes}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            default_appointment_duration_minutes: e.target.value,
                          }))
                        }
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    {form.business_hours_days.map((row, i) => (
                      <div key={row.day} className="flex items-center gap-3">
                        <label className="flex w-24 items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={row.enabled}
                            onChange={(e) =>
                              setForm((f) => {
                                const days = [...f.business_hours_days];
                                days[i] = { ...days[i], enabled: e.target.checked };
                                return { ...f, business_hours_days: days };
                              })
                            }
                          />
                          {DAY_LABELS[row.day]}
                        </label>
                        <Input
                          type="time"
                          className="w-32"
                          disabled={!row.enabled}
                          value={row.open}
                          onChange={(e) =>
                            setForm((f) => {
                              const days = [...f.business_hours_days];
                              days[i] = { ...days[i], open: e.target.value };
                              return { ...f, business_hours_days: days };
                            })
                          }
                        />
                        <span className="text-sm text-muted-foreground">to</span>
                        <Input
                          type="time"
                          className="w-32"
                          disabled={!row.enabled}
                          value={row.close}
                          onChange={(e) =>
                            setForm((f) => {
                              const days = [...f.business_hours_days];
                              days[i] = { ...days[i], close: e.target.value };
                              return { ...f, business_hours_days: days };
                            })
                          }
                        />
                      </div>
                    ))}
                  </div>

                  <div>
                    <Label>Appointment reminders</Label>
                    <div className="mt-1 flex gap-4">
                      {[
                        { minutes: 1440, label: '24 hours before' },
                        { minutes: 120, label: '2 hours before' },
                      ].map(({ minutes, label }) => (
                        <label key={minutes} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={form.reminder_offsets_minutes.includes(minutes)}
                            onChange={(e) =>
                              setForm((f) => ({
                                ...f,
                                reminder_offsets_minutes: e.target.checked
                                  ? [...f.reminder_offsets_minutes, minutes]
                                  : f.reminder_offsets_minutes.filter((m) => m !== minutes),
                              }))
                            }
                          />
                          {label}
                        </label>
                      ))}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Requires the reminder cron to be scheduled — see README for the same
                      AUTOMATION_CRON_SECRET-gated setup used by Automations/Flows.
                    </p>
                  </div>

                  {form.reminder_offsets_minutes.length > 0 && (
                    <div>
                      <Label>Reminder template</Label>
                      <select
                        value={form.reminder_template_name}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, reminder_template_name: e.target.value }))
                        }
                        className="mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
                      >
                        <option value="">None — send as plain text</option>
                        {approvedTemplates.map((t) => (
                          <option key={t.id} value={t.name}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {approvedTemplates.length === 0 ? (
                          <>
                            No Approved templates yet. Plain-text reminders only reach customers
                            inside WhatsApp&apos;s 24-hour reply window — outside it, Meta will
                            reject the send. Create and get a template approved under Templates,
                            then pick it here. Its body should take two variables in order:
                            service name, then appointment time (e.g. &quot;Reminder: your {'{{1}}'}{' '}
                            appointment is on {'{{2}}'}.&quot;).
                          </>
                        ) : (
                          <>
                            Sent with two variables in order: service name, then appointment
                            time. Without one selected, reminders only reach customers inside
                            WhatsApp&apos;s 24-hour reply window.
                          </>
                        )}
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>

              <StaffManagementCard />

              <ListEditor
                title="FAQs"
                description="The agent searches these before answering a factual question — it won't invent an answer that isn't here."
                items={form.faqs}
                onChange={(faqs) => setForm((f) => ({ ...f, faqs }))}
                empty={{ question: '', answer: '' }}
                renderRow={(item, update) => (
                  <div className="grid flex-1 gap-2 sm:grid-cols-2">
                    <Input
                      value={item.question}
                      onChange={(e) => update({ ...item, question: e.target.value })}
                      placeholder="Question"
                    />
                    <Input
                      value={item.answer}
                      onChange={(e) => update({ ...item, answer: e.target.value })}
                      placeholder="Answer"
                    />
                  </div>
                )}
              />

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Boundaries & escalation</CardTitle>
                  <CardDescription>
                    The agent hands off to a human whenever one of these rules matches, or
                    when it isn&apos;t confident it can help correctly.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <Label>Restricted topics (comma-separated)</Label>
                    <Input
                      value={form.restricted_topics}
                      onChange={(e) => setForm((f) => ({ ...f, restricted_topics: e.target.value }))}
                      placeholder="medical diagnoses, legal advice, refund amounts"
                    />
                  </div>
                  <div>
                    <Label>Escalation rules (one per line)</Label>
                    <Textarea
                      value={form.escalation_rules}
                      onChange={(e) => setForm((f) => ({ ...f, escalation_rules: e.target.value }))}
                      rows={3}
                      placeholder={'Customer asks for a manager\nComplaint or negative experience\nMedical emergency mentioned'}
                    />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Consequential actions</CardTitle>
                  <CardDescription>
                    Updating a customer&apos;s details or creating a lead changes a real CRM
                    record. Require a team member to approve those two actions before they take
                    effect, instead of letting the agent apply them immediately.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {form.consequential_action_mode === 'require_approval'
                        ? 'Approval required'
                        : 'Applied automatically'}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Read-only lookups and handing off to a human are never gated either way.
                    </p>
                  </div>
                  <Switch
                    checked={form.consequential_action_mode === 'require_approval'}
                    onCheckedChange={(v) =>
                      setForm((f) => ({
                        ...f,
                        consequential_action_mode: v ? 'require_approval' : 'auto',
                      }))
                    }
                  />
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Leads</CardTitle>
                  <CardDescription>
                    Where AI-created leads land. Leave blank to disable lead creation.
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label>Default pipeline ID</Label>
                    <Input
                      value={form.default_pipeline_id}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, default_pipeline_id: e.target.value }))
                      }
                    />
                  </div>
                  <div>
                    <Label>Default stage ID</Label>
                    <Input
                      value={form.default_stage_id}
                      onChange={(e) => setForm((f) => ({ ...f, default_stage_id: e.target.value }))}
                    />
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">AI provider</CardTitle>
                  <CardDescription>
                    Order of preference. If the first fails (rate limit, outage), the engine
                    automatically retries the next. Requires the matching API key to be set
                    in this deployment&apos;s environment variables.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex gap-4">
                  {(['anthropic', 'openai'] as const).map((p) => (
                    <label key={p} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={form.provider_priority.includes(p)}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            provider_priority: e.target.checked
                              ? [...f.provider_priority, p]
                              : f.provider_priority.filter((x) => x !== p),
                          }))
                        }
                      />
                      {p === 'anthropic' ? 'Anthropic (Claude)' : 'OpenAI (GPT)'}
                    </label>
                  ))}
                </CardContent>
              </Card>

              <div className="flex justify-end">
                <Button onClick={handleSave} disabled={saving}>
                  {saving ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving…
                    </>
                  ) : (
                    'Save configuration'
                  )}
                </Button>
              </div>

              <AiAuditLogPanel />
            </>
          )}
        </div>
      </RequireRole>
    </div>
  );
}

const AUDIT_EVENT_LABELS: Record<string, string> = {
  input_flagged: 'Suspicious input flagged',
  input_blocked: 'Suspicious input blocked',
  input_abuse_detected: 'Abusive/crisis input detected',
  output_blocked: 'Reply blocked (possible leak)',
  tool_executed: 'Tool executed',
  tool_gated: 'Action queued for approval',
  tool_loop_exceeded: 'Tool-call loop exceeded',
  provider_failed: 'AI provider failed',
  action_approved: 'Pending action approved',
  action_rejected: 'Pending action rejected',
};

const SEVERITY_STYLES: Record<string, string> = {
  info: 'bg-muted text-muted-foreground',
  warning: 'bg-amber-500/15 text-amber-700 dark:text-amber-500',
  critical: 'bg-destructive/15 text-destructive',
};

interface AuditLogEvent {
  id: string;
  event_type: string;
  severity: string;
  detail: Record<string, unknown>;
  created_at: string;
}

/**
 * Read-only view over `ai_audit_log` — the append-only trail every
 * guardrail in src/lib/ai/guardrails/ writes to (see
 * supabase/migrations/028_ai_guardrails.sql). Admin-only, matching the
 * table's RLS select policy. Not a live stream — a manual refresh is
 * enough for a review/debugging tool like this.
 */
function AiAuditLogPanel() {
  const [events, setEvents] = useState<AuditLogEvent[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/audit-log?limit=50');
      const data = await res.json();
      if (res.ok) setEvents(data.events ?? []);
    } catch {
      // Non-critical panel — fail silently, leave the last-loaded list.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEvents();
  }, [fetchEvents]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">Recent guardrail activity</CardTitle>
          <CardDescription>
            What the agent&apos;s guardrails have flagged, blocked, or gated recently.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={fetchEvents} disabled={loading}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Refresh'}
        </Button>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No guardrail events yet.</p>
        ) : (
          <div className="space-y-2">
            {events.map((e) => (
              <div key={e.id} className="flex items-start justify-between gap-3 border-b pb-2 text-sm last:border-b-0">
                <div className="min-w-0">
                  <span
                    className={`mr-2 inline-block rounded px-1.5 py-0.5 text-xs font-medium ${SEVERITY_STYLES[e.severity] ?? SEVERITY_STYLES.info}`}
                  >
                    {e.severity}
                  </span>
                  <span className="font-medium text-foreground">
                    {AUDIT_EVENT_LABELS[e.event_type] ?? e.event_type}
                  </span>
                  {typeof e.detail?.reason === 'string' && (
                    <span className="text-muted-foreground"> — {e.detail.reason}</span>
                  )}
                  {typeof e.detail?.tool === 'string' && (
                    <span className="text-muted-foreground"> — {e.detail.tool}</span>
                  )}
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {new Date(e.created_at).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ListEditor<T>({
  title,
  description,
  items,
  onChange,
  empty,
  renderRow,
}: {
  title: string;
  description: string;
  items: T[];
  onChange: (items: T[]) => void;
  empty: T;
  renderRow: (item: T, update: (next: T) => void) => React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.map((item, i) => (
          <div key={i} className="flex items-start gap-2">
            {renderRow(item, (next) => {
              const copy = [...items];
              copy[i] = next;
              onChange(copy);
            })}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => onChange(items.filter((_, idx) => idx !== i))}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...items, empty])}>
          <Plus className="mr-1 h-4 w-4" /> Add
        </Button>
      </CardContent>
    </Card>
  );
}
