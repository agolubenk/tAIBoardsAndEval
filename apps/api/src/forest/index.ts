import { apiRouter, type BaseVariables } from "../openapi";
import { approvalRoutes } from "./routes/approval-routes";
import { cardRoutes } from "./routes/card-routes";
import { contextRoutes } from "./routes/context-routes";
import { fellRoutes } from "./routes/fell-routes";
import { historyRoutes } from "./routes/history-routes";
import { leaseRoutes } from "./routes/lease-routes";
import { memoryRoutes } from "./routes/memory-routes";
import { mirrorRoutes } from "./routes/mirror-routes";
import { readRoutes } from "./routes/read-routes";
import { treeRoutes } from "./routes/tree-routes";

// t-boards forest model (spec R-026…R-029, N-011): leases, the owner's «да»,
// felling into logs and seeds, sectors, growing from seeds, and the card
// fields Notion keeps (R-024), the card history with rollback (R-023), and
// the context pack an agent reads to pick up a card (R-031), and the reads
// the forest page shows: trees with their branches, live leases.
const forest = apiRouter<BaseVariables & { workspaceId: string }>()
  .route("/", leaseRoutes)
  .route("/", approvalRoutes)
  .route("/", fellRoutes)
  .route("/", readRoutes)
  .route("/", cardRoutes)
  .route("/", historyRoutes)
  .route("/", contextRoutes)
  .route("/", memoryRoutes)
  .route("/", mirrorRoutes)
  .route("/", treeRoutes);

export default forest;
