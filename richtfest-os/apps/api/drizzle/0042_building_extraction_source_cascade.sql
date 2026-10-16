ALTER TABLE projects_building_extractions DROP CONSTRAINT IF EXISTS projects_building_extractions_source_version_id_fkey;
--> statement-breakpoint
ALTER TABLE projects_building_extractions ADD CONSTRAINT projects_building_extractions_source_version_id_fkey
 FOREIGN KEY (source_version_id) REFERENCES projects_file_versions(id) ON DELETE CASCADE;
