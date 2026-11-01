import { useNavigate } from "@tanstack/react-router";
import { Sprout } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import useGrow from "@/hooks/mutations/forest/use-grow";
import { useResetOnOpen } from "@/hooks/use-reset-on-open";
import generateProjectSlug from "@/lib/generate-project-id";

const NAME_MAX = 120;
const SLUG_MAX = 20;

type GrowDialogProps = {
  workspaceId: string;
  seedIds: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onGrown: () => void;
};

// A new forest (project) with one task per chosen seed (R-029).
export function GrowDialog({
  workspaceId,
  seedIds,
  open,
  onOpenChange,
  onGrown,
}: GrowDialogProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const grow = useGrow(workspaceId);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  useResetOnOpen(open, () => {
    setName("");
    setSlug("");
  });
  const ready = name.trim() && slug.trim() && seedIds.length > 0;

  const submit = () => {
    if (!ready) return;
    grow.mutate(
      { workspaceId, seedIds, name: name.trim(), slug: slug.trim() },
      {
        onSuccess: (result) => {
          onOpenChange(false);
          onGrown();
          void navigate({
            to: "/dashboard/workspace/$workspaceId/project/$projectId/board",
            params: { workspaceId, projectId: result.projectId },
          });
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("workspace:forest.grow.title")}</DialogTitle>
          <DialogDescription>
            {t("workspace:forest.grow.description", {
              seeds: seedIds.length,
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="grow-name">{t("workspace:forest.grow.name")}</Label>
            <Input
              id="grow-name"
              value={name}
              maxLength={NAME_MAX}
              onChange={(event) => {
                setName(event.target.value);
                setSlug(
                  generateProjectSlug(event.target.value).slice(0, SLUG_MAX),
                );
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="grow-slug">{t("workspace:forest.grow.slug")}</Label>
            <Input
              id="grow-slug"
              value={slug}
              maxLength={SLUG_MAX}
              onChange={(event) => setSlug(event.target.value)}
            />
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common:actions.cancel")}
          </Button>
          <Button disabled={!ready || grow.isPending} onClick={submit}>
            <Sprout aria-hidden="true" />
            {t("workspace:forest.grow.submit")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
