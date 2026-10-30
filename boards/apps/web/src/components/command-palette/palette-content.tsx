import { Fragment, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ShortcutKeys } from "@/components/shortcuts/shortcut-keys";
import { useAutocompleteFilter } from "@/components/ui/autocomplete";
import {
  Command,
  CommandCollection,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import useActiveWorkspace from "@/hooks/queries/workspace/use-active-workspace";
import {
  filterPaletteGroups,
  type PaletteGroup,
  type PaletteItem,
} from "./palette-filter";
import { PaletteFooter } from "./palette-footer";
import { useCardGroups } from "./use-card-groups";
import { type PaletteActions, useCommandGroups } from "./use-command-groups";
import { useForestGroups } from "./use-forest-groups";

type PaletteContentProps = {
  actions: PaletteActions;
  onRun: (run: () => void) => void;
};

// Mounted only while the palette is open, so the forest and card lookups stop
// with it.
export function PaletteContent({ actions, onRun }: PaletteContentProps) {
  const { t } = useTranslation();
  const { data: workspace } = useActiveWorkspace();
  const [query, setQuery] = useState("");
  const { contains } = useAutocompleteFilter({ sensitivity: "base" });
  const commands = useCommandGroups(workspace?.id, actions);
  const forest = useForestGroups(workspace?.id, query);
  const cards = useCardGroups(workspace?.id, query);
  const groups = useMemo(
    () => [...commands, ...cards, ...forest],
    [cards, commands, forest],
  );
  // The palette filters itself: commands and forest targets by text, cards as
  // the search API matched them (by title or a short id like TB-70).
  const visible = useMemo(
    () => filterPaletteGroups(groups, query, contains),
    [contains, groups, query],
  );

  return (
    <Command
      items={groups}
      filteredItems={visible}
      value={query}
      onValueChange={setQuery}
    >
      <CommandInput
        placeholder={t("navigation:commandPalette.inputPlaceholder")}
      />
      <CommandPanel>
        <CommandEmpty>{t("navigation:commandPalette.empty")}</CommandEmpty>
        <CommandList>
          {(group: PaletteGroup, groupIndex: number) => (
            <Fragment key={group.value}>
              <CommandGroup items={group.items}>
                <CommandGroupLabel>{group.label}</CommandGroupLabel>
                <CommandCollection>
                  {(item: PaletteItem) => (
                    <CommandItem
                      key={item.value}
                      value={item}
                      onClick={() => onRun(item.onRun)}
                      className="gap-2 px-3"
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {item.label}
                      </span>
                      {item.hint ? (
                        <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                          {item.hint}
                        </span>
                      ) : null}
                      {item.shortcutId ? (
                        <CommandShortcut>
                          <ShortcutKeys id={item.shortcutId} tone="muted" />
                        </CommandShortcut>
                      ) : null}
                    </CommandItem>
                  )}
                </CommandCollection>
              </CommandGroup>
              {groupIndex < visible.length - 1 && <CommandSeparator />}
            </Fragment>
          )}
        </CommandList>
      </CommandPanel>
      <PaletteFooter />
    </Command>
  );
}
