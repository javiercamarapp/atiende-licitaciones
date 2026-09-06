-- 0063_r509_step_up_purpose_enum.sql
-- R5-09 (docs/auditoria-2/api-ronda5-reverificacion.md): `purpose` (0061)
-- era un `text` de forma completamente libre -- cualquier string servía
-- para atar una sesión de step-up a una "acción", lo que en la práctica
-- deja la puerta abierta a que un cliente futuro invente propósitos ad hoc
-- que nunca coincidan con los que `apps/api` realmente exige
-- (`company.rate_approval`/`expediente.approval`, ver
-- `lib/step-up.ts#STEP_UP_PURPOSES`), o (peor) que dos features distintas
-- reusen sin querer el mismo string y se autoricen mutuamente sin
-- proponérselo. Defensa en profundidad: un CHECK a nivel de esquema
-- restringe `purpose` a la MISMA lista cerrada que valida `apps/api`
-- (`assertStepUpPurpose`) -- ambas listas deben mantenerse sincronizadas a
-- mano (no hay forma de compartir el enum de TypeScript con SQL en este
-- repo); un cambio en una sin la otra se detecta de inmediato porque
-- `apps/api` fallaría al insertar un `purpose` que el propio `apps/api`
-- considera válido.
alter table step_up_sessions
  add constraint chk_step_up_sessions_purpose
  check (purpose in ('company.rate_approval', 'expediente.approval', 'tool_call.approval', 'admin.action'));
