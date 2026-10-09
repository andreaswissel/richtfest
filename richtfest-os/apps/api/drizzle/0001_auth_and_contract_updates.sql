ALTER TABLE knowledge_tasks ADD COLUMN IF NOT EXISTS project_id uuid;
ALTER TABLE knowledge_tasks ADD COLUMN IF NOT EXISTS assignee_type text NOT NULL DEFAULT 'user';
ALTER TABLE projects_file_versions ADD COLUMN IF NOT EXISTS storage_key text;
ALTER TABLE projects_file_versions ADD COLUMN IF NOT EXISTS size_bytes integer;
ALTER TABLE projects_file_versions ADD COLUMN IF NOT EXISTS mime_type text;
CREATE TABLE IF NOT EXISTS os_ai_connections (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, user_id uuid, provider text NOT NULL CHECK (provider IN ('openai', 'anthropic')), ciphertext text NOT NULL, iv text NOT NULL, auth_tag text NOT NULL, created_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'os_invitations' AND column_name = 'token') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'os_invitations' AND column_name = 'token_hash') THEN
    ALTER TABLE os_invitations RENAME COLUMN token TO token_hash;
  END IF;
END $$;
