ALTER TABLE "projects_projects" ADD COLUMN "street" text;
--> statement-breakpoint
ALTER TABLE "projects_projects" ADD COLUMN "postal_code" text;
--> statement-breakpoint
ALTER TABLE "projects_projects" ADD COLUMN "city" text;
--> statement-breakpoint
ALTER TABLE "projects_projects" ADD COLUMN "country" text;
--> statement-breakpoint
ALTER TABLE "projects_locations" ADD COLUMN "requested_address" jsonb;
