ALTER TABLE os_invitations ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE os_auth_dev_outbox ADD COLUMN IF NOT EXISTS tenant_id uuid;
