# Reverificación adversarial de la reparación — ronda 5 `apps/api`

Fecha: 2026-09-06. Agente: reverificador adversarial Sonnet, contexto
independiente del proyecto "Atiende Licitaciones". Rol: **SOLO
encuentra/verifica** — ningún código de `apps/api`, `packages/db`,
`apps/web` ni `apps/worker` fue modificado por este agente.

**Objeto de reverificación**: la columna "Estado reparación" de
`docs/auditoria-2/api-ronda5.md` (hallazgos R5-01 a R5-08), agregada por el
agente corrector en los commits `fccab53` (R5-01), `7242298` (R5-02/03/05),
`4db65e9` (R5-04), `c2deca5` (R5-06/07) y `efea5b3` (docs).

**Metodología**: `git worktree add <scratchpad>/reverify-api5 HEAD` (HEAD
real al iniciar: `926c996`) + `npm install` real; el repo principal nunca
se tocó con `git reset`/`checkout <commit>`/`stash`/`rebase`/`add -A`. Se
reprodujeron de cero (no se leyó ningún resultado preexistente sin
re-ejecutar) `typecheck`/`lint`/`test` de `apps/api`, `test` de
`packages/db`, `typecheck`/`test` de `apps/worker`, y `typecheck` de
`apps/web`. Para verificar comportamiento real (no solo lectura de código)
se escribieron 6 archivos de prueba adversarial temporales
(`apps/api/test/_reverify-probe-*.test.ts`), ejecutados con
`fastify.inject` + PGlite y **borrados** al terminar — `git status
--short`/`git diff --stat` del worktree confirmados vacíos antes de
eliminarlo. Evidencia completa de comandos reales en
`docs/logs/reverify-api-ronda5.log`.

---

## Resumen ejecutivo

Los 5 commits de reparación son ancestros confirmados de `HEAD` y
reproducen limpio: `apps/api` 227 tests (típecheck/lint sin errores),
`packages/db` 158 tests, `apps/worker` 298 tests (típecheck sin errores),
`apps/web` típecheck sin errores — los 4 números coinciden exactamente con
lo declarado en la tabla del corrector.

De los 7 hallazgos con reparación reclamada (R5-01 a R5-07; R5-08 quedó
correctamente marcado FUERA DE ÁMBITO), **4 se confirman CERRADOS** con
ataques adicionales reales que no rompieron el fix (R5-01, R5-04, R5-06,
R5-07), y **2 se confirman PARCIALES** con evidencia reproducible de que el
riesgo original persiste bajo un ángulo que la tabla del corrector no
declara explícitamente:

- **R5-05 → PARCIAL**: el scope opcional de `step_up_sessions`
  (org/purpose) nunca se activa en el flujo real de `apps/web` — el
  producto solo genera sesiones "genéricas", así que el riesgo original de
  R5-05 (un mismo `stepUpToken` aprueba cualquier tarifa/expediente en
  cualquier organización del usuario) sigue intacto en producción. Nuevo
  hallazgo **R5-09**.
- **R5-03 → PARCIAL** (dentro de R5-02/R5-03): los fallos de 2FA sí quedan
  auditados con `actor_id`/`request_id`/`correlation_id` y sin el código en
  claro, pero **nunca con la IP del cliente** — a diferencia de
  `auth.login_failed` (API-13), que sí la incluye. Nuevo hallazgo
  **R5-10**.

El resto de R5-02 (límite de tasa + bloqueo progresivo por usuario) resistió
todos los ataques adicionales: rotación de IP, usuario distinto desde la
misma IP, desbloqueo por tiempo, y duplicación real de la ventana en un
segundo ciclo de bloqueo.

Ningún hallazgo nuevo es CRÍTICO ni revierte ninguna de las dos
reparaciones CRÍTICAS (R5-01, R5-02), que se confirman sólidas.

---

## 1. Ancestría y `git show --stat`

