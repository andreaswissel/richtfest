CREATE TABLE components_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
  key text NOT NULL CHECK (key ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
  current_revision_id uuid, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX components_tenant_key ON components_components (tenant_id, key);
--> statement-breakpoint
CREATE TABLE components_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
  component_id uuid NOT NULL, revision integer NOT NULL CHECK (revision > 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  review_status text NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed','reviewed','rejected')),
  review_version integer NOT NULL DEFAULT 0 CHECK (review_version >= 0),
  review_note text, reviewed_by uuid, reviewed_at timestamptz,
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, component_id, id),
  FOREIGN KEY (tenant_id, component_id) REFERENCES components_components (tenant_id, id)
);
CREATE UNIQUE INDEX components_revision_number ON components_revisions (tenant_id, component_id, revision);
CREATE INDEX components_revision_history ON components_revisions (tenant_id, component_id);
ALTER TABLE components_components ADD CONSTRAINT components_current_revision
  FOREIGN KEY (tenant_id, id, current_revision_id) REFERENCES components_revisions (tenant_id, component_id, id);
--> statement-breakpoint
CREATE FUNCTION components_preserve_revision_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.component_id, NEW.revision, NEW.data, NEW.fingerprint, NEW.created_by, NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id, OLD.tenant_id, OLD.component_id, OLD.revision, OLD.data, OLD.fingerprint, OLD.created_by, OLD.created_at)
  THEN RAISE EXCEPTION 'Component revision content is immutable'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER components_immutable_revision BEFORE UPDATE ON components_revisions
FOR EACH ROW EXECUTE FUNCTION components_preserve_revision_content();
--> statement-breakpoint
INSERT INTO os_permissions (key, description) VALUES
  ('components:read', 'Read tenant component library'),
  ('components:import', 'Import tenant component revisions'),
  ('components:review', 'Review tenant component revisions')
ON CONFLICT (key) DO NOTHING;
INSERT INTO os_role_permissions (role_id, permission)
SELECT existing.role_id, added.key FROM os_role_permissions existing
CROSS JOIN (VALUES ('components:read'), ('components:import'), ('components:review')) added(key)
WHERE existing.permission = 'access:manage'
ON CONFLICT DO NOTHING;
