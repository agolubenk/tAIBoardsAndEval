import type db from "../database";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
