-- 0024_go_no_go_reviewer.sql
-- Ronda 2 (E5, matching y Go/No-Go): la ronda 1 restringió la escritura de
-- `go_no_go_decisions` a `decision_roles` ({owner,admin,analyst}, ver
-- 0008_rls_policies.sql). El encargo de ronda 2 pide explícitamente que
-- también `reviewer` pueda decidir go/no-go (rol "≥ reviewer/admin"),
-- mientras que `writer` sigue SIN poder decidir. Se amplía únicamente la
-- política de INSERT/UPDATE de esta tabla (no se toca `approved_rates` ni
-- ninguna otra tabla que use `decision_roles`).
drop policy if exists ins_go_no_go_decisions on go_no_go_decisions;
create policy ins_go_no_go_decisions on go_no_go_decisions
  for insert with check (
    app.is_superadmin()
    or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,analyst,reviewer}'::org_role[]))
  );

drop policy if exists upd_go_no_go_decisions on go_no_go_decisions;
create policy upd_go_no_go_decisions on go_no_go_decisions
  for update using (
    app.is_superadmin()
    or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,analyst,reviewer}'::org_role[]))
  )
  with check (
    app.is_superadmin()
    or (org_id = app.current_org_id() and app.has_role(org_id, '{owner,admin,analyst,reviewer}'::org_role[]))
  );
