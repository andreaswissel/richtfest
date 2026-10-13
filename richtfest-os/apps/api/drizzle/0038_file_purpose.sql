-- Preserve existing behavior; classification is explicit and never inferred.
ALTER TABLE "projects_files" ADD COLUMN "purpose" text DEFAULT 'project_evidence' NOT NULL;
--> statement-breakpoint
ALTER TABLE "projects_files" ADD CONSTRAINT "projects_files_purpose_check"
  CHECK ("purpose" IN ('project_evidence', 'reference_report', 'comparison_only'));
