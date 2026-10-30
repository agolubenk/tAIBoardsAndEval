import { responseTimestamp, z } from "../../openapi";
import { BRANCHES_MAX } from "../tree/get-tree";
import { TREES_MAX } from "../tree/list-trees";
import { workspaceParam } from "./schema";

export const treesQuery = z.object({
  projectId: z.string().optional().openapi({
    description: "Only the trees of this project (a forest).",
  }),
});

export const treeParam = workspaceParam.extend({ rootId: z.string() });

const liveLeaseSchema = z.object({
  holderName: z.string(),
  holderKind: z.string(),
  expiresAt: responseTimestamp,
});

export const treesSchema = z
  .object({
    trees: z.array(
      z.object({
        id: z.string(),
        number: z.number().nullable(),
        title: z.string(),
        status: z.string(),
        isCompleted: z.boolean(),
        priority: z.string().nullable(),
        projectId: z.string(),
        projectName: z.string(),
        projectSlug: z.string(),
        branchCount: z.number().openapi({
          description: "Subtasks under the root, at any depth.",
        }),
        lease: liveLeaseSchema.nullable(),
        sectorIds: z.array(z.string()),
      }),
    ),
    truncated: z.boolean().openapi({
      description: `More than ${TREES_MAX} trees; narrow by project.`,
    }),
  })
  .openapi("ForestTrees");

export const treeBranchesSchema = z
  .object({
    rootId: z.string(),
    branches: z.array(
      z.object({
        id: z.string(),
        parentId: z.string().nullable(),
        depth: z.number(),
        number: z.number().nullable(),
        title: z.string(),
        status: z.string(),
        projectId: z.string(),
      }),
    ),
    truncated: z.boolean().openapi({
      description: `More than ${BRANCHES_MAX} branches.`,
    }),
  })
  .openapi("ForestTreeBranches");

export const leasesSchema = z
  .array(
    z.object({
      taskId: z.string(),
      number: z.number().nullable(),
      title: z.string(),
      projectId: z.string(),
      projectName: z.string(),
      holderName: z.string(),
      holderKind: z.string(),
      groupKey: z.string().nullable(),
      acquiredAt: responseTimestamp,
      expiresAt: responseTimestamp,
    }),
  )
  .openapi("ForestLiveLeases");

const countSchema = z.object({ total: z.number(), done: z.number() });

export const cardPlaceSchema = z
  .object({
    rootId: z.string().nullable().openapi({
      description:
        "The root of the card's tree, the card itself when it has no parent; null when the root is in a project the caller cannot see.",
    }),
    ancestors: z
      .array(
        z.object({
          id: z.string(),
          number: z.number().nullable(),
          title: z.string(),
          projectId: z.string(),
          projectSlug: z.string(),
        }),
      )
      .openapi({ description: "Parents from the root down, visible ones." }),
    hiddenAncestors: z.number(),
    subcards: countSchema.openapi({
      description:
        "Subcards under this card at any depth, and how many are done.",
    }),
    tree: countSchema.openapi({
      description: "The same for the whole tree under the root.",
    }),
    sectors: z.array(z.object({ id: z.string(), name: z.string() })),
  })
  .openapi("ForestCardPlace");
