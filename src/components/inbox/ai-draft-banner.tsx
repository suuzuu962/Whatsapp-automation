"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Loader2, Pencil, Sparkles, X } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import type { AiDraftReply } from "@/types";

interface AiDraftBannerProps {
  conversationId: string;
  /** Bumped by the parent (e.g. on send/refresh) to trigger a refetch. */
  refreshToken?: number;
  onEdit: (text: string) => void;
  onResolved?: () => void;
}

/**
 * Shown above the composer when the conversation is in
 * ai_suggestion_only mode and the agent runs generated a reply it
 * hasn't sent yet — the human-in-the-loop review step for Copilot mode.
 * Approve sends the draft as-is; Edit copies it into the composer and
 * rejects the original so the agent's edited version goes out through
 * the normal manual-send path; Reject discards it with no send.
 */
export function AiDraftBanner({
  conversationId,
  refreshToken,
  onEdit,
  onResolved,
}: AiDraftBannerProps) {
  const [draft, setDraft] = useState<AiDraftReply | null>(null);
  const [busy, setBusy] = useState(false);

  const fetchDraft = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("ai_draft_replies")
      .select("*")
      .eq("conversation_id", conversationId)
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    setDraft((data as AiDraftReply | null) ?? null);
  }, [conversationId]);

  useEffect(() => {
    void fetchDraft();
  }, [fetchDraft, refreshToken]);

  async function review(action: "approve" | "reject") {
    if (!draft) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/ai/draft-replies/${draft.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? "Failed to review draft");
        return;
      }
      setDraft(null);
      onResolved?.();
      if (action === "approve") toast.success("Sent");
    } catch {
      toast.error("Failed to review draft");
    } finally {
      setBusy(false);
    }
  }

  async function handleEdit() {
    if (!draft) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/ai/draft-replies/${draft.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "reject" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? "Failed to open draft for editing");
        return;
      }
      onEdit(draft.content_text);
      setDraft(null);
      onResolved?.();
    } catch {
      toast.error("Failed to open draft for editing");
    } finally {
      setBusy(false);
    }
  }

  if (!draft) return null;

  return (
    <div className="mx-3 mb-2 rounded-lg border border-primary/30 bg-primary/5 p-3 sm:mx-4">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-primary">AI draft reply — awaiting review</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{draft.content_text}</p>
        </div>
      </div>
      <div className="mt-2 flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => review("reject")}
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
          Reject
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={handleEdit}>
          <Pencil className="h-3.5 w-3.5" />
          Edit
        </Button>
        <Button type="button" size="sm" disabled={busy} onClick={() => review("approve")}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
          Approve & send
        </Button>
      </div>
    </div>
  );
}
