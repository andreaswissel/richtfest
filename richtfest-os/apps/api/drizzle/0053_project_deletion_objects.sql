CREATE TABLE projects_deleted_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  storage_key text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  retry_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX projects_deleted_objects_pending ON projects_deleted_objects(retry_at);
