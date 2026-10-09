ALTER TABLE os_audit_events ADD COLUMN IF NOT EXISTS actor_type text NOT NULL DEFAULT 'user';
ALTER TABLE os_audit_events ADD COLUMN IF NOT EXISTS correlation_id uuid;
ALTER TABLE os_audit_events ADD COLUMN IF NOT EXISTS run_id uuid;
