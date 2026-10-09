ALTER TABLE knowledge_messages ADD COLUMN actor_kind text NOT NULL DEFAULT 'user', ADD COLUMN parent_message_id uuid, ADD COLUMN source_version_ids jsonb NOT NULL DEFAULT '[]', ADD COLUMN annotation_id uuid, ADD COLUMN run_id uuid;
CREATE INDEX knowledge_messages_conversation_cursor ON knowledge_messages (tenant_id, conversation_id, created_at, id);
CREATE INDEX knowledge_conversations_project ON knowledge_conversations (tenant_id, project_id);
CREATE TABLE knowledge_conversation_reads (tenant_id uuid NOT NULL, conversation_id uuid NOT NULL, user_id uuid NOT NULL, composer_draft text NOT NULL DEFAULT '', last_read_message_id uuid, meaningful_message_id uuid, read_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id, conversation_id, user_id));
CREATE TABLE knowledge_artifacts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, project_id uuid NOT NULL, title text NOT NULL, type text NOT NULL, status text NOT NULL DEFAULT 'draft', created_by uuid NOT NULL, run_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX knowledge_artifacts_project ON knowledge_artifacts(tenant_id, project_id);
CREATE TABLE knowledge_artifact_revisions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, artifact_id uuid NOT NULL, version integer NOT NULL, title text NOT NULL, content text NOT NULL, payload jsonb, source_version_ids jsonb NOT NULL DEFAULT '[]', created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id, artifact_id, version));
CREATE TABLE knowledge_annotations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, project_id uuid NOT NULL, artifact_revision_id uuid, source_version_id uuid, page integer, selection jsonb, quote text, body text NOT NULL, message_id uuid, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), CHECK ((artifact_revision_id IS NOT NULL)::integer + (source_version_id IS NOT NULL)::integer = 1));
CREATE INDEX knowledge_annotations_project ON knowledge_annotations(tenant_id, project_id);

ALTER TABLE knowledge_agent_runs ADD COLUMN retry_of_run_id uuid;
ALTER TABLE knowledge_agent_runs ADD COLUMN message_id uuid, ADD COLUMN intent text NOT NULL DEFAULT 'assist';
ALTER TABLE knowledge_agent_runs ADD COLUMN partial_output text NOT NULL DEFAULT '';
ALTER TABLE knowledge_messages ADD COLUMN openui text;
ALTER TABLE knowledge_agent_runs ADD COLUMN parent_run_id uuid, ADD COLUMN specialist_role text;
