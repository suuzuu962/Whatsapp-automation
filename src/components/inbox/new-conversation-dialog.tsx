"use client";

import { useState } from "react";
import type { MessageTemplate } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LayoutTemplate, Loader2 } from "lucide-react";
import { TemplatePicker, type TemplateSendValues } from "./template-picker";
import { toast } from "sonner";

interface InitialContact {
  id: string;
  phone: string;
  name?: string | null;
}

interface NewConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-fills and locks the contact when opened from a specific contact row. */
  initialContact?: InitialContact;
  onCreated: (conversationId: string) => void;
}

export function NewConversationDialog({
  open,
  onOpenChange,
  initialContact,
  onCreated,
}: NewConversationDialogProps) {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [sending, setSending] = useState(false);

  const canPickTemplate = !!initialContact || phone.trim().length > 0;

  function reset() {
    setPhone("");
    setName("");
    setSending(false);
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  async function handleSendTemplate(template: MessageTemplate, values: TemplateSendValues) {
    setSending(true);
    try {
      const res = await fetch("/api/whatsapp/start-conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contact_id: initialContact?.id,
          phone: initialContact ? undefined : phone.trim(),
          name: initialContact ? undefined : name.trim() || undefined,
          template_name: template.name,
          template_language: template.language,
          template_message_params: {
            body: values.body,
            headerText: values.headerText,
            buttonParams: values.buttonParams,
          },
          template_params: values.body,
        }),
      });
      const payload = await res.json();
      if (!res.ok) {
        toast.error(payload?.error || `Failed to start conversation (HTTP ${res.status})`);
        return;
      }
      toast.success("Conversation started");
      handleOpenChange(false);
      onCreated(payload.conversation_id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start conversation");
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <Dialog open={open && !templateModalOpen} onOpenChange={handleOpenChange}>
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              New conversation
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {initialContact
                ? "Send this contact an opening message. WhatsApp requires an approved template for the first message."
                : "Enter a phone number to message. WhatsApp requires an approved template for the first message."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {initialContact ? (
              <div className="rounded-md border border-border bg-background/50 p-3">
                <p className="text-sm font-medium text-popover-foreground">
                  {initialContact.name || initialContact.phone}
                </p>
                <p className="text-xs text-muted-foreground">{initialContact.phone}</p>
              </div>
            ) : (
              <>
                <div className="space-y-1">
                  <Label className="text-xs text-popover-foreground">Phone number</Label>
                  <Input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+1 555 123 4567"
                    className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-popover-foreground">Name (optional)</Label>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Contact name"
                    className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                  />
                </div>
              </>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => handleOpenChange(false)}
              className="border-border text-popover-foreground hover:bg-muted"
            >
              Cancel
            </Button>
            <Button
              disabled={!canPickTemplate || sending}
              onClick={() => setTemplateModalOpen(true)}
              className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {sending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <LayoutTemplate className="h-4 w-4" />
              )}
              Choose template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TemplatePicker
        open={templateModalOpen}
        onOpenChange={setTemplateModalOpen}
        onSelect={handleSendTemplate}
      />
    </>
  );
}
