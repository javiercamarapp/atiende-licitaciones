# Reverificación adversarial — R5-09/R5-10 (`apps/api`/`packages/db`)

Fecha: 2026-09-06. Agente: reverificador adversarial Sonnet, contexto
independiente del proyecto "Atiende Licitaciones". Rol: **SOLO
encuentra/verifica** — ningún código de `apps/api`, `packages/db`,
`apps/web` ni `apps/worker` fue modificado por este agente (dos archivos de
prueba adversarial temporales se escribieron, ejecutaron y **borraron**;
`git status --short` confirmado vacío después).

**Objeto de reverificación**: los commits de reparación `586e3cf` (R5-10:
ip/user-agent en fallos de 2FA) y `a7026ec` (R5-09: `orgId`/`purpose`
obligatorios + sesión de step-up de un solo uso + migraciones 0062/0063),
ambos declarados `COMPLETADO` por el agente #76
(`docs/AGENTES.md`).

**Metodología**: `git worktree add <scratchpad>/reverify-r509 HEAD` (HEAD
real al iniciar: `85779ee`, `main`) + `npm install` real desde la raíz
(workspaces). El repo principal nunca se tocó con `git reset`/`checkout
<commit>`/`stash`/`rebase`/`add -A`. Se reprodujeron de cero
`typecheck`/`lint`/`test` de `apps/api`, `test` de `packages/db`,
`typecheck`/`test` de `apps/worker`. Se leyó el código real de
`lib/step-up.ts`, `modules/twofa/routes.ts`, `modules/twofa/schemas.ts`,
`modules/company/routes.ts`, `modules/expediente/approval.routes.ts`,
`modules/admin/routes.ts`, `modules/agents/routes.ts`, `app.ts`, las
migraciones 0061–0063 y el diff completo de los ~19 archivos de test
adaptados en `a7026ec`. Se escribieron y ejecutaron 2 pruebas adversariales
adicionales (no cubiertas por la suite existente), luego borradas.
Evidencia completa de comandos reales en
`docs/logs/reverify-api-r5-09-10.log`.

---

## Resumen ejecutivo

Ambos commits son ancestros directos y lineales de `HEAD`
(`c13276b → 586e3cf → a7026ec → f74b568 → 85779ee`) y reproducen limpio:
`apps/api` typecheck/lint sin errores, **58 archivos / 230 tests**;
`packages/db` **24 archivos / 161 tests**; `apps/worker` typecheck sin
errores, **11 archivos / 298 tests** — los 3 números de test coinciden
exactamente con lo declarado por el agente #76.

**R5-09 (CERRADO)**: los 8 ataques pedidos por este encargo se ejecutaron
contra el código real (6 vía la suite existente, 2 vía una prueba
adversarial nueva escrita para este encargo) y los 8 se comportan como
debe:

1. Step-up sin `X-Org-Id` → 400 explícito. ✅ (`security-r505-stepup-scope.test.ts:41-54`)
2. Step-up sin `purpose`, o con `purpose` fuera del enum cerrado → 400. ✅ (`security-r505-stepup-scope.test.ts:56-91`)
3. Sesión creada para org A usada con `X-Org-Id` de org B → 403 "OTRA organización". ✅ (`security-r505-stepup-scope.test.ts:123-144`)
4. `purpose: 'expediente.approval'` usado contra `POST /company/rates/:id/approve` (que exige `company.rate_approval`) → 403 "OTRA acción". ✅ (`security-r505-stepup-scope.test.ts:93-107`)
5. Reutilización de un token ya consumido → 403 "un solo uso". ✅ (`security-r505-stepup-scope.test.ts:146-162`)
6. **Dos acciones concurrentes con el MISMO `stepUpToken`** (dos tarifas `draft` distintas, `Promise.all`) → exactamente una consume el token (200), la otra recibe 403 "un solo uso"; `consumed_at` queda no nulo. La suite existente **evita deliberadamente** este escenario (usa dos tokens independientes, ver comentario en `security-wi04-approved-rates-atomic.test.ts:41-44`, para no confundir la atomicidad de `approved_rates` con la de `step_up_sessions`) — se escribió y ejecutó una prueba adversarial nueva (`zz-adversarial-concurrent-token.test.ts`, borrada al terminar) que reproduce exactamente este ataque contra la base real (PGlite): **PASA**. Confirma que el `UPDATE ... WHERE consumed_at IS NULL` cierra la ventana de carrera.
7. Sesión expirada → 403. ✅ (`security-req044-064-step-up-2fa.test.ts:107-118`, "ventana expirada")
8. Migración 0062 sobre datos con sesiones "genéricas" preexistentes (aplica migraciones hasta 0061 inclusive con datos reales — una sesión genérica `org_id`/`purpose` NULL y otra con scope explícito — luego el resto hasta 0063): la genérica se borra, la de scope explícito sobrevive intacta, `org_id`/`purpose` quedan NOT NULL (INSERT sin alguno de los dos falla), `consumed_at` existe y es NULL por defecto. ✅ (`packages/db/test/security-r509-step-up-mandatory-scope.test.ts:22-107`, ejecutada y verde en este agente).

