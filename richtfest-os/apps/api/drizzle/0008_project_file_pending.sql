ALTER TABLE projects_file_versions ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ready';
