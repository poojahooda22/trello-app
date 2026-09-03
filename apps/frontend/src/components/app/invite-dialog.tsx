/**
 * Invite someone by email, the way GitHub asks for a collaborator.
 *
 * Membership is organization scoped, not board scoped, so this grants access to
 * every board in the workspace. The copy says so rather than implying the
 * invite is limited to the board it was opened from.
 *
 * The backend only emails when RESEND_API_KEY is configured; otherwise it
 * returns the accept link instead. Both outcomes are handled, so the flow works
 * on a deployment with no mail provider.
 */
import { useMutation } from "@tanstack/react-query";
import { Check, Copy, Link2, Send, UserPlus } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { inviteMember, type InviteResult } from "@/lib/api";

export function InviteDialog({ orgId, orgName }: { orgId: string; orgName: string }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [copied, setCopied] = useState(false);

  const invite = useMutation<InviteResult, Error, { orgId: string; email: string }>({
    mutationFn: inviteMember,
  });

  function reset() {
    setEmail("");
    setCopied(false);
    invite.reset();
  }

  async function copyLink(link: string) {
    // Clipboard access needs a secure context; on plain HTTP the button would
    // silently do nothing, so the link stays selectable text either way.
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger
        aria-label="Invite someone"
        title="Invite someone"
        className="border-surface bg-surface-subtle text-text-subtle hover:bg-surface-hover focus-visible:ring-ring/50 flex size-7 items-center justify-center rounded-full border-2 outline-none transition-colors focus-visible:ring-[3px]"
      >
        <UserPlus className="size-3.5" />
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite to {orgName}</DialogTitle>
          <DialogDescription>
            They will be able to see every board in this workspace. The invitation expires in 7 days.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = email.trim();
            if (trimmed) invite.mutate({ orgId, email: trimmed });
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="invite-email" className="text-text-subtle text-xs font-semibold">
              Email address
            </Label>
            <Input
              id="invite-email"
              type="email"
              required
              autoFocus
              placeholder="name@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="h-10"
            />
          </div>

          <Button type="submit" disabled={invite.isPending || !email.trim()} className="h-10 w-full">
            <Send className="size-4" />
            {invite.isPending ? "Sending…" : "Send invitation"}
          </Button>
        </form>

        {invite.isError && <p className="text-destructive mt-3 text-sm">{invite.error.message}</p>}

        {invite.isSuccess && invite.data.emailed && (
          <p className="text-success-text bg-success-subtle mt-3 flex items-center gap-2 rounded-md px-3 py-2 text-sm">
            <Check className="size-4 shrink-0" />
            Invitation emailed to {invite.data.email}.
          </p>
        )}

        {invite.isSuccess && !invite.data.emailed && invite.data.link && (
          <div className="border-border-subtle mt-3 flex flex-col gap-2 rounded-md border p-3">
            {/* Two different reasons land here: nothing is configured, or the
                provider refused the send. Naming the refusal is what lets the
                admin fix it, rather than hunting for a key that is present. */}
            <p className="text-text-subtle flex items-center gap-2 text-sm">
              <Link2 className="size-4 shrink-0" />
              {invite.data.emailError
                ? `The email could not be sent (${invite.data.emailError}), so send this link yourself:`
                : "No mail provider is configured, so send this link yourself:"}
            </p>
            <div className="flex items-center gap-2">
              <code className="bg-surface-sunken text-text-subtle min-w-0 flex-1 truncate rounded px-2 py-1.5 text-xs">
                {invite.data.link}
              </code>
              <Button
                type="button"
                variant="outline"
                onClick={() => copyLink(invite.data.link!)}
                className="h-8 shrink-0"
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