**R5-10 (CERRADO)**: `recordFailure` (única función que audita
`twofa.verification_failed`/`twofa.step_up_denied`, para las 4 razones
posibles: `locked_out`, `no_pending_enrollment`,
`invalid_code_or_replay`, `invalid_or_used_backup_code`) ahora incluye
`ip`/`userAgent` en `after`, con el mismo extractor `auditContext` que
`auth.login_failed`. Verificado con la suite real (`security-r502-r503-...
> R5-10: un fallo de 2FA audita ip/userAgent... con la misma paridad que
auth.login_failed`, PASA) y con una prueba adversarial adicional propia:
un `X-Forwarded-For: 1.2.3.4` falsificado **NO** se refleja en
`audit_log.after.ip` (queda el ip real de la conexión, `127.0.0.1` en la
prueba) — `apps/api/src/app.ts` nunca configura `trustProxy` en
`Fastify({...})`, así que Fastify usa su comportamiento por defecto
(`trustProxy: false`, ignora `X-Forwarded-For` por completo). Ningún
secreto/código TOTP/código de respaldo aparece en ningún `after` de
`modules/twofa/routes.ts` (revisado línea por línea: solo `reason`, `ip`,
`userAgent`, `retryAfterSeconds`, `verified`, `expiresAt`,
`backupCodesIssued` — nunca el código ni el secreto).

**Diff de los ~19 tests adaptados en `a7026ec`**: revisado completo,
archivo por archivo. Todos los cambios son mecánicos y **fortalecen o
preservan** las aserciones originales — nunca las debilitan: (a) declarar
`{orgId, purpose}` donde antes `enrollTwoFactor(app, token)` no llevaba
scope (ahora obligatorio en el helper); (b) pedir un `stepUpToken`
independiente por cada acción distinta que el mismo test autoriza (single-
use), vía `enrollTwoFactorFull`/`stepUpWithBackupCode`, en vez de reusar
uno solo. Ningún `expect(...)` fue eliminado, relajado ni cambiado de
`toBe`/`toEqual` a una forma más laxa. Detalle por archivo abajo.

**Hallazgo nuevo (no bloqueante para cerrar R5-09/R5-10, pero real)**:
`STEP_UP_PURPOSES` declara 4 propósitos (`company.rate_approval`,
`expediente.approval`, `tool_call.approval`, `admin.action`), reforzados
en el `CHECK` de la migración 0063 — pero **solo 2 tienen un consumidor
real** en todo `apps/api`. Los endpoints que aprueban/deniegan
`tool_calls` (tanto `POST /agents/tool-calls/:id/approve|deny`,
org-scoped, `owner`/`admin`, como el cross-org de superadmin `POST
/admin/tool-calls/:id/approve|deny`) **no llaman a `requireStepUp` en
absoluto** — ninguna verificación en dos pasos, pese a que el propio enum
de propósitos reserva `tool_call.approval` exactamente para este caso.
Esto **no es una regresión de `a7026ec`/`586e3cf`** (ninguno de los dos
commits tocó `modules/admin/routes.ts` ni `modules/agents/routes.ts`, y el
hueco ya estaba declarado honestamente por el agente #72 en
`docs/PROGRESO.md`: *"tool_calls sin 2FA"*) — pero sigue **abierto** y
vale la pena declararlo como hallazgo nuevo. Ver `R5-11` abajo.

---

## R5-09 — detalle de verificación

### Ancestría y alcance del commit

```
c13276b (docs: latido del bucle)
  └─ 586e3cf (fix(api): R5-10 audita ip/userAgent en fallos de 2FA)
       └─ a7026ec (fix(api|db): R5-09 orgId/purpose obligatorios...)
            └─ f74b568 (docs: R5-09/10 corregidos)
                 └─ 85779ee (docs: despacho reverificación R5-09/10) = HEAD
```

