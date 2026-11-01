import { createHash } from "node:crypto";

// R-010: who an agent is — the session label it sends and the harness it runs
// in. The label pattern is the forest's x-t-boards-session one plus "@" and "+".
const LABEL_PATTERN = /^[\p{L}\p{N} ._:/#@+-]{1,80}$/u;
const HARNESS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/;

// A harness that names no session still works under its own name, never the
// owner's: the harness title alone.
export const DEFAULT_SESSION = "default";

const HARNESS_TITLES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  continue: "Continue",
  copilot: "Copilot",
  cursor: "Cursor",
  kimi: "Kimi",
  roo: "Roo",
};

export function normalizeSession(raw: string | null | undefined) {
  const label = raw?.trim().replace(/\s+/g, " ");
  if (!label) return DEFAULT_SESSION;
  return LABEL_PATTERN.test(label) ? label : null;
}

export function normalizeHarness(raw: string | null | undefined) {
  const harness = raw?.trim().toLowerCase();
  return harness && HARNESS_PATTERN.test(harness) ? harness : null;
}

export function agentDisplayName(session: string, harness: string) {
  const title =
    (Object.hasOwn(HARNESS_TITLES, harness) && HARNESS_TITLES[harness]) ||
    harness;
  return session === DEFAULT_SESSION ? title : `${session} · ${title}`;
}

// Reserved for agents: people cannot sign up with or move to it.
export const AGENT_EMAIL_DOMAIN = "agents.t-boards.invalid";

export function isAgentEmail(email: string | null | undefined) {
  return (
    typeof email === "string" &&
    email.trim().toLowerCase().endsWith(`@${AGENT_EMAIL_DOMAIN}`)
  );
}

// The address is the identity key: one agent per owner, harness and session,
// whatever the case of the label. The .invalid domain never receives mail.
export function agentEmail(ownerId: string, harness: string, session: string) {
  const digest = createHash("sha256")
    .update(`${ownerId}\n${harness}\n${session.toLowerCase()}`)
    .digest("hex")
    .slice(0, 24);
  return `agent-${digest}@${AGENT_EMAIL_DOMAIN}`;
}
