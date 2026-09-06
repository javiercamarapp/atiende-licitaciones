-- 0065_r6_step_up_purposes_contract_inconformidad.sql
-- Ronda 6 (E11, apps/api, REQ-051/REQ-053): dos acciones nuevas con
-- impacto económico/legal directo exigen step-up (2FA reciente, mismo
-- patrón que `expediente.approval`, ver lib/step-up.ts):
--   - `expediente.contract_transition`: transiciones del ciclo de vida del
--     contrato con impacto económico/legal (rescindir, penalizar, marcar
--     en inconformidad, o registrar una modificación) -- ver
--     `modules/expediente/contract-lifecycle.routes.ts`.
--   - `expediente.inconformidad_review`: marcar un borrador de
--     inconformidad como "revisado por abogado" -- ver
--     `modules/expediente/inconformidad.routes.ts`. El borrador en sí NUNCA
--     se envía a ninguna autoridad (ver README); este step-up solo protege
--     el cambio de estado interno "revisado", que habilita que el usuario
--     humano proceda a presentarlo por su cuenta.
-- Mismo patrón que 0063: el CHECK a nivel de esquema debe mantenerse
-- sincronizado a mano con `STEP_UP_PURPOSES` (lib/step-up.ts) -- un cambio
-- en una sin la otra se detecta de inmediato porque `apps/api` fallaría al
-- insertar un `purpose` que el propio `apps/api` considera válido.
alter table step_up_sessions drop constraint if exists chk_step_up_sessions_purpose;
alter table step_up_sessions
  add constraint chk_step_up_sessions_purpose
  check (purpose in (
    'company.rate_approval',
    'expediente.approval',
    'tool_call.approval',
    'admin.action',
    'expediente.contract_transition',
    'expediente.inconformidad_review'
  ));