`git show --stat a7026ec`: 28 archivos, +1039/-229 — `lib/step-up.ts`,
`modules/twofa/{routes,schemas}.ts`, `modules/company/routes.ts`,
`modules/expediente/approval.routes.ts`, migraciones 0062/0063, 19
archivos de test de `apps/api` + 1 nuevo (`security-r509-step-up-
mandatory-scope.test.ts` en `packages/db`), `apps/api/README.md`, log de
verificación.

`git show --stat 586e3cf`: 3 archivos, +81/-8 — `modules/twofa/routes.ts`,
1 test nuevo, 1 línea de doc.

### Código real (`lib/step-up.ts`)

- `assertStepUpOrgId`: exige `X-Org-Id` como UUID válido vía regex
  (`ORG_UUID_RE`), 400 si falta o no matchea.
- `assertStepUpPurpose`: exige `purpose` como uno EXACTO de
  `STEP_UP_PURPOSES` (comparación de string exacta, sin `.trim()` que
  pudiera abrir una variante con espacios — un valor con espacios extra
  simplemente no matchea y cae al 400, correcto).
- `requireStepUp` (líneas 193-247): verifica en orden (1) 2FA enrolado,
  (2) header `X-Step-Up` presente, (3) sesión existe y pertenece al
  usuario, (4) no expiró, (5) no consumida, (6) `org_id` coincide EXACTO,
  (7) `purpose` coincide EXACTO, y solo entonces (8) `UPDATE ...  set
  consumed_at = now() where id = $1 and consumed_at is null` — si
  `rowCount === 0` (alguien más ya la consumió entre el SELECT y este
  UPDATE), 403 igual. Esto cierra la ventana de carrera real, confirmado
  con la prueba adversarial de concurrencia (ver resumen ejecutivo).

  Observación menor, no bloqueante: el `UPDATE` final solo filtra por
  `id`/`consumed_at IS NULL`, no re-verifica `expires_at` — en la ventana
  teórica (un solo statement de Postgres) entre el SELECT que sí valida
  expiración y este UPDATE, una sesión que expirara en ese instante exacto
  igual se consumiría. Ventana de nanosegundos dentro de una sola
  sentencia SQL, no explotable en la práctica; se documenta por
  completitud.

### Consumidores reales de `requireStepUp` (grep exhaustivo de `apps/api/src`)

| Consumidor | `purpose` pasado | orgId | Correcto |
|---|---|---|---|
| `POST /company/rates/:id/approve` (`modules/company/routes.ts:619`) | `'company.rate_approval'` (literal) | `request.orgId!` (verificado por `app.requireOrg`, membresía real) | ✅ |
| `POST /tenders/:tenderId/approval/approve` (`modules/expediente/approval.routes.ts:108`) | `'expediente.approval'` (literal) | `request.orgId!` | ✅ |
| `POST /agents/tool-calls/:id/approve\|deny` (`modules/agents/routes.ts`) | — no llama `requireStepUp` | — | ⚠️ ver R5-11 |
| `POST /admin/tool-calls/:id/approve\|deny` (superadmin cross-org, `modules/admin/routes.ts:461-560`) | — no llama `requireStepUp` | — (resuelve `org_id` de la fila, nunca de un header) | ⚠️ ver R5-11 |

Los dos consumidores reales pasan un `purpose` **literal hardcodeado** (no
derivado de input del cliente) y un `orgId` que viene de `request.orgId`
(ya validado por `app.requireOrg` contra membresía real) — un cliente NO
puede controlar ni el `purpose` exigido ni el `orgId` esperado en el punto
de consumo; solo controla qué `orgId`/`purpose` declaró al **pedir** la
sesión, y `requireStepUp` exige que coincidan exactamente. Superadmin
cross-org approve (`admin/routes.ts`) no lleva `X-Org-Id` por diseño (línea
443-451: resuelve la organización afectada de la propia fila de
`tool_calls`, nunca de un header) — pero tampoco lleva step-up de ningún
tipo, ver R5-11.

### Migración 0062 sobre datos reales

