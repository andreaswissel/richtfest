CREATE TABLE IF NOT EXISTS projects_inbound_mailboxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL UNIQUE REFERENCES projects_projects(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS projects_inbound_emails (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES projects_projects(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_email_id text NOT NULL,
  message_id text,
  recipient text NOT NULL,
  from_address text,
  from_name text,
  direction text NOT NULL DEFAULT 'incoming' CONSTRAINT projects_inbound_emails_direction_check CHECK (direction in ('incoming','outgoing')),
  subject text,
  body text,
  received_at timestamp with time zone NOT NULL,
  file_id uuid REFERENCES projects_files(id) ON DELETE SET NULL,
  attachment_file_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL CONSTRAINT projects_inbound_emails_status_check CHECK (status in ('filed','unfiled','dismissed')),
  inquiry_id uuid REFERENCES projects_inquiries(id) ON DELETE SET NULL,
  handled_by uuid,
  handled_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT projects_inbound_emails_provider_unique UNIQUE (provider, provider_email_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS projects_inbound_emails_project ON projects_inbound_emails (tenant_id, project_id, status, received_at);
--> statement-breakpoint
ALTER TABLE projects_inquiry_entries ADD COLUMN IF NOT EXISTS inbound_email_id uuid REFERENCES projects_inbound_emails(id) ON DELETE SET NULL;
