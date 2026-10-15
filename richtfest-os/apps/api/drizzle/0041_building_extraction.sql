CREATE TABLE projects_building_extractions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
 model_id uuid NOT NULL REFERENCES projects_building_models(id) ON DELETE CASCADE,
 source_version_id uuid NOT NULL REFERENCES projects_file_versions(id),
 storey_id uuid NOT NULL REFERENCES projects_building_storeys(id), page integer NOT NULL CHECK (page > 0),
 extractor_version text NOT NULL DEFAULT 'labels-v1', status text NOT NULL DEFAULT 'queued', attempts integer NOT NULL DEFAULT 0,
 lease_token uuid, lease_until timestamptz, result jsonb, created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX projects_building_extractions_identity ON projects_building_extractions(model_id, source_version_id, storey_id, page, extractor_version);
CREATE TABLE projects_building_extraction_candidates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL,
 model_id uuid NOT NULL REFERENCES projects_building_models(id) ON DELETE CASCADE,
 job_id uuid NOT NULL REFERENCES projects_building_extractions(id) ON DELETE CASCADE,
 source_key text NOT NULL, entity_type text NOT NULL, name text NOT NULL, geometry jsonb NOT NULL, evidence jsonb NOT NULL,
 status text NOT NULL DEFAULT 'unreviewed', target_entity_id uuid, reviewed_by uuid, reviewed_at timestamptz
);
CREATE UNIQUE INDEX projects_building_extraction_candidates_identity ON projects_building_extraction_candidates(job_id, source_key);