`packages/db/test/security-r509-step-up-mandatory-scope.test.ts` (ejecutada
en este agente, verde): aplica migraciones 0001–0061 contra una base
PGlite real, inserta una fila `step_up_sessions` "genérica"
(`org_id`/`purpose` NULL, posible porque 0061 las deja NULLABLE) y otra con
scope explícito; luego aplica el resto del directorio real (incluida
0062/0063). Resultado verificado: la fila genérica desaparece, la de scope
explícito sobrevive con el mismo `id`; un `INSERT` sin `org_id`, sin
`purpose`, o sin ninguno de los dos, falla (NOT NULL real); `consumed_at`
existe, nullable, y es NULL en la fila superviviente. El `CHECK` de 0063 se
probó con los 4 valores del enum (los 4 insertan) y un valor inventado
(rechazado). Idempotencia de migrar dos veces también se prueba.

---

## R5-10 — detalle de verificación

`recordFailure` (`modules/twofa/routes.ts`) es la ÚNICA función que
escribe `twofa.verification_failed`/`twofa.step_up_denied`, invocada desde
las 4 ramas de fallo (`locked_out` en verify-enrollment y en step-up,
`no_pending_enrollment`, `invalid_code_or_replay` en ambas rutas,
`invalid_or_used_backup_code`). El cambio de `586e3cf` está en esa única
función compartida, así que un solo camino de prueba (código incorrecto en
`verify-enrollment`) cubre realmente los 4 — confirmado además por
inspección directa del código, no solo por el test.

`auditContext` (idéntico al de `modules/auth/routes.ts`) extrae
`request.ip` y el primer valor de `user-agent` — nunca contraseñas,
códigos TOTP, códigos de respaldo ni el secreto. Revisión línea por línea
de cada `after: {...}` en `modules/twofa/routes.ts` confirma que ningún
secreto se audita en ningún camino (éxito o fallo).

`request.ip` **no es falsificable con `X-Forwarded-For`** en la
configuración actual: `apps/api/src/app.ts` construye `Fastify({...})` sin
la opción `trustProxy`, que por defecto es `false` — Fastify ignora
`X-Forwarded-For` por completo y usa `request.raw.socket.remoteAddress`.
Prueba adversarial propia (`zz-probe-xff.test.ts`, borrada al terminar):
con `X-Forwarded-For: 1.2.3.4` enviado explícitamente, el `ip` auditado en
`audit_log` fue el de la conexión real (`127.0.0.1` bajo `fastify.inject`),
nunca `1.2.3.4`.

**Nota de despliegue (no es un defecto de este commit, es un
prerrequisito operativo a documentar)**: si `apps/api` se despliega alguna
vez detrás de un reverse proxy/load balancer real SIN configurar
`trustProxy` explícitamente, `request.ip` mostraría la IP del proxy para
TODAS las conexiones (nunca la IP real del cliente) — no es una vía de
falsificación nueva (sigue sin poder inyectarse una IP arbitraria vía
header), pero SÍ degradaría silenciosamente tanto la detección de rotación
de IP de R5-02 como la nueva auditoría de IP de R5-10/API-13 a un valor
constante inútil. No hay evidencia en este repo de que exista tal proxy en
producción (sin `docker-compose`/nginx/config de despliegue), así que no
se marca como hallazgo, solo se documenta.

---

## Diff de los ~19 tests adaptados — revisión archivo por archivo

Revisado con `git show a7026ec -- <archivo>` para cada uno. Ningún
`expect(...)` fue debilitado, relajado, comentado o convertido a una
aserción más permisiva en ninguno de los siguientes:

- `apps/api/test/company-profile.test.ts` — agrega `{orgId, purpose:
  'company.rate_approval'}` al helper, sin tocar ningún `expect`.
- `apps/api/test/correlation-id-e2e.test.ts` — reemplaza un `stepUpToken`
  compartido por dos tokens vía `stepUpWithBackupCode` (uno por
  `purpose`), preserva ambos `expect` originales.
- `apps/api/test/expediente-checklist-and-approval.test.ts` — el reviewer
  ahora pide DOS tokens (`reviewerStepUp`/`reviewerStepUp2`) porque aprueba
  dos veces en el mismo test; el `expect(otherApproves.statusCode).toBe(200)`
  original se preserva sin cambios, solo cambia qué header se manda.
- `apps/api/test/expediente-e2e-flow.test.ts`, `expediente-package-and-
  submission.test.ts`, `expediente-proposal.test.ts`, `ronda4-empty-
  body.test.ts` — mismo patrón mecánico (scope obligatorio / tokens
  independientes por acción), cero `expect` tocados.
