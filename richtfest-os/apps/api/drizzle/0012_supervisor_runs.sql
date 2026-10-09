CREATE TABLE knowledge_supervisor_runs (
  run_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  generation integer NOT NULL DEFAULT 0,
  phase text NOT NULL DEFAULT 'plan',
  revision integer NOT NULL DEFAULT 0,
  assignments jsonb NOT NULL DEFAULT '[]'::jsonb,
  review jsonb,
  history jsonb NOT NULL DEFAULT '[]'::jsonb,
  steering text,
  effort text NOT NULL DEFAULT 'medium',
  model_policy jsonb,
  lease_token uuid,
  lease_until timestamptz
);
CREATE INDEX knowledge_supervisor_lease_idx ON knowledge_supervisor_runs (lease_until);
