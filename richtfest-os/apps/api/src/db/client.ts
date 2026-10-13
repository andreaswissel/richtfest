import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as os from "./schema";
import * as crm from "@richtfest/crm/schema";
import * as projects from "@richtfest/projects/schema";
import * as knowledge from "@richtfest/knowledge/schema";
import * as support from "@richtfest/support/schema";
import * as publicData from "@richtfest/public-data/schema";
import { components as componentRecords, revisions as componentRevisions, documents as componentDocuments } from "@richtfest/components/schema";
import * as auth from "./auth-schema";

export const schema = { ...os, ...crm, ...projects, ...knowledge, ...support, ...publicData, ...auth, componentRecords, componentRevisions, componentDocuments };
export const createDatabase = (url: string) => {
  const pool = new Pool({ connectionString: url });
  return { db: drizzle(pool, { schema }), pool };
};
export type Database = ReturnType<typeof createDatabase>["db"];
