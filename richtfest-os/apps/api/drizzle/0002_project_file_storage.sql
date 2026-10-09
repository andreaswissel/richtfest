ALTER TABLE projects_file_versions ADD COLUMN IF NOT EXISTS storage_key text;
ALTER TABLE projects_file_versions ADD COLUMN IF NOT EXISTS size_bytes integer;
ALTER TABLE projects_file_versions ADD COLUMN IF NOT EXISTS mime_type text;
