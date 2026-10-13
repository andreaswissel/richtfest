ALTER TABLE knowledge_searches ADD COLUMN parent_search_id uuid REFERENCES knowledge_searches(id);
--> statement-breakpoint
CREATE INDEX knowledge_searches_parent ON knowledge_searches(parent_search_id);
--> statement-breakpoint
ALTER TABLE knowledge_drafts ADD COLUMN display_title text, ADD COLUMN source_label text, ADD COLUMN chapter text;
