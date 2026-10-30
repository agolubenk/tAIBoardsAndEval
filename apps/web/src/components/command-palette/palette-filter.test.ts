import { describe, expect, it } from "vite-plus/test";
import { filterPaletteGroups, type PaletteGroup } from "./palette-filter";

const contains = (text: string, query: string) =>
  text.toLowerCase().includes(query.toLowerCase());

const item = (value: string, label: string, hint?: string) => ({
  value,
  label,
  hint,
  onRun: () => {},
});

const groups: PaletteGroup[] = [
  {
    value: "commands",
    label: "Commands",
    kind: "command",
    items: [item("projects", "Projects"), item("theme-dark", "Dark theme")],
  },
  {
    value: "forest",
    label: "Forest",
    kind: "lookup",
    items: [item("forest-pulse", "Pulse"), item("forest-leases", "Leases")],
  },
  {
    value: "cards",
    label: "Tasks",
    kind: "remote",
    items: [item("card-1", "Fix the login", "TB-70")],
  },
];

const values = (result: PaletteGroup[]) =>
  result.map((group) => [group.value, group.items.map((i) => i.value)]);

describe("filterPaletteGroups", () => {
  it("lists only the commands before anything is typed", () => {
    expect(
      values(filterPaletteGroups(groups.slice(0, 2), "  ", contains)),
    ).toEqual([["commands", ["projects", "theme-dark"]]]);
  });

  it("narrows commands and lookups by the query and drops empty groups", () => {
    expect(values(filterPaletteGroups(groups, "lea", contains))).toEqual([
      ["forest", ["forest-leases"]],
      ["cards", ["card-1"]],
    ]);
  });

  it("keeps the cards the API matched even when their label does not", () => {
    expect(values(filterPaletteGroups(groups, "TB-70", contains))).toEqual([
      ["cards", ["card-1"]],
    ]);
  });

  it("lists a whole lookup group when the query names it", () => {
    expect(values(filterPaletteGroups(groups, "forest", contains))).toEqual([
      ["forest", ["forest-pulse", "forest-leases"]],
      ["cards", ["card-1"]],
    ]);
  });

  it("matches a command by its hint as well as its label", () => {
    const commands: PaletteGroup = {
      value: "commands",
      label: "Commands",
      kind: "command",
      items: [item("search", "Search", "tasks and projects")],
    };
    expect(values(filterPaletteGroups([commands], "tasks", contains))).toEqual([
      ["commands", ["search"]],
    ]);
    expect(filterPaletteGroups([commands], "commands", contains)).toEqual([]);
  });
});
