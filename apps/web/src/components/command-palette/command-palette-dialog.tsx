import { useCallback } from "react";
import { CommandDialog, CommandDialogPopup } from "@/components/ui/command";
import { PaletteContent } from "./palette-content";
import type { PaletteActions } from "./use-command-groups";

type CommandPaletteDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: PaletteActions;
};

function CommandPaletteDialog({
  open,
  onOpenChange,
  actions,
}: CommandPaletteDialogProps) {
  const runCommand = useCallback(
    (command: () => void) => {
      command();
      onOpenChange(false);
    },
    [onOpenChange],
  );

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandDialogPopup instant>
        <PaletteContent actions={actions} onRun={runCommand} />
      </CommandDialogPopup>
    </CommandDialog>
  );
}

export default CommandPaletteDialog;
