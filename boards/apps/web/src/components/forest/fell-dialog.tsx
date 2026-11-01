import { Axe } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { FellTarget } from "@/fetchers/forest/fell";
import useFell from "@/hooks/mutations/forest/use-fell";
import { useResetOnOpen } from "@/hooks/use-reset-on-open";

const REASON_MAX = 2000;

type FellDialogProps = {
  workspaceId: string;
  target: FellTarget;
  subject: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

// Felling deletes the tree's tasks from the board and keeps them as logs with
// seeds (R-028). The owner's session needs no «да»; the reason is journaled.
export function FellDialog({
  workspaceId,
  target,
  subject,
  open,
  onOpenChange,
}: FellDialogProps) {
  const { t } = useTranslation();
  const fell = useFell(workspaceId);
  const [reason, setReason] = useState("");
  useResetOnOpen(open, () => setReason(""));
  const trimmed = reason.trim();

  const submit = () => {
    if (!trimmed) return;
    fell.mutate(
      { workspaceId, target, reason: trimmed },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {target.kind === "tree"
              ? t("workspace:forest.fell.titleTree")
              : t("workspace:forest.fell.titleSector")}
          </DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{subject}</span>
            <br />
            {t("workspace:forest.fell.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-1.5">
          <Label htmlFor="fell-reason">
            {t("workspace:forest.fell.reason")}
          </Label>
          <Textarea
            id="fell-reason"
            value={reason}
            maxLength={REASON_MAX}
            placeholder={t("workspace:forest.fell.reasonPlaceholder")}
            onChange={(event) => setReason(event.target.value)}
          />
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={!trimmed || fell.isPending}
            onClick={submit}
          >
            <Axe aria-hidden="true" />
            {t("workspace:forest.fell.submit")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
