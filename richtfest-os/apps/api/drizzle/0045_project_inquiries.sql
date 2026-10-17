ALTER TABLE projects_files ADD COLUMN IF NOT EXISTS document_type text;
--> statement-breakpoint
ALTER TABLE projects_files ADD COLUMN IF NOT EXISTS document_type_reviewed_by uuid;
--> statement-breakpoint
ALTER TABLE projects_files ADD COLUMN IF NOT EXISTS document_type_reviewed_at timestamp with time zone;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS projects_inquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES projects_projects(id) ON DELETE CASCADE,
  kind text NOT NULL CONSTRAINT projects_inquiries_kind_check CHECK (kind in ('component_data','general')),
  title text NOT NULL,
  counterpart text NOT NULL,
  status text NOT NULL DEFAULT 'open' CONSTRAINT projects_inquiries_status_check CHECK (status in ('open','waiting','answered','closed')),
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  closed_at timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS projects_inquiries_project ON projects_inquiries (tenant_id, project_id, updated_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS projects_inquiry_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  inquiry_id uuid NOT NULL REFERENCES projects_inquiries(id) ON DELETE CASCADE,
  kind text NOT NULL CONSTRAINT projects_inquiry_entries_kind_check CHECK (kind in ('request','email','call','note','document')),
  direction text NOT NULL CONSTRAINT projects_inquiry_entries_direction_check CHECK (direction in ('outgoing','incoming','internal')),
  subject text,
  body text,
  file_id uuid REFERENCES projects_files(id) ON DELETE SET NULL,
  occurred_at timestamp with time zone NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS projects_inquiry_entries_inquiry ON projects_inquiry_entries (inquiry_id, occurred_at);
