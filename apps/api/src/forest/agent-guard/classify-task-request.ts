// What an agent's request to /api/task/* asks for. The route table mirrors
// task/index.ts; an unknown write is refused (fail closed), so a new upstream
// route has to be classified here before agents can use it.

export type TaskChanges = {
  title?: string;
  description?: string | null;
  status?: string;
  priority?: string;
  projectId?: string;
};

export type TaskRequest =
  | { kind: "pass" }
  | { kind: "forbidden"; action: string; targetId: string; reason: string }
  | { kind: "create"; projectId: string; status?: string }
  | { kind: "edit"; action: string; taskId: string; changes: TaskChanges };

type Body = Record<string, unknown>;

const FIELD_ROUTES: Record<string, (body: Body) => TaskChanges> = {
  status: (body) => ({ status: text(body.status) }),
  priority: (body) => ({ priority: text(body.priority) }),
  title: (body) => ({ title: text(body.title) }),
  description: (body) => ({ description: nullableText(body.description) }),
  move: (body) => ({
    projectId: text(body.destinationProjectId),
    status: text(body.destinationStatus),
  }),
  assignee: () => ({}),
  "due-date": () => ({}),
  "image-upload": () => ({}),
};

function text(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function nullableText(value: unknown) {
  return value === null ? null : text(value);
}

function forbidden(action: string, targetId: string, reason: string) {
  return { kind: "forbidden" as const, action, targetId, reason };
}

// `segments` is the path after /task, already split on "/".
export function classifyTaskRequest(
  method: string,
  segments: readonly string[],
  body: Body,
): TaskRequest {
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD" || verb === "OPTIONS") {
    return { kind: "pass" };
  }
  const [first = "", second, third] = segments;

  if (verb === "DELETE" && segments.length === 1) {
    return forbidden(
      "task.delete",
      first,
      "agents do not delete cards (N-004); ask the owner",
    );
  }
  if (verb === "PATCH" && first === "bulk" && segments.length === 1) {
    return forbidden(
      "task.bulk",
      "bulk",
      "agents edit one card at a time under its lease",
    );
  }
  if (verb === "POST") {
    if (first === "reorder" && segments.length === 1) {
      return forbidden(
        "task.reorder",
        "reorder",
        "agents move cards one at a time under their leases",
      );
    }
    if (first === "import" && second && segments.length === 2) {
      return forbidden(
        "task.import",
        second,
        "agents create cards one at a time",
      );
    }
    // Drafts hold uploads for a card that does not exist yet; duplicating
    // copies a card without changing it.
    if (first === "draft-upload" || (first === "duplicate" && second)) {
      return { kind: "pass" };
    }
    if (first === "image-upload" && second && third === "finalize") {
      return {
        kind: "edit",
        action: "task.image-upload",
        taskId: second,
        changes: {},
      };
    }
    if (segments.length === 1 && first) {
      return { kind: "create", projectId: first, status: text(body.status) };
    }
  }
  if (verb === "PUT") {
    if (segments.length === 1 && first) {
      return {
        kind: "edit",
        action: "task.update",
        taskId: first,
        changes: {
          title: text(body.title),
          description: nullableText(body.description),
          status: text(body.status),
          priority: text(body.priority),
          projectId: text(body.projectId),
        },
      };
    }
    const route = FIELD_ROUTES[first];
    if (route && second && segments.length === 2) {
      return {
        kind: "edit",
        action: `task.${first}`,
        taskId: second,
        changes: route(body),
      };
    }
  }
  return forbidden(
    `task.${verb.toLowerCase()}`,
    segments.join("/"),
    "this task route is not open to agents",
  );
}

// Which requests carry a JSON body the classifier reads.
export function readsBody(method: string, segments: readonly string[]) {
  const verb = method.toUpperCase();
  const [first = ""] = segments;
  if (verb === "PUT") return first !== "image-upload";
  return verb === "POST" && segments.length === 1 && first !== "reorder";
}
