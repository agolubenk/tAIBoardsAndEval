import { and, asc, eq, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import db from "../../database";
import {
  type NotebookCitation,
  type NotebookMessageStatus,
  notebookMessageTable,
  notebookThreadTable,
} from "../../database/notebook-schema";
import { chatCompletion, LlmError } from "../llm/chat-completion";
import {
  effectiveNotebookModel,
  type NotebookModel,
} from "../../notebook-model/effective-notebook-model";
import { type NotebookHit, searchNotebook } from "../search/search-notebook";
import { buildPrompt, HISTORY_MESSAGES } from "./build-prompt";
import { releaseCall, reserveCall } from "./call-budget";

export const ANSWER_SOURCES = 6;
// R-053: a rate-limited call waits for the window instead of moving to
// another provider; past this the reader gets the sources without waiting.
export const RATE_LIMIT_WAIT_MAX_MS = 20_000;

const titleOf = (question: string) =>
  question.length > 120 ? `${question.slice(0, 119)}…` : question;

export async function findThread(workspaceId: string, threadId: string) {
  const [thread] = await db
    .select()
    .from(notebookThreadTable)
    .where(
      and(
        eq(notebookThreadTable.id, threadId),
        eq(notebookThreadTable.workspaceId, workspaceId),
      ),
    );
  if (!thread) {
    throw new HTTPException(404, { message: "Notebook thread not found" });
  }
  return thread;
}

async function threadHistory(threadId: string) {
  const rows = await db
    .select({
      role: notebookMessageTable.role,
      content: notebookMessageTable.content,
      status: notebookMessageTable.status,
    })
    .from(notebookMessageTable)
    .where(eq(notebookMessageTable.threadId, threadId))
    .orderBy(asc(notebookMessageTable.createdAt))
    .limit(200);
  // Only real exchanges: a turn without a written answer adds nothing.
  return rows
    .filter((row) => row.role === "user" || row.status === "answered")
    .slice(-HISTORY_MESSAGES)
    .map(({ role, content }) => ({ role, content }));
}

type Outcome = {
  status: NotebookMessageStatus;
  content: string;
  model: string | null;
};

async function writeAnswer(
  settings: NotebookModel,
  question: string,
  hits: NotebookHit[],
  history: { role: "user" | "assistant"; content: string }[],
): Promise<Outcome> {
  const { key, model } = settings;
  if (!model || !key || !hits.length) {
    return { status: "retrieval-only", content: "", model: null };
  }
  const config = {
    baseUrl: settings.baseUrl,
    model,
    dailyMax: settings.dailyMax,
    ...(settings.thinking ? { thinking: settings.thinking } : {}),
  };
  const messages = buildPrompt(question, hits, history);
  // Holds a place under the daily cap; askNotebook releases it once the
  // answer is stored. Nothing below throws, so every place is released.
  if (!(await reserveCall(config.dailyMax))) {
    return { status: "capped", content: "", model: null };
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const content = await chatCompletion(config, key, messages);
      return { status: "answered", content, model: config.model };
    } catch (error) {
      const wait = error instanceof LlmError ? error.retryAfterMs : undefined;
      if (
        error instanceof LlmError &&
        error.reason === "rate-limited" &&
        attempt === 0 &&
        wait !== undefined &&
        wait <= RATE_LIMIT_WAIT_MAX_MS
      ) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      const limited =
        error instanceof LlmError && error.reason === "rate-limited";
      return {
        status: limited ? "rate-limited" : "failed",
        content: "",
        model: config.model,
      };
    }
  }
}

export async function askNotebook(input: {
  workspaceId: string;
  threadId?: string;
  question: string;
  userId: string | null;
}) {
  const thread = input.threadId
    ? await findThread(input.workspaceId, input.threadId)
    : (
        await db
          .insert(notebookThreadTable)
          .values({
            workspaceId: input.workspaceId,
            title: titleOf(input.question),
            createdBy: input.userId,
          })
          .returning()
      )[0];
  if (!thread) throw new Error("notebook thread insert returned no row");

  const history = await threadHistory(thread.id);
  const [asked] = await db
    .insert(notebookMessageTable)
    .values({
      threadId: thread.id,
      workspaceId: input.workspaceId,
      role: "user",
      content: input.question,
      createdBy: input.userId,
    })
    .returning();

  const settings = await effectiveNotebookModel();
  const { results: hits } = await searchNotebook({
    workspaceId: input.workspaceId,
    query: input.question,
    limit: ANSWER_SOURCES,
    mode: "hybrid",
    embedModel: settings.embedModel,
  });
  const citations: NotebookCitation[] = hits.map((hit, i) => ({
    n: i + 1,
    chunkId: hit.chunkId,
    kind: hit.source.kind,
    ref: hit.source.ref,
    title: hit.source.title,
    heading: hit.heading,
  }));
  const outcome = await writeAnswer(settings, input.question, hits, history);
  // Only a model call carries a model, and only a model call holds a place.
  const [answer] = await db
    .insert(notebookMessageTable)
    .values({
      threadId: thread.id,
      workspaceId: input.workspaceId,
      role: "assistant",
      citations,
      ...outcome,
    })
    .returning()
    .finally(() => (outcome.model ? releaseCall() : undefined));
  const [touched] = await db
    .update(notebookThreadTable)
    .set({ updatedAt: sql`(now() AT TIME ZONE 'utc')` })
    .where(eq(notebookThreadTable.id, thread.id))
    .returning();
  if (!asked || !answer) throw new Error("notebook message insert failed");
  return { thread: touched ?? thread, messages: [asked, answer] };
}
