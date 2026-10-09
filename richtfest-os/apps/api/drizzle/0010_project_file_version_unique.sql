CREATE UNIQUE INDEX IF NOT EXISTS projects_file_versions_file_version_unique
  ON projects_file_versions (tenant_id, file_id, version);
