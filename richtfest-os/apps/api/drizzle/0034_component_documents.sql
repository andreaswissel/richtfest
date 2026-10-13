CREATE TABLE components_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  component_id uuid NOT NULL,
  sha256 text NOT NULL,
  pages integer NOT NULL CHECK (pages > 0),
  size_bytes text NOT NULL,
  storage_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX components_document_hash ON components_documents (tenant_id, component_id, sha256);