```
$ git merge-base --is-ancestor <hash> HEAD
fccab53 (R5-01)          ANCESTOR: yes
7242298 (R5-02/03/05)    ANCESTOR: yes
4db65e9 (R5-04)          ANCESTOR: yes
c2deca5 (R5-06/07)       ANCESTOR: yes
efea5b3 (docs)           ANCESTOR: yes
```

Orden real en `git log` coincide con el orden declarado en la tabla:
`fccab53 → 7242298 → 4db65e9 → c2deca5 → efea5b3`.

| Commit | Archivos tocados (resumen) |
| --- | --- |
| `fccab53` (R5-01) | `post-award.routes.ts` (+55/-6) + 1 test nuevo (224 líneas) |
| `7242298` (R5-02/03/05) | 16 archivos, 822(+)/75(-): `audit.ts`, `errors.ts`, `rate-limit-settings.ts`, `step-up.ts`, `twofa-lockout.ts` (nuevo), `company/routes.ts`, `expediente/approval.routes.ts`, `twofa/routes.ts`, `twofa/schemas.ts`, `error-handler.ts`, `test/helpers.ts`, 2 tests nuevos, 3 migraciones (0058/0059/0061) |
| `4db65e9` (R5-04) | `internal-ingest.routes.ts` (+46/-17) + 1 test nuevo (165 líneas) + migración 0060 |
| `c2deca5` (R5-06/07) | `schema-helpers.ts` (+27, nuevo) + `admin/schemas.ts` (+17/-4) + 1 test nuevo (105 líneas) |
| `efea5b3` (docs) | `apps/api/README.md` + `docs/auditoria-2/api-ronda5.md` |

---

## 2. Suites oficiales reproducidas desde cero

| Suite | Resultado reproducido | Declarado por el corrector |
| --- | --- | --- |
| `apps/api` typecheck/lint | 0 errores | 0 errores |
| `apps/api` test | **227/227** | 227 |
| `packages/db` test | **158/158** (incluye migraciones 0058-0061 idempotentes) | 158 |
| `apps/worker` typecheck/test | 0 errores / **298/298** | 298 |
| `apps/web` typecheck | 0 errores | (no declarado explícitamente en la tabla, verificado igual) |

---

## 3. Ataques por hallazgo

### R5-01 (calendario oficial excluye el día real del plazo) — **CERRADO**

Además de la cobertura ya existente (feriado dentro/fuera de ventana, fin
de semana, aceptación en fin de semana, propiedad N=0..3 feriados
consecutivos), se atacó con:

- **Feriado el mismo día de la aceptación**: no se cuenta (la ventana de
  negocio empieza al día siguiente) y `calendarNote` no afirma exclusión.
  Correcto.
- **Año bisiesto (2024-02-29) cargado y dentro de ventana**: sí mueve el
  `dueDate` real (efecto real en el cómputo, no solo en la validación del
  esquema de `POST /admin/calendar-holidays`).
- **TZ de sesión, UTC vs. México**: el mismo cómputo (mismo tender, misma
  fecha, mismo feriado) bajo `TZ=America/Mexico_City` y bajo `TZ=UTC`
  produce `dueDate`/`calendarNote` **idénticos**. `toDateOnlyString`
  (getters UTC explícitos) cierra realmente el vector original.

No se encontró ninguna combinación que reabra el bug original.

### R5-02/R5-03 (2FA anti-fuerza-bruta + auditoría) — **PARCIAL**

**R5-02 (límite de tasa + bloqueo progresivo): sólido.** Ataques
adicionales, todos resistidos:

- **IP rotada sobre el mismo usuario** (5 fallos, 5 IPs distintas vía
  `remoteAddress`): el contador por usuario en DB sí activa el bloqueo; un
  6º intento desde una IP nunca antes usada sigue en 429.
- **Usuario distinto desde la misma IP** que uno ya bloqueado: no hereda el
  lockout ajeno (el límite de tasa por IP, compartido a nivel de plugin,
  sí puede afectarlo, pero el lockout de cuenta en DB nunca se cruza entre
  usuarios).
