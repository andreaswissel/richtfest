-- Expand the supported profile keys without rewriting existing guidance or snapshots.
ALTER TABLE "knowledge_agent_profiles"
  DROP CONSTRAINT "knowledge_agent_profiles_key_check",
  ADD CONSTRAINT "knowledge_agent_profiles_key_check" CHECK ("key" IN (
    'supervisor', 'source_reviewer', 'requirements_reviewer', 'independent_reviewer',
    'sound_insulation', 'construction_law', 'cost_optimizer'
  ));
