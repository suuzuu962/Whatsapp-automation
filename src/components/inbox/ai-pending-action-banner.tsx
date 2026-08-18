"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Loader2, ShieldAlert, X } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import type { AiPendingAction } from "@/types";

interface AiPendingActionBannerProps {
  conversationId: string;
  /** Bumped by the parent to trigger a refetch. */
  refreshToken?: number;
  onResolved?: () => void;
}

const TOOL_LABELS: Record<string, string> = {
  update_customer: "Update customer details",
  create_lead: "Create a lead",
  create_booking: "Book an appointment",
  reschedule_booking: "Reschedule an appointment",
  cancel_booking: "Cancel an appointment",
  send_email: "Send an email",
};

function describeAction(action: AiPendingAction): string {
  const label = TOOL_LABELS[action.tool_name] ?? action.tool_name;
  const args = Object.entries(action.tool_arguments ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ");
  return args ? `${label} — ${args}` : label;
}

/**
 * Shown above the composer whenever the AI agent queued a consequential
 * action (update_customer / create_lead) for approval instead of running
 * it — see runAiAgent's gating in src/lib/ai/agent.ts. Safe to always
 * mount: renders nothing when there's nothing pending. Unlike
 * AiDraftBanner this can hold more than one pending action, since
 * several tool calls can be gated in a single agent turn.
 */
export function AiPendingActionBanner({
  conversationId,
  refreshToken,
  onResolved,
}: AiPendingActionBannerProps) {
  const [actions, setActions] = useState<AiPendingAction[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchActions = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("ai_pending_actions")
      .select("*")
      .eq("conversation_id", conversationId)
      .eq("status", "pending")
      .order("created_at", { ascending: true });
    setActions((data as AiPendingAction[] | null) ?? []);
  }, [conversationId]);

  useEffect(() => {
    void fetchActions();
  }, [fetchActions, refreshToken]);

  async function review(action: AiPendingAction, decision: "approve" | "reject") {
    setBusyId(action.id);
    try {
      const res = await fetch(`/api/ai/pending-actions/${action.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: decision }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Failed to review action");
        return;
      }
      setActions((prev) => prev.filter((a) => a.id !== action.id));
      onResolved?.();
      if (decision === "approve") toast.success("Action approved and completed");
    } catch {
      toast.error("Failed to review action");
    } finally {
      setBusyId(null);
    }
  }

  if (actions.length === 0) return null;

  return (
    <div className="mx-3 mb-2 space-y-2 sm:mx-4">
      {actions.map((action) => {
        const busy = busyId === action.id;
        return (
          <div
            key={action.id}
            className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
          >
            <div className="flex items-start gap-2">
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-amber-700 dark:text-amber-500">
                  AI wants to take an action — awaiting approval
                </p>
                <p className="mt-1 text-sm text-foreground">{describeAction(action)}</p>
              </div>
            </div>
            <div className="mt-2 flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => review(action, "reject")}
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
                Reject
              </Button>
              <Button type="button" size="sm" disabled={busy} onClick={() => review(action, "approve")}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                Approve
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