- **Desbloqueo por tiempo**: con `locked_until` en el pasado, un código
  válido inmediatamente después responde 200.
- **Bloqueo progresivo real**: un segundo ciclo de 5 fallos duplica
  efectivamente la ventana de bloqueo respecto al primero (`lock_count`
  1→2, ventana ~5min→~10min).

**R5-03 (auditoría de fallos): incompleta.** Confirmado que
`actor_id`/`request_id`/`correlation_id` sí quedan, y que el código TOTP
nunca aparece en claro — pero la **IP del cliente nunca se registra**, ni
como columna (`audit_log` no tiene columna de IP) ni dentro del jsonb
`after` (solo `{reason, retryAfterSeconds}`). Una comparación directa
contra un `auth.login_failed` real en la misma corrida confirma que ESE
evento sí incluye la IP — la asimetría es real, no una limitación general
del esquema. Ver **R5-10** abajo.

### R5-04 (correlation_id nace en el ingest) — **CERRADO** (en el ámbito de `apps/api`)

- `X-Correlation-Id` malformado con payload de inyección
  (`'; DROP TABLE tenders; --'`): la request no se rechaza, el valor crudo
  nunca se persiste ni se refleja (se genera un UUID nuevo), y la tabla
  `tenders` permanece íntegra.
- `X-Correlation-Id` de 10,000 caracteres: no tumba la request ni el
  proceso; se descarta igual que el malformado.
- `X-Correlation-Id` válido: se hereda tal cual sin regenerar
  innecesariamente.
- La traza real de extremo a extremo (ingesta → tarifa → checklist →
  aprobación → paquete, reconstruida en `GET /audit-log?correlationId=`
  con la entidad `tenders` presente) se reprodujo sin cambios.

El hueco declarado "FUERA DE ÁMBITO" (`apps/worker/src/source-runs/
source-runs-repository.ts` nunca incluye `correlation_id` en su INSERT a
`source_runs`) se reconfirmó **sin cambios** por lectura directa — sigue
exactamente igual que en la auditoría original, correctamente etiquetado
como no tocado.

### R5-05 (scope de step-up) — **PARCIAL**

El mecanismo en sí funciona correctamente para un cliente que declare
`orgId`/`purpose` (reutilización cruzada de purpose y de organización,
ambas rechazadas; cobertura existente reproducida sin cambios). Pero:

- Se confirmó, leyendo `apps/web/src/lib/api/twofa.ts` y
  `apps/web/src/lib/api/client.ts`, que **el producto real nunca declara
  `orgId` ni `purpose`** al pedir un step-up (`verifyTwoFactorEnrollment`/
  `verifyStepUp` solo mandan `{code}`).
- Se reprodujo con una prueba real: un `stepUpToken` obtenido exactamente
  como lo hace `apps/web` hoy aprueba una tarifa en la organización A y,
  sin volver a verificar 2FA, también aprueba una tarifa en la
  organización B con el mismo token.

