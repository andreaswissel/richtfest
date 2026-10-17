CREATE TABLE IF NOT EXISTS projects_building_data_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  model_id uuid NOT NULL REFERENCES projects_building_models(id) ON DELETE CASCADE,
  recipient text NOT NULL,
  note text,
  items jsonb NOT NULL,
  sent_at timestamp with time zone NOT NULL DEFAULT now(),
  closed_at timestamp with time zone,
  created_by uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS projects_building_data_requests_model ON projects_building_data_requests (model_id, sent_at);
