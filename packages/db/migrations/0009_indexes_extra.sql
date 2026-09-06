-- 0009_indexes_extra.sql
-- Índices adicionales de soporte a consultas frecuentes de la API.

create index if not exists ix_invitations_email on invitations (lower(email));
create index if not exists ix_api_keys_prefix on api_keys (key_prefix);
create index if not exists ix_tool_calls_pending on tool_calls (org_id, authorization_status) where authorization_status = 'pending';
create index if not exists ix_go_no_go_decided_by on go_no_go_decisions (decided_by);
create index if not exists ix_proposal_sections_updated_by on proposal_sections (updated_by);
