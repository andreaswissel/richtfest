import { pgTable, uuid, integer, text, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";
import type { FeasibilityScenario, FeasibilityStudyInput } from "@richtfest/shared";

/** One feasibility study per project: the current inputs of its three scenarios. Project and user ids are plain uuids. */
export const feasibilityStudies = pgTable("feasibility_studies", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  projectId: uuid("project_id").notNull(),
  revision: integer("revision").notNull().default(1),
  site: jsonb("site").$type<FeasibilityStudyInput["site"]>().notNull(),
  scenarios: jsonb("scenarios").$type<FeasibilityScenario[]>().notNull(),
  notes: text("notes").notNull().default(""),
  createdBy: uuid("created_by").notNull(),
  updatedBy: uuid("updated_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ project: uniqueIndex("feasibility_studies_project_unique").on(table.tenantId, table.projectId) }));

/** Immutable snapshot of every saved revision, so a report can always be traced to its exact inputs. */
export const feasibilityStudyRevisions = pgTable("feasibility_study_revisions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id").notNull(),
  studyId: uuid("study_id").notNull().references(() => feasibilityStudies.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull(),
  method: text("method").notNull(),
  site: jsonb("site").$type<FeasibilityStudyInput["site"]>().notNull(),
  scenarios: jsonb("scenarios").$type<FeasibilityScenario[]>().notNull(),
  notes: text("notes").notNull().default(""),
  createdBy: uuid("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => ({ revision: uniqueIndex("feasibility_study_revisions_unique").on(table.studyId, table.revision), tenant: index("feasibility_study_revisions_tenant").on(table.tenantId, table.studyId) }));
