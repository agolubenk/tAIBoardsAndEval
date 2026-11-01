import type { ShortcutId } from "@/lib/shortcuts/catalog";

export type PaletteItem = {
  value: string;
  label: string;
  hint?: string;
  shortcutId?: ShortcutId;
  onRun: () => void;
};

// "command" groups are listed before anything is typed; "lookup" groups (forest
// tabs, sectors) appear only once a query narrows them, and naming the group
// ("forest", "sectors") lists all of it; "remote" groups hold cards the search
// API has already matched, so they are not filtered again.
export type PaletteGroupKind = "command" | "lookup" | "remote";

export type PaletteGroup = {
  value: string;
  label: string;
  kind: PaletteGroupKind;
  items: PaletteItem[];
};

type Contains = (text: string, query: string) => boolean;

function visibleItems(group: PaletteGroup, query: string, contains: Contains) {
  if (group.kind === "remote") return group.items;
  if (!query) return group.kind === "command" ? group.items : [];
  const prefix = group.kind === "lookup" ? `${group.label} ` : "";
  return group.items.filter((item) =>
    contains(`${prefix}${item.label} ${item.hint ?? ""}`, query),
  );
}

export function filterPaletteGroups(
  groups: PaletteGroup[],
  query: string,
  contains: Contains,
): PaletteGroup[] {
  const trimmed = query.trim();
  return groups.flatMap((group) => {
    const items = visibleItems(group, trimmed, contains);
    return items.length > 0 ? [{ ...group, items }] : [];
  });
}
