import { apiRouter, type BaseVariables } from "../openapi";
import { chatRoutes } from "./routes/chat-routes";
import { embedRoutes } from "./routes/embed-routes";
import { searchRoutes } from "./routes/search-routes";
import { sourceRoutes } from "./routes/source-routes";

// t-boards notebook (spec R-050…R-053): sources the Mac sync uploads, the
// embedding worker's long poll, hybrid search over the chunks, and the chat
// that answers from them.
const notebook = apiRouter<BaseVariables & { workspaceId: string }>()
  .route("/", sourceRoutes)
  .route("/", embedRoutes)
  .route("/", searchRoutes)
  .route("/", chatRoutes);

export default notebook;
