import { nullableResponseTimestamp, responseTimestamp, z } from "../../openapi";

const sideSchema = z.object({
  source: z.number().int(),
  imported: z.number().int(),
});

const discrepancySchema = z.object({
  pageId: z.string(),
  title: z.string(),
  kind: z.enum([
    "missing-in-import",
    "missing-in-source",
    "status-mismatch",
    "archive-mismatch",
  ]),
  detail: z.string(),
});

const databaseReportSchema = z.object({
  databaseId: z.string(),
  name: z.string(),
  read: z
    .object({
      pages: z.number().int(),
      fresh: z.number().int(),
      changed: z.number().int(),
    })
    .openapi({
      description:
        "Pages Notion returned; of them, pages without a card and pages Notion edited since the last run.",
    }),
  totals: sideSchema.nullable(),
  byStatus: z.record(z.string(), sideSchema),
  byType: z.record(z.string(), sideSchema),
  discrepancyCount: z.number().int(),
  discrepancies: z.array(discrepancySchema).openapi({
    description: "The first 200 discrepancies; discrepancyCount has them all.",
  }),
  error: z.string().nullable(),
});

const runStatusSchema = z.enum(["running", "clean", "discrepancies", "failed"]);

const runSummarySchema = z.object({
  id: z.string(),
  trigger: z.enum(["schedule", "manual"]),
  status: runStatusSchema,
  discrepancyCount: z.number().int(),
  startedAt: responseTimestamp,
  finishedAt: nullableResponseTimestamp,
});

export const mirrorRunsSchema = z
  .object({
    configured: z.boolean().openapi({
      description:
        "true when this workspace is the one the scheduled mirror writes to.",
    }),
    cron: z.string().nullable(),
    maxGapHours: z.number(),
    streak: z
      .object({
        runs: z.number().int(),
        since: nullableResponseTimestamp,
        hours: z.number(),
        brokenBy: z.enum(["discrepancies", "failed", "gap"]).nullable(),
      })
      .openapi({
        description:
          "Clean runs in a row, newest first, with no gap longer than maxGapHours (AC-003).",
      }),
    runs: z.array(runSummarySchema),
    latest: z
      .object({
        id: z.string(),
        report: z.object({ databases: z.array(databaseReportSchema) }),
      })
      .nullable()
      .openapi({ description: "The newest finished run's full report." }),
  })
  .openapi("ForestMirrorRuns");

export const mirrorRunStartedSchema = z
  .object({ runId: z.string() })
  .openapi("ForestMirrorRunStarted");
