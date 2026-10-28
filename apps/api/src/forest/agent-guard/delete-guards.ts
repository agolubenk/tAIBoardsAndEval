import type { Context, Next } from "hono";
import { resolveForestActor } from "../actor";
import { ForestError } from "../forest-error";
import { writeJournal } from "../journal";
import { projectWorkspace } from "./load-task";

// Deleting a project or a workspace deletes every card in it, so N-004
// covers both. Archiving a project stays open to agents.
export async function agentProjectDeleteGuard(c: Context, next: Next) {
  const parts = c.req.path.split("/").filter(Boolean);
  const segments = parts.slice(parts.indexOf("project") + 1);
  const [projectId] = segments;
  if (c.req.method !== "DELETE" || segments.length !== 1 || !projectId) {
    return next();
  }
  const actor = resolveForestActor(c);
  if (actor.kind !== "agent") return next();
  const error = new ForestError(
    "agent_forbidden",
    "agents do not delete projects: it deletes every card in them (N-004)",
  );
  await writeJournal({
    workspaceId: await projectWorkspace(projectId),
    actor,
    action: "project.delete",
    targetType: "project",
    targetId: projectId,
    outcome: "denied",
    detail: error.message,
  });
  throw error;
}

// better-auth answers /auth/* before the API resolves a user, so this one
// refuses by the token alone and cannot journal who asked.
export async function agentWorkspaceDeleteGuard(c: Context, next: Next) {
  if (c.req.header("authorization") || c.req.header("x-api-key")) {
    throw new ForestError(
      "agent_forbidden",
      "agents do not delete workspaces (N-004); the owner does it in the UI",
    );
  }
  return next();
}
