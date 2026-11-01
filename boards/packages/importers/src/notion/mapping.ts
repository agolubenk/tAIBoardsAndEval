import { toColumnSlug, uniqueKey } from "../keys.js";
import { toIsoDate } from "../markdown.js";
import type {
  ImportedColumn,
  ImportedLabel,
  ImportedPerson,
  ImportedPriority,
  ImportedProject,
  ImportedRelation,
  ImportedTask,
} from "../types.js";
import {
  plainText,
  type NotionDatabase,
  type NotionPage,
  type NotionPerson,
  type NotionPropertySchema,
  type NotionPropertyValue,
  type NotionSelectOption,
} from "./api-types.js";
import { notionIdempotencyKey } from "./idempotency.js";

const STATUS_NAME = /^status$/i;
const PRIORITY_NAME = /^priority$/i;
const SEVERITY_NAME = /^severity$/i;
const DUE_DATE_NAME = /^(due|due date|deadline)$/i;
const ASSIGNEE_NAME = /^(assignee|owner|responsible)$/i;
const PARENT_NAME = /^parent/i;
const SUBITEM_NAME = /^(sub-?items?|subtasks?|children)$/i;
const FINAL_STATUS_NAME =
  /^(done|complete[ds]?|closed|resolved|cancelled|canceled|won't do|готово|закрыт[оа]?|выполнено)/i;
const COMPLETE_GROUP = "complete";

export const FALLBACK_LABEL_COLOR = "#6b7280";

// Notion gives label colors as names; kaneo stores hex.
const NOTION_COLORS: Record<string, string> = {
  gray: "#9ca3af",
  brown: "#a18072",
  orange: "#f97316",
  yellow: "#eab308",
  green: "#22c55e",
  blue: "#3b82f6",
  purple: "#a855f7",
  pink: "#ec4899",
  red: "#ef4444",
};

const PRIORITY_NAMES: Array<[RegExp, ImportedPriority]> = [
  [/urgent|critical|критич|\bp0\b/i, "urgent"],
  [/high|высок|\bp1\b/i, "high"],
  [/medium|\bmed\b|средн|\bp2\b/i, "medium"],
  [/low|низк|\bp3\b/i, "low"],
];

export function mapPriorityName(
  name: string | null | undefined,
): ImportedPriority {
  if (!name) return "no-priority";
  for (const [pattern, priority] of PRIORITY_NAMES) {
    if (pattern.test(name)) return priority;
  }
  return "no-priority";
}

export function statusPropertyOf(
  database: NotionDatabase,
): { name: string; schema: NotionPropertySchema } | undefined {
  const entries = Object.entries(database.properties);
  const named = entries.find(
    ([name, schema]) =>
      STATUS_NAME.test(name) &&
      (schema.type === "status" || schema.type === "select"),
  );
  if (named) return { name: named[0], schema: named[1] };
  const typed = entries.find(([, schema]) => schema.type === "status");
  return typed ? { name: typed[0], schema: typed[1] } : undefined;
}

function statusOptions(schema: NotionPropertySchema): NotionSelectOption[] {
  return schema.status?.options ?? schema.select?.options ?? [];
}

function finalOptionNames(schema: NotionPropertySchema): Set<string> {
  const groups = schema.status?.groups ?? [];
  const completeIds = new Set(
    groups
      .filter((group) => group.name.trim().toLowerCase() === COMPLETE_GROUP)
      .flatMap((group) => group.option_ids ?? []),
  );
  const final = new Set<string>();
  for (const option of statusOptions(schema)) {
    const byGroup = option.id != null && completeIds.has(option.id);
    if (
      byGroup ||
      (groups.length === 0 && FINAL_STATUS_NAME.test(option.name))
    ) {
      final.add(option.name);
    }
  }
  return final;
}

export type ColumnPlan = {
  columns: ImportedColumn[];
  columnKeyByStatus: ReadonlyMap<string, string>;
};

export function mapColumns(database: NotionDatabase): ColumnPlan {
  const property = statusPropertyOf(database);
  if (!property) return { columns: [], columnKeyByStatus: new Map() };

  const finalNames = finalOptionNames(property.schema);
  const taken = new Set<string>();
  const columns: ImportedColumn[] = [];
  const columnKeyByStatus = new Map<string, string>();

  statusOptions(property.schema).forEach((option, index) => {
    const name = option.name.trim() || "Untitled";
    const slug = toColumnSlug(name) || `column-${index + 1}`;
    const key = uniqueKey(slug, taken, 64);
    taken.add(key);
    columns.push({ key, name, isFinal: finalNames.has(option.name) });
    columnKeyByStatus.set(option.name, key);
  });

  return { columns, columnKeyByStatus };
}

export function statusNameOf(page: NotionPage): string | undefined {
  const entries = Object.entries(page.properties);
  const named = entries.find(
    ([name, value]) =>
      STATUS_NAME.test(name) &&
      (value.type === "status" || value.type === "select"),
  );
  const typed = entries.find(([, value]) => value.type === "status");
  const value = (named ?? typed)?.[1];
  return value?.status?.name ?? value?.select?.name ?? undefined;
}

export function typeNameOf(page: NotionPage): string | undefined {
  for (const [name, value] of Object.entries(page.properties)) {
    if (!/^type$/i.test(name)) continue;
    return value.select?.name ?? value.status?.name ?? undefined;
  }
  return undefined;
}

export function pageTitleOf(page: NotionPage): string {
  for (const value of Object.values(page.properties)) {
    if (value.type === "title") {
      const title = plainText(value.title);
      if (title) return title;
    }
  }
  return "Untitled";
}

export type MappedPage = {
  task: ImportedTask;
  relations: ImportedRelation[];
  labels: ImportedLabel[];
};

export type MapPageContext = {
  product: string;
  columnKeyByStatus: ReadonlyMap<string, string>;
  description: string;
};

export function mapPage(page: NotionPage, context: MapPageContext): MappedPage {
  const key = notionIdempotencyKey(context.product, page.id);
  const extraFields: Record<string, string | number | boolean | null> = {};
  const relations: ImportedRelation[] = [];
  const labels: ImportedLabel[] = [];

  let priorityRaw: string | undefined;
  let severityRaw: string | undefined;
  let number: number | undefined;
  let dueDate: string | undefined;
  let assignee: ImportedPerson | undefined;
  let fallbackAssignee: ImportedPerson | undefined;

  for (const [name, value] of Object.entries(page.properties)) {
    if (value.type === "title") continue;

    if (value.type === "relation") {
      for (const target of value.relation ?? []) {
        relations.push(
          toRelation(
            name,
            key,
            notionIdempotencyKey(context.product, target.id),
          ),
        );
      }
      continue;
    }

    if (PRIORITY_NAME.test(name)) {
      priorityRaw = value.select?.name ?? value.status?.name ?? priorityRaw;
    } else if (SEVERITY_NAME.test(name)) {
      severityRaw = value.select?.name ?? value.status?.name ?? severityRaw;
    }

    if (value.type === "multi_select") {
      for (const option of value.multi_select ?? []) {
        labels.push({
          key: option.id ?? (toColumnSlug(option.name) || option.name),
          name: option.name,
          color: NOTION_COLORS[option.color ?? ""] ?? FALLBACK_LABEL_COLOR,
        });
      }
    }

    if (value.type === "unique_id" && value.unique_id) {
      number = value.unique_id.number;
    }

    if (value.type === "date" && DUE_DATE_NAME.test(name)) {
      dueDate = toIsoDate(value.date?.start) ?? dueDate;
    }

    if (value.type === "people") {
      const person = toPerson(value.people?.[0]);
      if (person) {
        if (ASSIGNEE_NAME.test(name)) assignee ??= person;
        else fallbackAssignee ??= person;
      }
    }

    const scalar = scalarOf(value);
    if (scalar !== undefined) extraFields[name] = scalar;
  }

  const status = statusNameOf(page);
  const columnKey = status
    ? (context.columnKeyByStatus.get(status) ?? null)
    : null;
  const inTrash = page.in_trash === true;
  const archived = page.archived || inTrash;
  const createdAt = toIsoDate(page.created_time);
  const assigneePerson = assignee ?? fallbackAssignee;

  const task: ImportedTask = {
    key,
    ...(number !== undefined ? { number } : {}),
    columnKey,
    ...(archived
      ? {
          archived: true,
          terminalReason: inTrash
            ? "Page is in the Notion trash"
            : "Page is archived in Notion",
        }
      : {}),
    title: pageTitleOf(page),
    description: context.description,
    priority: mapPriorityName(priorityRaw ?? severityRaw),
    ...(dueDate ? { dueDate } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(assigneePerson ? { assignee: assigneePerson } : {}),
    labelKeys: labels.map((label) => label.key),
    comments: [],
    sourceRef: {
      system: "notion",
      pageId: page.id,
      lastEditedTime: page.last_edited_time,
    },
    ...(Object.keys(extraFields).length > 0 ? { extraFields } : {}),
  };

  return { task, relations, labels };
}

function toRelation(
  propertyName: string,
  sourceKey: string,
  targetKey: string,
): ImportedRelation {
  if (PARENT_NAME.test(propertyName)) {
    // The related page is the parent; the subtask edge points parent → child.
    return { sourceKey: targetKey, targetKey: sourceKey, type: "subtask" };
  }
  if (SUBITEM_NAME.test(propertyName)) {
    return { sourceKey, targetKey, type: "subtask" };
  }
  return { sourceKey, targetKey, type: "related" };
}

function toPerson(
  person: NotionPerson | undefined,
): ImportedPerson | undefined {
  if (!person) return undefined;
  const name = person.name?.trim();
  const email = person.person?.email?.trim();
  if (!name && !email) return undefined;
  return {
    ...(name ? { name } : {}),
    ...(email ? { email } : {}),
  };
}

function scalarOf(
  value: NotionPropertyValue,
): string | number | boolean | null | undefined {
  switch (value.type) {
    case "select":
    case "status":
      return value.select?.name ?? value.status?.name ?? null;
    case "number":
      return value.number ?? null;
    case "checkbox":
      return value.checkbox ?? false;
    case "date":
      return value.date?.start ?? null;
    case "rich_text":
      return plainText(value.rich_text);
    case "url":
      return value.url ?? null;
    case "email":
      return value.email ?? null;
    case "phone_number":
      return value.phone_number ?? null;
    case "unique_id":
      if (!value.unique_id) return null;
      return value.unique_id.prefix
        ? `${value.unique_id.prefix}-${value.unique_id.number}`
        : String(value.unique_id.number);
    case "people":
      // Names only: an address kept as a field would outlive the person (N-002).
      return (value.people ?? [])
        .map((person) => person.name?.trim() ?? "")
        .filter(Boolean)
        .join(", ");
    case "multi_select":
      return (value.multi_select ?? []).map((option) => option.name).join(", ");
    default:
      return undefined;
  }
}

export function mapDatabase(
  database: NotionDatabase,
  pages: NotionPage[],
  bodies: ReadonlyMap<string, string>,
  product: string,
): ImportedProject {
  const { columns, columnKeyByStatus } = mapColumns(database);
  const warnings: string[] = [];
  if (columns.length === 0) {
    warnings.push(
      "No Status property found in this database; every task is imported without a column.",
    );
  }

  const tasks: ImportedTask[] = [];
  const relationsByEdge = new Map<string, ImportedRelation>();
  const labelsByKey = new Map<string, ImportedLabel>();

  for (const page of pages) {
    const mapped = mapPage(page, {
      product,
      columnKeyByStatus,
      description: bodies.get(page.id) ?? "",
    });
    tasks.push(mapped.task);
    for (const relation of mapped.relations) {
      const edge = edgeOf(relation);
      if (!relationsByEdge.has(edge)) relationsByEdge.set(edge, relation);
    }
    for (const label of mapped.labels) {
      if (!labelsByKey.has(label.key)) labelsByKey.set(label.key, label);
    }
  }

  const name = plainText(database.title) || "Notion database";
  const description = plainText(database.description);

  return {
    name,
    ...(description ? { description } : {}),
    columns,
    labels: [...labelsByKey.values()],
    tasks,
    relations: [...relationsByEdge.values()],
    warnings,
  };
}

// Both ends of a Notion relation list each other ("Parent item" on the child,
// "Sub-items" on the parent), so one edge arrives twice; a related pair is
// the same edge in either direction.
function edgeOf(relation: ImportedRelation): string {
  const { sourceKey, targetKey, type } = relation;
  if (type !== "related") return `${type}:${sourceKey}>${targetKey}`;
  const [first, second] = [sourceKey, targetKey].sort();
  return `related:${first}~${second}`;
}
