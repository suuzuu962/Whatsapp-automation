'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2, ChevronDown, ChevronUp } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import type { StaffMember } from '@/types';
import { DAY_LABELS, type DayRow, emptyDayRows, windowsToDayRows, dayRowsToWindows } from './day-rows';

// ------------------------------------------------------------
// Named-staff / multi-resource booking. A business with zero staff
// rows here keeps the original single shared-calendar behavior — this
// card is entirely optional. Once staff exist, the AI's booking tools
// (src/lib/ai/tools.ts) auto-assign whichever active staff member is
// free, or honor an explicit customer request by name.
//
// Self-contained: fetches/saves via its own /api/ai/staff routes rather
// than folding into the parent AiAgentConfigPanel's single "Save
// configuration" button — staff live in their own table
// (031_ai_staff_booking.sql), not on ai_agent_config.
// ------------------------------------------------------------

export function StaffManagementCard() {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [adding, setAdding] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const fetchStaff = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/staff');
      const data = await res.json();
      if (res.ok) setStaff(data.staff ?? []);
    } catch {
      toast.error('Failed to load staff');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStaff();
  }, [fetchStaff]);

  async function handleAdd() {
    if (!newName.trim()) return;
    setAdding(true);
    try {
      const res = await fetch('/api/ai/staff', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to add staff member');
        return;
      }
      setStaff((prev) => [...prev, data.staff]);
      setNewName('');
    } catch {
      toast.error('Failed to add staff member');
    } finally {
      setAdding(false);
    }
  }

  async function handleToggleActive(member: StaffMember) {
    const res = await fetch(`/api/ai/staff/${member.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ active: !member.active }),
    });
    if (!res.ok) {
      toast.error('Failed to update staff member');
      return;
    }
    setStaff((prev) => prev.map((s) => (s.id === member.id ? { ...s, active: !s.active } : s)));
  }

  async function handleDelete(member: StaffMember) {
    const res = await fetch(`/api/ai/staff/${member.id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error('Failed to remove staff member');
      return;
    }
    setStaff((prev) => prev.filter((s) => s.id !== member.id));
  }

  async function handleSaveHours(member: StaffMember, rows: DayRow[]) {
    const working_hours = dayRowsToWindows(rows);
    const res = await fetch(`/api/ai/staff/${member.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ working_hours }),
    });
    const data = await res.json();
    if (!res.ok) {
      toast.error(data.error ?? 'Failed to save hours');
      return;
    }
    setStaff((prev) => prev.map((s) => (s.id === member.id ? data.staff : s)));
    toast.success(`${member.name}'s hours saved`);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Staff</CardTitle>
        <CardDescription>
          Optional. With no staff added, bookings use one shared calendar. Add staff to let the
          AI auto-assign whoever&apos;s free, or book with whoever the customer specifically asks
          for — each can have their own hours, or inherit the business hours above.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {staff.map((member) => (
              <StaffRow
                key={member.id}
                member={member}
                expanded={expandedId === member.id}
                onToggleExpand={() =>
                  setExpandedId((cur) => (cur === member.id ? null : member.id))
                }
                onToggleActive={() => handleToggleActive(member)}
                onDelete={() => handleDelete(member)}
                onSaveHours={(rows) => handleSaveHours(member, rows)}
              />
            ))}
            <div className="flex items-center gap-2">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Staff member name"
                onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              />
              <Button type="button" variant="outline" size="sm" onClick={handleAdd} disabled={adding}>
                {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Add
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function StaffRow({
  member,
  expanded,
  onToggleExpand,
  onToggleActive,
  onDelete,
  onSaveHours,
}: {
  member: StaffMember;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
  onSaveHours: (rows: DayRow[]) => void;
}) {
  const hasCustomHours = (member.working_hours ?? []).length > 0;
  const [rows, setRows] = useState<DayRow[]>(() => windowsToDayRows(member.working_hours));
  const [useCustom, setUseCustom] = useState(hasCustomHours);

  return (
    <div className="rounded-lg border border-border">
      <div className="flex items-center gap-2 p-2">
        <button
          type="button"
          onClick={onToggleExpand}
          className="flex flex-1 items-center gap-2 text-left"
        >
          {expanded ? (
            <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          <span className="text-sm font-medium text-foreground">{member.name}</span>
          {hasCustomHours && (
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              Custom hours
            </span>
          )}
        </button>
        <Switch checked={member.active} onCheckedChange={onToggleActive} />
        <Button type="button" variant="ghost" size="icon" onClick={onDelete}>
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      {expanded && (
        <div className="space-y-3 border-t border-border p-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={useCustom}
              onChange={(e) => {
                setUseCustom(e.target.checked);
                if (!e.target.checked) {
                  setRows(emptyDayRows());
                  onSaveHours(emptyDayRows());
                }
              }}
            />
            Use custom hours for {member.name} (instead of the business hours above)
          </label>
          {useCustom && (
            <>
              <div className="space-y-2">
                {rows.map((row, i) => (
                  <div key={row.day} className="flex items-center gap-3">
                    <label className="flex w-24 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={row.enabled}
                        onChange={(e) => {
                          const next = [...rows];
                          next[i] = { ...next[i], enabled: e.target.checked };
                          setRows(next);
                        }}
                      />
                      {DAY_LABELS[row.day]}
                    </label>
                    <Input
                      type="time"
                      className="w-32"
                      disabled={!row.enabled}
                      value={row.open}
                      onChange={(e) => {
                        const next = [...rows];
                        next[i] = { ...next[i], open: e.target.value };
                        setRows(next);
                      }}
                    />
                    <span className="text-sm text-muted-foreground">to</span>
                    <Input
                      type="time"
                      className="w-32"
                      disabled={!row.enabled}
                      value={row.close}
                      onChange={(e) => {
                        const next = [...rows];
                        next[i] = { ...next[i], close: e.target.value };
                        setRows(next);
                      }}
                    />
                  </div>
                ))}
              </div>
              <div className="flex justify-end">
                <Button type="button" size="sm" onClick={() => onSaveHours(rows)}>
                  Save hours
                </Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
