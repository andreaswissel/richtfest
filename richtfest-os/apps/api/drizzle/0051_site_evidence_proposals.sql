CREATE TABLE feasibility_site_evidence_proposals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, project_id uuid NOT NULL,
 version_id uuid NOT NULL, provider text NOT NULL, model text, status text NOT NULL,
 request jsonb NOT NULL, payload jsonb, dispositions jsonb NOT NULL DEFAULT '{}'::jsonb,
 error text, created_by uuid NOT NULL, created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX feasibility_site_evidence_proposals_project ON feasibility_site_evidence_proposals(tenant_id, project_id);