Es decir: el riesgo original de R5-05 (documentado como "diseño discutible
más que defecto") **sigue completamente vigente en producción real**,
porque el fix es opt-in y ningún cliente actual opta. Ver **R5-09** abajo.

### R5-06/R5-07 (validación de `POST /admin/calendar-holidays`) — **CERRADO**

- `sourceUrl` con `file:///etc/passwd` → 422.
- `sourceUrl` con `ftp://ftp.gob.mx/...` → 422.
- `sourceUrl` con `JAVASCRIPT:alert(1)` (mayúsculas) → 422 (sin bypass
  trivial de mayúsculas).
- Cobertura existente (javascript:/data: rechazados, http/https aceptado,
  `2026-02-30`/`2026-13-01` → 422, `2024-02-29` bisiesto real aceptado)
  reproducida sin cambios.

---

## 4. Hallazgos nuevos

### R5-09 (BAJA-MEDIA) — El scope opcional de step-up (R5-05) nunca se activa en `apps/web`

**Evidencia**: `apps/web/src/lib/api/twofa.ts`:

```ts
export async function verifyStepUp(code: string): Promise<StepUpResponse> {
  const raw = await apiRequest<unknown>("/auth/2fa/step-up", { method: "POST", body: { code } });
  return stepUpResponseSchema.parse(raw);
}
```

Nunca pasa `orgId` ni incluye `purpose` en el body. `apiRequest`
(`apps/web/src/lib/api/client.ts:36`) solo agrega el encabezado
`X-Org-Id` si `opts.orgId` se pasó explícitamente — cosa que ni
`verifyStepUp` ni `verifyTwoFactorEnrollment` hacen. Resultado: **toda**
sesión de step-up que produce el producto real queda con `org_id=null`,
`purpose=null` ("genérica"), y `requireStepUp` (`lib/step-up.ts`) nunca
aplica ninguna restricción a una sesión genérica — exactamente el
comportamiento previo a la ronda 5.

Reproducido con una prueba real (ver sección 3, R5-05): el mismo
`stepUpToken` de una sesión genérica aprueba una tarifa en dos
organizaciones distintas del mismo usuario sin volver a verificar 2FA.

**Por qué no se detectó en la tabla del corrector**: el propio test del
corrector (`security-r505-stepup-scope.test.ts`, último caso, "una sesión
GENÉRICA... sigue sirviendo para cualquier acción") ya documenta este
comportamiento, pero ni el test ni la fila de la tabla "Estado reparación"
señalan que es el **único** comportamiento que el producto real ejercita
hoy — la etiqueta "CORREGIDO (alcance opcional)" es honesta sobre el
alcance declarado, pero deja implícito (solo verificable leyendo dos
repos, `apps/api` y `apps/web`, a la vez) que el riesgo original de R5-05
sigue intacto en producción.

**Reparación propuesta (no aplicada)**: que `apps/web` pase `purpose:
'company.rate_approval'` / `'expediente.approval'` y el `orgId` activo al
pedir el step-up desde `TarifasAprobadasPage`/la aprobación de expediente
(`useTwoFactor.ts`/`twofa.ts`).

### R5-10 (MEDIA-BAJA) — Los fallos de 2FA se auditan sin la IP del cliente

**Evidencia**: `SecurityAuditEntry` (`apps/api/src/lib/audit.ts`) no tiene
ningún campo de IP, y `recordFailure` (`apps/api/src/modules/twofa/
routes.ts`) nunca llama a `request.ip`. El payload `after` de
`twofa.verification_failed`/`twofa.step_up_denied` solo contiene `{reason,
retryAfterSeconds}`. `audit_log` tampoco tiene una columna de IP a nivel de
esquema.

Esto rompe la paridad que la propia justificación de R5-03 invoca
explícitamente con `auth.login_failed` (API-13/0051): ese evento sí
incluye `ip`/`userAgent` dentro de su propio `after` (vía `auditContext`,
`apps/api/src/modules/auth/routes.ts:34-36`). Confirmado con una
comparación directa en la misma corrida: un `auth.login_failed` real
contiene la IP del cliente en su `after`; un `twofa.verification_failed`
real, con la misma IP simulada, no la contiene en ningún lado.

**Impacto**: sin la IP, reconstruir en retrospectiva si un intento de
fuerza bruta contra 2FA vino concentrado desde una IP o distribuido entre
muchas (relevante para decidir un bloqueo de red además del bloqueo de
cuenta que R5-02 ya resuelve) es más difícil de lo necesario — no anula la
protección de R5-02 (que es por usuario, no depende de esto), pero sí
reduce la calidad forense del rastro que R5-03 dice cerrar.

**Reparación propuesta (no aplicada)**: agregar `ip`/`userAgent` al
payload `after` de `recordFailure` en `modules/twofa/routes.ts`, replicando
el patrón de `auditContext` en `modules/auth/routes.ts` — no requiere
migración nueva (`after` ya es `jsonb` sin esquema fijo).

---

## 5. Regresión `apps/web` typecheck

`apps/web` no tuvo cambios de código en esta ronda de reparación (solo
`apps/api` + `packages/db`); `npm run typecheck` reproducido limpio (0
errores), como se esperaba.

---

## 6. Candidatos REQ a CUMPLIDO (con el test que lo prueba)

| REQ | Veredicto propuesto | Test que lo prueba |
| --- | --- | --- |
| REQ-044/REQ-064 (re-autenticación 2FA/TOTP distinta del rol, en aprobación económica) | **CUMPLIDO**, con nota: el "modo sudo" de una sesión step-up genérica (R5-09) es más laxo que "no reutilizable para otra acción", pero eso es una propiedad de *alcance* del step-up, no la ausencia del mecanismo de re-autenticación que exige el requisito | `security-r502-r503-twofa-brute-force.test.ts` (bloqueo/replay/auditoría), `security-wi04-approved-rates-atomic.test.ts` y `expediente-checklist-and-approval.test.ts` (2FA exigido en la aprobación económica), reproducidos en verde |
| REQ-050 (motor de plazos versiona la ley aplicable por fecha de convocatoria) | **CUMPLIDO** | `security-r501-calendar-holidays-effect.test.ts` + `_reverify-probe-r501` (bisiesto/TZ/mismo-día), `packages/expediente/test/timezone-determinism.test.ts` |
| REQ-056 (motor de calendario legal con días inhábiles) | **PARCIAL** (sin cambio por esta ronda): el cómputo real de días inhábiles oficiales ya SÍ afecta el plazo (antes no, R5-01 lo cierra), pero los recordatorios siguen siendo una alerta binaria (`vencido`/`próximo`), no el T-72/24/6h escalonado del texto original del requisito — consistente con lo que `apps/api/docs/e11-cobertura.md` ya documenta | `security-r501-calendar-holidays-effect.test.ts`, `_reverify-probe-r501` |
| REQ-142 (procedencia por campo, sin procedencia el dato no es utilizable) | **CUMPLIDO** (sin cambios en esta ronda, reconfirmado sin regresión) | `security-req142-provenance-binding.test.ts` |
| REQ-171 (trazas correlacionadas de extremo a extremo desde la convocatoria) | **CUMPLIDO** para la cadena observable desde `apps/api` (ingesta → matriz → propuesta → paquete → archivo, con la entidad `tenders` ahora presente); **residual documentado**: `apps/worker`→`source_runs` (el paso de *descubrimiento*, antes de que la convocatoria exista como `tender`) sigue sin `correlation_id`, fuera del ámbito de este corrector | `security-r504-correlation-id-ingest.test.ts` (incluye el test end-to-end real con `GET /audit-log?correlationId=`), `_reverify-probe-r504` |
| REQ-119 (aviso de privacidad integral, plazo ARCO, minimización) | **CUMPLIDO** (sin cambios en esta ronda) | `legal-privacy-notice.test.ts` |
| REQ-131 (declarar en el aviso y en un reporte de transparencia el enrutamiento a un proveedor/modelo distinto del principal) | **NO CUMPLIDO / NO APLICA TODAVÍA**: el aviso de privacidad menciona la promesa ("se declarará... en un reporte de transparencia del producto"), pero no existe ningún reporte de transparencia real ni ningún enrutamiento a un proveedor distinto del principal en el código — no es una regresión de esta ronda, es una funcionalidad que no se ha necesitado activar aún | (ninguno; no hay endpoint/documento de reporte de transparencia que probar) |

---

## Nota de alcance

No se auditó nada de `apps/web`/`apps/worker` más allá de lo reproducido en
la sección 2 (típecheck/test) — no se pidió explícitamente una revisión más
profunda de esas dos áreas en este encargo, y ningún hallazgo de esta
reverificación requiere tocarlas para confirmarse (R5-09 se confirmó
leyendo `apps/web` como consumidor, sin modificarlo). El worktree
`reverify-api5` se eliminó al cierre de esta reverificación.