- `apps/api/test/security-ae01/02/08/11/14-*.test.ts` — mismo patrón,
  cambian solo los argumentos de `enrollTwoFactor`.
- `apps/api/test/security-r502-r503-twofa-brute-force.test.ts` — agrega
  `orgId`/`purpose` a 2 llamadas existentes (sin tocar sus `expect`) y
  **agrega** un test nuevo completo (paridad ip R5-10) — estrictamente más
  cobertura, no menos.
- `apps/api/test/security-r505-stepup-scope.test.ts` — reescrito casi por
  completo, pero para **agregar** cobertura (400 sin org/purpose, 400 enum
  inválido, cross-purpose rechazado, cross-org rechazado, single-use
  rechazado) — el título del `describe` cambia de "R5-05" a "R5-05/R5-09"
  reflejando el nuevo alcance, ningún caso anterior desaparece.
- `apps/api/test/security-req044-064-step-up-2fa.test.ts` — mismo patrón
  mecánico de scope/tokens independientes; los `expect(...).toBe(200)` /
  `toBe(403)` originales permanecen idénticos.
- `apps/api/test/security-wi04-approved-rates-atomic.test.ts` — el caso de
  concurrencia real (`Promise.all` de dos `approve` a la MISMA tarifa) pasa
  de un token compartido a dos tokens independientes, con un comentario
  explícito (línea 41-44) de que hacerlo con un solo token estaría
  probando la exclusión mutua de `step_up_sessions`, no la de
  `approved_rates` (que es lo que este archivo verifica) — decisión
  correcta de diseño de test, no una forma de esconder un caso que ya no
  se prueba (el caso de concurrencia de `step_up_sessions` se cubre aparte,
  ver la prueba adversarial nueva de este reverificador). El
  `expect(codes).toEqual([200, 409])` original se preserva sin cambios.

---

## Hallazgos nuevos

### R5-11 (BAJA-MEDIA, abierto, NO introducido por a7026ec/586e3cf)

`tool_call.approval` y `admin.action` existen en `STEP_UP_PURPOSES`
(`lib/step-up.ts`) y en el `CHECK` de la migración 0063, pero **ningún
endpoint los exige**. En concreto:
- `POST /agents/tool-calls/:id/approve|deny` (org-scoped, requiere rol
  `owner`/`admin`) — sin `requireStepUp`.
- `POST /admin/tool-calls/:id/approve|deny` (superadmin, cross-org, sin
  `X-Org-Id`) — sin `requireStepUp`.

Esto significa que aprobar o denegar una `tool_call` pendiente de un
agente — una acción que puede autorizar gasto/envío/uso de API en nombre
de la organización, y que en el caso de superadmin es además cross-org —
no exige ninguna verificación en dos pasos, pese a que el propio diseño
del enum de propósitos ya reservó un valor específico para este caso desde
esta misma migración. **No es una regresión**: ninguno de los dos commits
reverificados tocó estos endpoints, y el hueco ya estaba declarado
honestamente por el agente #72 en `docs/PROGRESO.md`
("tool_calls sin 2FA"). Se deja como candidato explícito para una futura
ronda de reparación: si `tool_call.approval`/`admin.action` no van a
usarse en el corto plazo, considerar documentarlo explícitamente en el
README (hoy el README de R5-09 solo menciona los 2 consumidores reales,
sin mencionar los 2 propósitos "reservados sin uso" — no es una promesa
falsa, pero es una ambigüedad que vale la pena aclarar) o, si el riesgo se
considera real, extender `requireStepUp` a estos dos endpoints con
`purpose: 'tool_call.approval'`/`'admin.action'` respectivamente.

### R5-12 (BAJA, doc, `apps/web`, fuera del código reverificado pero descubierto en el camino)

`apps/web/src/lib/api/twofa.ts:33-35` (comentario, no código ejecutable)
afirma que *"la ruta `/2fa/verify-enrollment` en sí no fue actualizada
para EXIGIRLOS a nivel de aplicación como sí lo está `/2fa/step-up`"* —
esto es **incorrecto** respecto al código real de `apps/api`:
`modules/twofa/routes.ts` llama a `assertStepUpOrgId`/`assertStepUpPurpose`
en `/2fa/verify-enrollment` exactamente igual que en `/2fa/step-up` (ambos
400 explícitos si faltan). No tiene impacto funcional (el cliente de
`apps/web` ya declara ambos campos siempre, así que nunca dispara el 400),
pero es un comentario desactualizado/incorrecto que puede confundir a
quien lo lea después — probablemente escrito antes de que `a7026ec`
terminara de fijar el comportamiento real, o por el agente #71 en paralelo
sin la versión final. Se recomienda corregir el comentario en una futura
pasada de `apps/web` (fuera del alcance de escritura de este agente).

