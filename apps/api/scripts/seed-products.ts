// t-boards: creates the products (workspaces), their projects and starting
// cards from the plan on stdin (deploy/vps/seed/products.json), owned by the
// local admin. Re-running adds only what is missing. Local instances only.
import { readFileSync } from "node:fs";
import { getDatabasePool } from "../src/database";
import { productsPlanSchema, seedProducts } from "../src/seed/seed-products";
import { isCloud } from "../src/utils/is-cloud";
import { LOCAL_ADMIN_EMAIL } from "./local-admin";

if (isCloud()) {
  throw new Error("seed-products is for local instances only");
}

const plan = productsPlanSchema.parse(JSON.parse(readFileSync(0, "utf8")));
const report = await seedProducts(plan, LOCAL_ADMIN_EMAIL);
console.log(
  `products: +${report.workspaces.created.length} (${report.workspaces.existing.length} kept), projects: +${report.projects.created.length}, cards: +${report.cards.created} (${report.cards.existing} kept, ${report.agentFields.filled} got agent fields), links: +${report.links.created} (${report.links.existing} kept), sectors: ${report.sectors}`,
);
for (const skipped of report.links.skipped)
  console.warn(`link skipped: ${skipped}`);

await getDatabasePool().end();
