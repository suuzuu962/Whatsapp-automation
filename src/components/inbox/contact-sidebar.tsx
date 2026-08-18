"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import type { Appointment, Contact, Deal, ContactNote, Tag, AiAgentConfig, StaffMember } from "@/types";
import {
  Phone,
  Mail,
  Copy,
  Check,
  User,
  Tag as TagIcon,
  DollarSign,
  StickyNote,
  Plus,
  CalendarClock,
  Pencil,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { format } from "date-fns";

interface ContactSidebarProps {
  contact: Contact | null;
}

/** ISO string -> "YYYY-MM-DDTHH:mm" in the browser's local timezone, the
 *  shape <input type="datetime-local"> needs. Inverse of `new
 *  Date(value).toISOString()`, which datetime-local values already
 *  round-trip correctly through since JS parses them as local time. */
function toDatetimeLocalValue(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ContactSidebar({ contact }: ContactSidebarProps) {
  const { accountId } = useAuth();
  const [copied, setCopied] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  const [tags, setTags] = useState<(Tag & { contact_tag_id: string })[]>([]);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);

  // Manual booking management — the CRM-side counterpart to the AI's
  // booking tools (src/lib/ai/tools.ts). aiConfig/staffList are
  // account-wide (not per-contact), fetched once via the same routes
  // the AI Agent settings page uses.
  const [aiConfig, setAiConfig] = useState<AiAgentConfig | null>(null);
  const [staffList, setStaffList] = useState<StaffMember[]>([]);
  const [showBookingForm, setShowBookingForm] = useState(false);
  const [bookingService, setBookingService] = useState("");
  const [bookingStart, setBookingStart] = useState("");
  const [bookingStaff, setBookingStaff] = useState("");
  const [bookingNotes, setBookingNotes] = useState("");
  const [savingBooking, setSavingBooking] = useState(false);
  const [reschedulingId, setReschedulingId] = useState<string | null>(null);
  const [rescheduleValue, setRescheduleValue] = useState("");

  useEffect(() => {
    if (!accountId) return;
    (async () => {
      const [configRes, staffRes] = await Promise.all([
        fetch("/api/ai/agent-config").then((r) => r.json()).catch(() => null),
        fetch("/api/ai/staff").then((r) => r.json()).catch(() => null),
      ]);
      if (configRes?.config) setAiConfig(configRes.config);
      if (staffRes?.staff) setStaffList(staffRes.staff.filter((s: StaffMember) => s.active));
    })();
  }, [accountId]);

  const fetchContactData = useCallback(async () => {
    if (!contact) return;

    const supabase = createClient();

    // Fetch deals, upcoming bookings, notes, and tags in parallel
    const [dealsRes, appointmentsRes, notesRes, tagsRes] = await Promise.all([
      supabase
        .from("deals")
        .select("*, stage:pipeline_stages(*)")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("appointments")
        .select("*")
        .eq("contact_id", contact.id)
        .eq("status", "booked")
        .gte("starts_at", new Date().toISOString())
        .order("starts_at", { ascending: true }),
      supabase
        .from("contact_notes")
        .select("*")
        .eq("contact_id", contact.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("contact_tags")
        .select("id, tag_id, tags(*)")
        .eq("contact_id", contact.id),
    ]);

    if (dealsRes.data) setDeals(dealsRes.data);
    if (appointmentsRes.data) setAppointments(appointmentsRes.data);
    if (notesRes.data) setNotes(notesRes.data);
    if (tagsRes.data) {
      const mapped = tagsRes.data
        .filter((ct: Record<string, unknown>) => ct.tags)
        .map((ct: Record<string, unknown>) => ({
          ...(ct.tags as Tag),
          contact_tag_id: ct.id as string,
        }));
      setTags(mapped);
    }
  }, [contact]);

  // Load on contact change. setContactData/setTags run inside async
  // Supabase callbacks, not synchronously in the effect body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchContactData();
  }, [fetchContactData]);

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    // Dep is the whole `contact` object (not `contact?.phone`) so the
    // React Compiler's inference agrees with the manual dep list —
    // fixes the `preserve-manual-memoization` lint error.
  }, [contact]);

  const handleAddNote = useCallback(async () => {
    if (!contact || !newNote.trim()) return;
    if (!accountId) return;
    setAddingNote(true);

    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;

    const { data, error } = await supabase
      .from("contact_notes")
      .insert({
        contact_id: contact.id,
        account_id: accountId,
        user_id: user?.id,
        note_text: newNote.trim(),
      })
      .select()
      .single();

    if (!error && data) {
      setNotes((prev) => [data, ...prev]);
      setNewNote("");
    }
    setAddingNote(false);
  }, [contact, newNote, accountId]);

  const handleCreateBooking = useCallback(async () => {
    if (!contact || !bookingService.trim() || !bookingStart) return;
    setSavingBooking(true);
    try {
      const res = await fetch("/api/appointments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contact_id: contact.id,
          service: bookingService.trim(),
          start_time: new Date(bookingStart).toISOString(),
          staff: bookingStaff || undefined,
          notes: bookingNotes.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Failed to create booking");
        return;
      }
      toast.success("Booking created");
      setShowBookingForm(false);
      setBookingService("");
      setBookingStart("");
      setBookingStaff("");
      setBookingNotes("");
      fetchContactData();
    } catch {
      toast.error("Failed to create booking");
    } finally {
      setSavingBooking(false);
    }
  }, [contact, bookingService, bookingStart, bookingStaff, bookingNotes, fetchContactData]);

  const handleConfirmReschedule = useCallback(
    async (appointmentId: string) => {
      if (!rescheduleValue) return;
      const res = await fetch(`/api/appointments/${appointmentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ new_start_time: new Date(rescheduleValue).toISOString() }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Failed to reschedule");
        return;
      }
      toast.success("Booking rescheduled");
      setReschedulingId(null);
      fetchContactData();
    },
    [rescheduleValue, fetchContactData],
  );

  const handleCancelBooking = useCallback(
    async (appointmentId: string) => {
      if (!confirm("Cancel this booking?")) return;
      const res = await fetch(`/api/appointments/${appointmentId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "cancelled" }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Failed to cancel booking");
        return;
      }
      toast.success("Booking cancelled");
      fetchContactData();
    },
    [fetchContactData],
  );

  if (!contact) {
    return (
      <div className="flex h-full w-70 items-center justify-center border-l border-border bg-card">
        <p className="text-sm text-muted-foreground">Select a conversation</p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div className="flex h-full w-70 flex-col border-l border-border bg-card">
      <ScrollArea className="flex-1">
        <div className="p-4">
          {/* Contact Info */}
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-lg font-semibold text-foreground">
              {contact.avatar_url ? (
                <img
                  src={contact.avatar_url}
                  alt={displayName}
                  className="h-16 w-16 rounded-full object-cover"
                />
              ) : (
                initials
              )}
            </div>
            <h3 className="mt-3 text-sm font-semibold text-foreground">
              {displayName}
            </h3>
            {contact.company && (
              <p className="text-xs text-muted-foreground">{contact.company}</p>
            )}
            {contact.opted_out_at && (
              <span className="mt-2 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-medium text-destructive">
                Opted out
              </span>
            )}
          </div>

          {/* Phone */}
          <div className="mt-4 space-y-2">
            <button
              onClick={handleCopyPhone}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              <Phone className="h-4 w-4 text-muted-foreground" />
              <span className="flex-1 text-left">{contact.phone}</span>
              {copied ? (
                <Check className="h-3 w-3 text-primary" />
              ) : (
                <Copy className="h-3 w-3 text-muted-foreground" />
              )}
            </button>

            {contact.email && (
              <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <span className="truncate">{contact.email}</span>
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Tags */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <TagIcon className="h-3 w-3" />
              Tags
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {tags.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">No tags</p>
              ) : (
                tags.map((tag) => (
                  <span
                    key={tag.contact_tag_id}
                    className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                    style={{
                      backgroundColor: `${tag.color}20`,
                      color: tag.color,
                    }}
                  >
                    {tag.name}
                  </span>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Active Deals */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <DollarSign className="h-3 w-3" />
              Active Deals
            </div>
            <div className="mt-2 space-y-2">
              {deals.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">No deals</p>
              ) : (
                deals.map((deal) => (
                  <div
                    key={deal.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="text-sm font-medium text-foreground">
                      {deal.title}
                    </p>
                    <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {deal.currency ?? "$"}
                        {deal.value.toLocaleString()}
                      </span>
                      {deal.stage && (
                        <span
                          className="rounded-full px-1.5 py-0.5 text-[10px]"
                          style={{
                            backgroundColor: `${deal.stage.color}20`,
                            color: deal.stage.color,
                          }}
                        >
                          {deal.stage.name}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Upcoming Appointments — booked/rescheduled/cancelled by the
              AI's booking tools (src/lib/ai/tools.ts), or manually here
              via /api/appointments (same validation, see
              src/lib/ai/booking/manage.ts). */}
          <div>
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <CalendarClock className="h-3 w-3" />
                Upcoming Appointments
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="h-auto p-1"
                onClick={() => setShowBookingForm((v) => !v)}
              >
                <Plus className="h-3 w-3" />
              </Button>
            </div>

            {showBookingForm && (
              <div className="mt-2 space-y-2 rounded-lg border border-border p-2">
                {aiConfig?.services && aiConfig.services.length > 0 ? (
                  <select
                    value={bookingService}
                    onChange={(e) => setBookingService(e.target.value)}
                    className="w-full rounded-lg border border-border bg-muted px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary/50"
                  >
                    <option value="">Select a service…</option>
                    {aiConfig.services.map((s) => (
                      <option key={s.name} value={s.name}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    value={bookingService}
                    onChange={(e) => setBookingService(e.target.value)}
                    placeholder="Service"
                    className="h-8 text-xs"
                  />
                )}
                <Input
                  type="datetime-local"
                  value={bookingStart}
                  onChange={(e) => setBookingStart(e.target.value)}
                  className="h-8 text-xs"
                />
                {staffList.length > 0 && (
                  <select
                    value={bookingStaff}
                    onChange={(e) => setBookingStaff(e.target.value)}
                    className="w-full rounded-lg border border-border bg-muted px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary/50"
                  >
                    <option value="">Any available staff</option>
                    {staffList.map((s) => (
                      <option key={s.id} value={s.name}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                )}
                <textarea
                  value={bookingNotes}
                  onChange={(e) => setBookingNotes(e.target.value)}
                  placeholder="Notes (optional)"
                  rows={2}
                  className="w-full resize-none rounded-lg border border-border bg-muted px-2 py-1.5 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <div className="flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-auto px-2 py-1 text-xs"
                    onClick={() => setShowBookingForm(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    className="h-auto bg-primary px-2 py-1 text-xs hover:bg-primary/90"
                    onClick={handleCreateBooking}
                    disabled={!bookingService.trim() || !bookingStart || savingBooking}
                  >
                    Book
                  </Button>
                </div>
              </div>
            )}

            <div className="mt-2 space-y-2">
              {appointments.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">No upcoming appointments</p>
              ) : (
                appointments.map((appt) => (
                  <div key={appt.id} className="rounded-lg bg-muted px-3 py-2">
                    {reschedulingId === appt.id ? (
                      <div className="space-y-2">
                        <Input
                          type="datetime-local"
                          value={rescheduleValue}
                          onChange={(e) => setRescheduleValue(e.target.value)}
                          className="h-8 text-xs"
                        />
                        <div className="flex justify-end gap-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-auto px-2 py-1 text-xs"
                            onClick={() => setReschedulingId(null)}
                          >
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            className="h-auto bg-primary px-2 py-1 text-xs hover:bg-primary/90"
                            onClick={() => handleConfirmReschedule(appt.id)}
                            disabled={!rescheduleValue}
                          >
                            Save
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground">{appt.service}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {format(new Date(appt.starts_at), "MMM d, yyyy HH:mm")}
                          </p>
                          {appt.notes && (
                            <p className="mt-1 truncate text-xs text-muted-foreground">{appt.notes}</p>
                          )}
                        </div>
                        <div className="flex shrink-0 gap-1">
                          <button
                            type="button"
                            onClick={() => {
                              setReschedulingId(appt.id);
                              setRescheduleValue(toDatetimeLocalValue(appt.starts_at));
                            }}
                            className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                            title="Reschedule"
                          >
                            <Pencil className="h-3 w-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleCancelBooking(appt.id)}
                            className="rounded p-1 text-muted-foreground hover:bg-background hover:text-destructive"
                            title="Cancel booking"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="my-4 border-t border-border" />

          {/* Notes */}
          <div>
            <div className="flex items-center gap-2 px-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              <StickyNote className="h-3 w-3" />
              Notes
            </div>
            <div className="mt-2">
              <div className="flex gap-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder="Add a note..."
                  rows={2}
                  className="flex-1 resize-none rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <Button
                  size="sm"
                  className="h-auto bg-primary px-2 hover:bg-primary/90"
                  onClick={handleAddNote}
                  disabled={!newNote.trim() || addingNote}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>

              <div className="mt-2 space-y-2">
                {notes.map((note) => (
                  <div
                    key={note.id}
                    className="rounded-lg bg-muted px-3 py-2"
                  >
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                      {note.note_text}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {format(new Date(note.created_at), "MMM d, yyyy HH:mm")}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