---

## Veredicto

- **R5-09: CERRADO.** Los 8 ataques del encargo (incluidos los dos que la
  suite existente no cubre directamente — concurrencia sobre el MISMO
  token y falsificación de IP vía XFF, para R5-10 — verificados con
  pruebas adversariales adicionales de este agente) se comportan
  correctamente contra el código real. Migraciones 0062/0063 verificadas
  contra datos reales, no solo por inspección.
- **R5-10: CERRADO.** `ip`/`userAgent` presentes en las 4 razones de fallo
  de 2FA, mismo extractor que `auth.login_failed`, sin TOTP en claro, IP no
  falsificable vía `X-Forwarded-For` en la configuración actual.
- **Diff de los ~19 tests adaptados: sin aserciones debilitadas.**
- **Regresión `apps/worker`: ninguna.** `typecheck` limpio, 11 archivos /
  298 tests, todos verdes (mismo número que rondas anteriores).
- **Nuevos hallazgos abiertos, no bloqueantes para este cierre**: R5-11
  (`tool_call.approval`/`admin.action` sin consumidor real — aprobación de
  `tool_calls`, incluida la cross-org de superadmin, sin ningún step-up) y
  R5-12 (comentario desactualizado en `apps/web/src/lib/api/twofa.ts`).

---

## Estado reparación (corrector, post-reverificación)

Agregado por el agente corrector Sonnet `fix-api-r5-11`, ámbito exclusivo
`apps/api/src/modules/agents/**` + `apps/api/src/modules/admin/**` (solo
`tool_calls`) + sus tests + `apps/api/README.md`. Evidencia de comandos
reales en `docs/logs/fix-api-r5-11.log`. Solo se actualiza la fila R5-11
(R5-12 es `apps/web`, fuera del alcance de este corrector).

| Hallazgo | Estado reparación | Commit / evidencia |
| --- | --- | --- |
| R5-11 (BAJA-MEDIA) | **CORREGIDO** | `POST /agents/tool-calls/:id/approve\|deny` (org-scoped) ahora llama `requireStepUp` con `purpose: 'tool_call.approval'` y el `orgId` ya validado por `app.requireOrg` (mismo patrón que `company/routes.ts`/`expediente/approval.routes.ts`, `apps/api/src/modules/agents/routes.ts`). `POST /admin/tool-calls/:id/approve\|deny` (superadmin, cross-org, sin `X-Org-Id`) ahora llama `requireStepUp` con `purpose: 'admin.action'`, resolviendo el `orgId` de un `SELECT org_id from tool_calls where id = $1` previo sobre la misma fila que luego se muta (esta ruta nunca lleva `X-Org-Id`; `apps/api/src/modules/admin/routes.ts`) -- un superadmin sin 2FA enrolado recibe 403 con instrucción, igual que cualquier otro consumidor de `requireStepUp`; una `tool_call` inexistente sigue respondiendo 404 sin exigir step-up (nada que autorizar todavía). Tests nuevos: `apps/api/test/security-r511-tool-call-stepup.test.ts` (org-scoped: sin 2FA → 403 con instrucción, sin `X-Step-Up` → 403, `purpose` incorrecto → 403, `orgId` incorrecto → 403, step-up correcto → 200 con sesión consumida y no reutilizable). `apps/api/test/ronda4-admin-tool-calls.test.ts` ampliado con los mismos casos para el cross-org de superadmin (sin 2FA → 403, sin `X-Step-Up` → 403, `purpose` incorrecto → 403, éxito → 200 con sesión consumida, 404 sin exigir step-up). Ajustados sin debilitar ninguna aserción: `apps/api/test/agent-persistence.test.ts`, `apps/api/test/security-api09-tool-calls-atomic.test.ts` y `apps/api/test/ronda4-empty-body.test.ts` (piden un `stepUpToken` por cada acción que ahora lo exige, vía `enrollTwoFactorFull`/`stepUpWithBackupCode`). `npm run -w apps/api typecheck lint test` verde, salida completa en `docs/logs/fix-api-r5-11.log`. |
