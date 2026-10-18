CREATE TABLE projects_location_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  request_hash text NOT NULL,
  source_url text NOT NULL,
  attribution text NOT NULL,
  mime_type text NOT NULL,
  storage_key text,
  checksum text,
  size_bytes integer,
  fetched_at timestamp with time zone,
  fresh_until timestamp with time zone,
  failures integer NOT NULL DEFAULT 0,
  retry_at timestamp with time zone,
  lease_token uuid,
  lease_until timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX projects_location_images_request ON projects_location_images (tenant_id, request_hash);
