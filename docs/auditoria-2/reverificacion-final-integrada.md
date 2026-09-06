# Reverificación adversarial FINAL integrada — `apps/api` + `apps/web` (ronda 4)

**Fecha**: 2026-09-06. **Agente**: reverificador adversarial final Sonnet,
contexto independiente del proyecto, sin participación en la construcción ni
reparación de ningún hallazgo citado. Rol: **SOLO encuentra y verifica** —
ningún código de `apps/api`, `packages/db`, `apps/web`, `apps/worker` ni
`packages/expediente` fue modificado por este agente ni por los 2 sub-agentes
Sonnet (`model="sonnet"` explícito) que repartieron el trabajo dinámico.

**Metodología**: `git worktree add <scratchpad>/reverify-final HEAD` (HEAD real
al iniciar: `2e67bad "docs: cierre api ronda 4"`) + `npm install` real, para
suites oficiales y `test:e2e:full`. 2 worktrees adicionales
(`reverify-final-sub1` para ataques dinámicos de `apps/api`,
`reverify-final-sub2` para ataques dinámicos de `apps/web` vía Playwright),
cada uno con su propio `npm install`, que escribieron specs/tests
adversariales TEMPORALES (`apps/api/test/zz-adversarial-sub1-*.test.ts`,
`apps/web/e2e/zz-adversarial-sub2-*.spec.ts`), los ejecutaron contra un
servidor HTTP real (no solo `fastify.inject`) o contra Chromium real
(Playwright), y los **borraron** al terminar — `git status --short` confirmado
limpio en los 3 worktrees (solo `package-lock.json` modificado por el propio
`npm install`). **Nunca** se usó `git reset`/`checkout <commit>`/`stash`/
`rebase`/`commit --amend`/`add -A` en el repo principal. Los 3 worktrees se
eliminan al cierre de esta auditoría (ver §7).

Nota de gobierno: el repo principal recibió commits **docs-only** concurrentes
de otro agente durante esta sesión (HEAD avanzó de `2e67bad` a `2a02587`
mientras este agente trabajaba); se verificó que ninguno de esos commits toca
código de `apps/api`/`apps/web`/`packages/db`/`apps/worker`/`packages/expediente`,
así que no invalida ningún resultado de este documento.

Documentos base leídos: `docs/auditoria-2/api-expediente.md`,
`docs/auditoria-2/api-expediente-reverificacion.md` (columna "Estado
reparación": AE-08, AE-11, AE-14, API-14, AE-15 → commits de ronda 4),
`docs/auditoria-2/web-integrado.md` (WI-01..05 → commits de ronda 4),
`apps/api/README.md` (ronda 4: CORS, memberships, audit-log, tool_calls
cross-org, `RATE_LIMIT_PROFILE`, POST sin cuerpo), `apps/web/README.md`,
`docs/ACEPTACION.md` (A1–A15).

---

## 1. Ancestría y contenido de los commits citados

**Los 20 commits citados por el encargo son reales y ancestros lineales del
HEAD real del repo** (`git merge-base --is-ancestor <hash> HEAD` → sí para
los 20; confirmado también contra el HEAD posterior `2a02587` tras los
commits docs-only concurrentes).

| Commit | Hallazgo | `git show --stat` (resumen) |
|---|---|---|
| `9064469` | AE-08 | `lib/expediente/inputs.ts` (+77) + test nuevo (105 líneas) |
| `e30e41c` | AE-11 | `approval-store.pg.ts`, `proposal.routes.ts`, migración `0053`, test nuevo |
| `1b73639` | AE-14 | `errors.ts`, `package.routes.ts` (+133/-19), test nuevo (101 líneas) |
| `a47c287` | API-14 | `auth/routes.ts`, migración `0054`, test nuevo + ajuste a `security-definer-audit.test.ts` |
| `12189a3` | AE-15 | `app.ts`, `storage.ts`, test nuevo (56 líneas) |
| `74c2358` | WI-03 | `App.tsx`, `useAuth.tsx`, `queryClient.ts` (nuevo), `useAuth.test.tsx` (+65) |
| `2ae7af8` | WI-02 | `validateDocumentFile.ts` (nuevo, 82 líneas) + test (50) + `DocumentosVigenciasPage.tsx` + E2E |
| `a1f70bb` | WI-04 | `useCompany.ts`, `TarifasAprobadasPage.tsx` (+93/-34), test de componente (116 líneas) |
| `33869c2` | WI-01 | `src/lib/security/csp.ts` (nuevo), `vite.config.ts`, README, `e2e/csp.spec.ts` |
| `5cbb538` | WI-05 | `scripts/e2e-full.mjs`, `skip-link.spec.ts`, `playwright.config.ts` |
| `f2fef8a`, `6c43174`, `3532308`, `2170bf3`, `622dbe2`, `6534f5f`, `d4788fe`, `f8ffaa6`, `e097c27`, `668a082` | AE-01/02/09/03-05/04/10/12, DB-13, API-13 | Confirmados ya en la ronda de reverificación anterior (`api-expediente-reverificacion.md`), no re-auditados en detalle aquí por no ser objeto de esta ronda 4 |

Los archivos tocados en cada commit de ronda 4 son quirúrgicos (migración SQL
+ cambio puntual en 1-2 archivos + test nuevo dedicado), nunca reescrituras
masivas que pudieran esconder algo. Detalle completo en
`docs/logs/reverify-final-integrada.log` §1.

**Veredicto: CUMPLE.**

---

## 2. Suites oficiales

| Comando | Resultado |
|---|---|
| `npm run -w apps/api typecheck` | exit 0 |
| `npm run -w apps/api lint` | exit 0 |
| `npm run -w apps/api test` | **180/180 tests, 48/48 archivos** |
| `npm run -w packages/db typecheck` | exit 0 |
| `npm run -w packages/db lint` | exit 0 |
| `npm run -w packages/db test` | **156/156 tests, 22/22 archivos** |
| `npm run -w apps/web typecheck` | exit 0 |
| `npm run -w apps/web test` (unit) | **79/79 tests, 15/15 archivos** (ruido conocido de jsdom sin `canvas`, no afecta resultado) |
| `npm run -w apps/worker typecheck` | exit 0 |
| `npm run -w apps/worker test` | **298/298 tests, 11/11 archivos** |

**`npm run -w apps/web test:e2e:full`** (build de producción real + `apps/api`
real con PGlite en memoria + `RATE_LIMIT_PROFILE=e2e`), corrido **dos veces**
con puertos distintos cada vez:

| Corrida | Resultado |
|---|---|
| 1 | **98 passed, 0 failed, 0 flaky** (1.8 min) |
| 2 | **98 passed, 0 failed, 0 flaky** (2.0 min) |

**Determinismo confirmado**: resultado idéntico en ambas corridas, sin el
patrón de 3 fallas por 429 documentado en `web-integrado.md` (ronda 3) antes
de WI-05. `RATE_LIMIT_PROFILE=e2e` (literal exacto, ver
`apps/api/src/config.ts:49`) eleva los límites reales
(`apps/api/src/lib/rate-limit-settings.ts`: global 300→3000/min, auth
5→300/min, sensitiveAction 30→1000/min) solo para este harness.

**Veredicto: CUMPLE** en ambos rubros (suites oficiales y determinismo E2E).

---

## 3. Ataques dinámicos — `apps/api` (ronda 4)

Ejecutados por un sub-agente Sonnet independiente contra un servidor HTTP
real (`tsx src/index.ts`, PGlite en memoria) en un worktree propio, con
`curl`/`fetch` reales y `Promise.all` para concurrencia real (no solo
`fastify.inject` secuencial). Verificación cruzada de este agente sobre el
hallazgo nuevo (punto 6).

| # | Ataque | Veredicto | Evidencia |
|---|---|---|---|
| 1 | CORS preflight por método (`PUT`/`PATCH`/`DELETE`) y cabecera (`X-Org-Id`/`Authorization`/`Idempotency-Key`); origen no listado | **CUMPLE** | Preflight real (puerto 3781): `access-control-allow-methods` incluye los 6 métodos + `OPTIONS`; headers custom reflejados; origen `evil.attacker.test` nunca recibe `Access-Control-Allow-Origin` |
| 2 | Memberships de otra org (ambas direcciones) | **CUMPLE** | `GET /organizations/:orgId/memberships` con `:orgId` ajeno → 403, incluido el caso de usuario miembro de ambas orgs |
| 3 | Audit-log de otra org y filtros (incl. `orgId` como query manipulado) | **CUMPLE** | Nunca cruza org, con o sin filtros; rango invertido no produce 500 |
| 4 | Superadmin cross-org approve/deny + doble aprobación 409 | **CUMPLE** | Cross-org confirmado; concurrencia real 5 repeticiones (2x, 5x, approve-vs-deny): siempre 1×200 + resto 409, 1 sola fila de `audit_log` por decisión |
| 5 | `RATE_LIMIT_PROFILE=e2e` NO activo sin la variable | **CUMPLE** | Servidor real SIN la variable: intentos 1-4 de `/auth/login` → 401, intentos 5-6 → **429 real** (perfil default sigue limitando de verdad) |
| 6 | POST sin cuerpo en rutas de acción | **PARCIAL — hallazgo nuevo API-15** | Ver tabla de hallazgos abajo |
| 7 | AE-08: cambiar firmante/capability tras aprobar → invalida | **CUMPLE** | Verificado también con `products-services`/`locations`/`registrations`/`restrictions`, no solo signatories/capabilities |
| 8 | AE-11: writer edita sección → reviewer (mismo actor) intenta aprobar | **CUMPLE** | 403 `actor_autor_de_contenido`; un tercero sin relación aprueba con éxito (control negativo) |
| 9 | AE-14: paquete ready → editar sección → `/latest`/`/download` | **CUMPLE** | `/latest` reporta `draft` con `draftReasons`; `/download` → 409 explícito, nunca sirve el ZIP viejo |
| 10 | API-14: forjar `actor_id` de evento de autenticación | **CUMPLE** | Sin vector HTTP disponible (logout/login/register ignoran cualquier `actorId`/`userId` del body); a nivel SQL, rechazo confirmado por el test oficial ya existente, `login_failed` sigue funcionando sin sesión |
| 11 | AE-15: body de ~23MB / por encima del límite | **CUMPLE** | `contentBase64` justo sobre `MAX_BASE64_LENGTH` → 422 explícito; body de 33MB por red real → 413 en <20ms |
| 12 | WI-01 API: CSP/Permissions-Policy/Referrer-Policy en TODAS las rutas | **CUMPLE** | 10 rutas variadas (200/204/401×4/404/422×2) vía `curl -sD -` contra servidor real, más 400/403/409/429 vía inject — todas con las 3 cabeceras |
| 13 | WI-04 API: doble aprobación concurrente de tarifa | **CUMPLE** | 5 repeticiones con `fetch` real concurrente: en las 5, `[200,409]`; 1 sola fila de `audit_log` (confirmado también por el test oficial `security-wi04-approved-rates-atomic.test.ts`) |

### Hallazgo nuevo — API-15 (BAJA)

`POST /company/rates/:id/approve` y `POST /company/rates/:id/reject`
(`apps/api/src/modules/company/routes.ts:578-682`, documentadas en su propio
schema como **"Sin cuerpo"**) NO están registradas dentro de
`withOptionalEmptyJsonBody` (`apps/api/src/lib/optional-empty-body.ts`), a
diferencia de TODAS las demás rutas de acción sin cuerpo corregidas en ronda 4
(`/agents/tool-calls/:id/approve|deny`, `/admin/tool-calls/:id/approve|deny`,
`/admin/jobs/:id/retry`, `/admin/incidents/:id/resolve`). Un cliente que
envíe `Content-Type: application/json` con cuerpo vacío (longitud 0, no
`{}`) a estas dos rutas recibe **400** ("Body cannot be empty...") en vez de
ejecutar la acción — mismo bug de clase que el corregido en ronda 4 para las
demás rutas, simplemente no se propagó a este archivo. Confirmado
dinámicamente con `fastify.inject` real y reconfirmado por lectura de código
de este agente (`grep -n "withOptionalEmptyJsonBody" apps/api/src/modules/*/routes.ts`
no incluye `company/routes.ts`). **No es explotable como vulnerabilidad**
(fail-closed, un cliente real que quiera aprobar/rechazar una tarifa sin
cuerpo recibe un error en vez de ejecutar la acción indebidamente) — es una
regresión de robustez/UX no propagada, mismo patrón que AE-12
(documentación/consistencia). `/organizations` (que sí exige cuerpo) y
`/expediente/.../conflicts/:id/resolve` (que exige `resolutionNotes`) siguen
rechazando correctamente cuerpo vacío, sin regresión.

**Reparación sugerida (no implementada)**: envolver
`server.post('/rates/:id/approve', ...)` y `.../reject` con
`withOptionalEmptyJsonBody`, mismo patrón que `agents/routes.ts`/`admin/routes.ts`.

---

## 4. Ataques dinámicos — `apps/web` (ronda 4)

Ejecutados por un segundo sub-agente Sonnet independiente contra el build de
producción real (`vite preview`) + `apps/api` real, con Playwright/Chromium
real (no simulación de eventos vía `dispatchEvent`). Dos rondas: la primera
detectó 5 fallas; el diagnóstico de seguimiento (con specs corregidos, no con
código de producto tocado) aisló cuáles eran artefactos de la técnica de
prueba y cuál es un hallazgo real.

| # | Ataque | Veredicto | Evidencia |
|---|---|---|---|
| 1 | CSP bloquea `<script>` inline inyectado dinámicamente | **CUMPLE** | `window.__pwned` nunca se definió; consola reportó "Refused to execute inline script" real |
| 2 | `eval()`/`new Function()` bloqueados (sin `unsafe-eval`) | **CUMPLE** (con nota metodológica) | Invocar `eval()` DIRECTO dentro de `page.evaluate()` da falso negativo — CDP `Runtime.evaluate` está exento de CSP en Chromium (igual que la consola de DevTools), no es una vulnerabilidad de la app. Repetido con un `<script>` externo real del mismo origen: `eval()`/`new Function()` lanzan correctamente, ninguna variable de prueba llegó a definirse |
| 3 | `connect-src` bloquea origen externo, permite mismo origen | **CUMPLE** | `fetch("https://example.com")` bloqueado por CSP; `fetch("/healthz")` mismo origen → 200 (descarta falso positivo por "sin red") |
| 4 | Subida `.key`/`.exe`/≥50MB rechazada en CLIENTE | **CUMPLE** | Toast de rechazo inmediato en los 3 casos, `POST /company/documents` nunca se disparó (confirmado con intercepción de red) |
| 5 | Mismo caso rechazado en SERVIDOR (defensa en profundidad) | **CUMPLE** | `POST /company/documents` directo (bypaseando el cliente) con `.key`/`.exe` → 422 en ambos, nunca 201 |
| 6 | Logout → caché limpia, sin fuga a otro usuario | **CUMPLE** | Marcador de la sesión del admin nunca apareció en el DOM tras logout ni en la sesión de un usuario completamente distinto, muestreado agresivamente ~1.5s tras el segundo login |
| 7 | `switchOrg` sin fuga entre organizaciones | **CUMPLE** | Alternando 3 veces entre 2 orgs del mismo usuario sin recargar página, el marcador de una org nunca apareció viendo la otra |
| 8 | Guard de botón: doble clic real en "Aprobar" | **PARCIAL — hallazgo nuevo WI-06** | Ver abajo |

### Hallazgo nuevo — WI-06 (BAJA)

Un doble clic **físico real** (dos gestos `page.click()` de Playwright
disparados con `Promise.all`, sin `await` entre ellos — no
`dispatchEvent`/JS sintético) sobre el botón "Aprobar" de una tarifa en
`draft` produce **2 peticiones de red reales** `POST /rates/:id/approve`,
reproducido en 2 corridas independientes. Causa: el guard `disabled=
{isThisRatePending}` (`TarifasAprobadasPage.tsx`) depende de que React haya
re-renderizado tras el primer `mutate()`; cuando ambos clics pasan el chequeo
de "actionability" de Playwright antes de que ese re-render se confirme,
ambos llegan a disparar la mutación. El comentario del commit `a1f70bb`
("cerrando la ventana de doble clic en vez de solo acortarla") **sobreestima
la garantía del lado cliente** para este caso límite de clics verdaderamente
simultáneos. **No es explotable como vulnerabilidad**: las 2 respuestas
observadas fueron siempre `[200, 409]` (confirmado también por el test
oficial `security-wi04-approved-rates-atomic.test.ts` y por el ataque #13 del
sub-agente de `apps/api`) — el servidor sigue siendo la barrera real, sin
duplicar `audit_log` ni re-decidir. Un guard visual `disabled` que sí funciona
correctamente para un clic humano normal (confirmado con retraso de red real
en un test separado que SÍ pasa) queda demostrado insuficiente solo contra un
doble-clic mecánico casi perfectamente simultáneo.

**Reparación sugerida (no implementada)**: agregar un guard adicional
síncrono en el propio `onClick` (p. ej. un `useRef` booleano comprobado y
fijado ANTES de llamar `mutate()`, no solo el `disabled` derivado de
`isPending`), o atenuar el comentario del commit para no prometer un cierre
total de la ventana.

---

## 5. A1–A15 — trazabilidad con el test integrado real

Tabla construida por este agente mediante `grep`/lectura directa de los
archivos de test citados (no por confianza en `docs/ACEPTACION.md`, que el
propio `docs/auditoria-2/api-expediente.md` §7 ya señaló como desactualizado
respecto al HEAD actual — confirmado de nuevo aquí: varios A1-A15 tienen hoy
evidencia HTTP/E2E real que `ACEPTACION.md` sigue marcando PENDIENTE).

| # | Test integrado real (archivo + caso) | Veredicto |
|---|---|---|
| A1 | `apps/api/test/tenders-and-ingest.test.ts` → `it('A1: nueva publicación crea la convocatoria y una versión inicial')` — HTTP real + PGlite real (más fuerte que la versión de `apps/worker/test/discover-tenders-handler.test.ts`, que usa un mock del cliente de ingesta) | **CUMPLE** (integración real con BD, dentro de `apps/api`) |
| A2 | `apps/api/test/tenders-and-ingest.test.ts` → `it('A2: reingestar exactamente la misma versión es un no-op idempotente (0 filas nuevas)')` | **CUMPLE** |
| A3 | `apps/api/test/tenders-and-ingest.test.ts` → `it('A3: una modificación con nueva versión de origen adelanta el plazo, crea evento e invalida dependientes')` — verifica `change-events` + `proposals.invalidated_at` real vía SQL | **PARCIAL** — detección/invalidación real cubiertas; sin notificación al rol responsable (no existe mecanismo de notificación en el repo) ni flujo E2E de UI |
| A4 | Backend: `apps/worker/test/discover-tenders-handler.test.ts` (`describe('...A4: fuente inaccesible...')`, mock de conectores). UI: `apps/web/src/pages/convocatorias/FuentesFrescuraPage.tsx` conectado real a `GET /tenders/sources/freshness` → `app.source_freshness()` (confirmado en código por `web-integrado.md`, ronda 3); ejercitada por `apps/web/e2e/recorrido.spec.ts` (`"Fuentes y frescura: expone los 5 estados..."`, axe real) | **PARCIAL** — backend con mock, UI conectada real pero sin test E2E que asertúe valores reales de `ageSeconds`/estado stale de punta a punta |
| A5 | `apps/web/e2e/ronda3-flujo-real.spec.ts` → `"cambia de organización con el selector real (X-Org-Id)"`; cross-org: `apps/api/test/ronda4-memberships.test.ts`, `ronda4-audit-log.test.ts` (cross-org: nunca filtra), reconfirmado dinámicamente por el sub-agente de esta ronda | **CUMPLE** |
| A6 | `apps/api/test/expediente-documents-and-matrix.test.ts` → `it('A6: dos versiones de bases con plazos distintos... generan un conflicto escalado, y la matriz vieja queda invalidada preservando historial')` | **CUMPLE** |
| A7 | `apps/api/test/company-profile.test.ts` (`'company_documents: documento vencido... (REQ-023, A7)'`), `apps/api/test/matching-and-go-no-go.test.ts` (`'...produce elegibilidad no_cumple... (REQ-023, A7)'`) | **CUMPLE** |
| A8 | `apps/api/test/expediente-proposal.test.ts` → `it('A8: propuesta económica con tarifa NO aprobada se rechaza de punta a punta...')`; `company-profile.test.ts` (`'A8: approved_rates...'`); endurecido por `security-ae01-asofiso-server-derived.test.ts` (AE-01) | **CUMPLE** |
| A9 | Nombrado literalmente solo en `packages/expediente/test/integrity-checklist.test.ts` (`it("A9: marca 'anexos_obligatorios' en rojo...")`, paquete puro) y `packages/expediente/test/expediente-flow.test.ts` (`"A14/A9: ..."`). El mecanismo SÍ se ejercita vía HTTP real en `apps/api/test/expediente-e2e-flow.test.ts`, pero sin un `it()` nombrado literalmente "A9" en `apps/api` | **PARCIAL** — mecanismo probado con HTTP real, sin test nombrado "A9" a nivel de integración de `apps/api` |
| A10 | Ejercitado dentro de `apps/api/test/expediente-e2e-flow.test.ts` (comentario `// A10: cálculo determinista`, sin `it()` propio nombrado "A10"); banda de precio (REQ-030) sigue sin implementar en ningún paquete | **PARCIAL** — cálculo económico determinista cubierto de punta a punta con HTTP real; banda de precio (REQ-030) PENDIENTE |
| A11 | `apps/api/test/expediente-checklist-and-approval.test.ts` → `it('A11: cambiar un insumo real... invalida la aprobación automáticamente')`; reforzado por `security-ae02-section-edit-invalidates-approval.test.ts` (AE-02), `security-ae08-full-profile-hash.test.ts` (AE-08), `security-ae11-record-edit-blocks-self-approval.test.ts` (AE-11) — el ítem con MÁS cobertura cruzada de todo el lote tras ronda 4 | **CUMPLE** |
| A12 | `apps/api/test/expediente-checklist-and-approval.test.ts` → `it('A12: writer no puede aprobar... autoaprobación... prohibida...')`; `apps/web/e2e/ronda3-flujo-real.spec.ts` → `"recibe un 403 honesto de la API al entrar a back office (no es superadmin)"`, `"propone una tarifa, que queda en borrador (no puede aprobarla)"` | **CUMPLE** (rechazo de rol indebido, API+UI); passkey/OTP de re-autenticación (REQ-064) sigue sin implementar — gap ya declarado, no nuevo |
| A13 | `apps/api/test/expediente-package-and-submission.test.ts` → `it('A13: expediente completo... ensambla "ready" y el ZIP se relee con el manifiesto correcto')` — HTTP real, ZIP releído con `jszip` | **CUMPLE** a nivel API; **sin cobertura integrada** de descarga autenticada real desde `apps/web` (`PaqueteDescargablePage` aún no tiene enlace de descarga conectado, confirmado en `web-integrado.md` rubro 6) |
| A14 | `apps/api/test/expediente-package-and-submission.test.ts` → `it('A14: expediente incompleto... nunca ensambla "ready"...')`; `security-ae14-package-status-re-derived.test.ts` (AE-14, re-derivación); `apps/web` W-16 (`package-status-badge` + `test`) y `apps/web/e2e/recorrido.spec.ts` | **CUMPLE** (API + UI, ambos lados) |
| A15 | `apps/api/test/expediente-package-and-submission.test.ts` → `it('A15: submissions solo registra la declaración del usuario... nunca envía nada...')`; `packages/expediente/test/api-surface.test.ts` | **CUMPLE** |

---

## 6. Veredicto por hallazgo

| ID | Severidad | Veredicto | Nota | Estado reparación |
|---|---|---|---|---|
| AE-08 | MEDIA (original) | **CERRADO** | Confirmado dinámicamente con signatories/capabilities y también con products-services/locations/registrations/restrictions | |
| AE-11 | BAJA (original) | **CERRADO** | Writer que edita y luego aprueba (promovido) → 403 real; tercero sin relación sí aprueba | |
| AE-14 | MEDIA (original) | **CERRADO** | `/latest` re-deriva a draft, `/download` 409 explícito, nunca sirve el ZIP viejo | |
| API-14 | BAJA/MEDIA (original) | **CERRADO** | Sin vector HTTP de forja; mecanismo SQL confirmado, `login_failed` sin regresión | |
| AE-15 | BAJA (original) | **CERRADO** | 413/422 confirmados con body real de ~23MB y 33MB | |
| WI-01 (API) | MEDIA (original) | **CERRADO** | CSP/Permissions-Policy/Referrer-Policy en 2xx/4xx/5xx reales | |
| WI-01 (web) | MEDIA (original) | **CERRADO** | Script inline bloqueado con violación real de consola; `connect-src` bloquea origen externo; eval bloqueado (confirmado con metodología corregida) | |
| WI-02 | MEDIA (original) | **CERRADO** | `.key`/`.exe`/≥50MB rechazados en cliente Y servidor, con defensa en profundidad confirmada | |
| WI-03 | BAJA/MEDIA (original) | **CERRADO** | Logout limpia caché sin residuo visible de sesión anterior; `switchOrg` sin fuga | |
| WI-04 (API) | BAJA (original) | **CERRADO** | 1×200+1×409 en 5 repeticiones concurrentes reales, 1 sola fila de `audit_log` | |
| WI-04 (web) | BAJA (original) | **PARCIAL** | Guard visual funciona para clic humano normal; NO cierra la ventana ante doble clic físico verdaderamente simultáneo (ver WI-06 nuevo). Sin impacto de seguridad real (servidor idempotente lo cubre) | |
| WI-05 | BAJA (original) | **CERRADO** | `test:e2e:full` determinista en 2/2 corridas reales, 98 passed cada vez | |
| **API-15** (nuevo) | BAJA | **NO CERRADO** (nunca reparado) | `POST /company/rates/:id/approve\|reject` rechazan cuerpo vacío con 400 en vez de ejecutar (documentadas como "sin cuerpo"); no explotable, regresión de robustez no propagada desde el patrón de ronda 4 | **REPARADO** — `withOptionalEmptyJsonBody` aplicado a ambas rutas (`apps/api/src/modules/company/routes.ts`); `fastify.inject` con `Content-Type: application/json` vacío y sin cuerpo → 200, nunca 400 (`apps/api/test/ronda4-empty-body.test.ts`). Ver `docs/logs/fix-api15-wi06.log` |
| **WI-06** (nuevo) | BAJA | **NO CERRADO** (nunca reparado) | Doble clic físico real en "Aprobar" dispara 2 peticiones (el guard cliente no gana la carrera); servidor sigue siendo la barrera real, sin duplicar efecto ni auditoría | |

**Ningún hallazgo CRÍTICO ni ALTA. Ninguna fuga cross-tenant nueva. Ningún
hallazgo de ronda 4 declarado "RESUELTO" resultó, en esta reverificación,
NO CERRADO** — los 12 hallazgos de ronda 4 (AE-08/11/14, API-14, AE-15,
WI-01..05) quedan **CERRADOS**, con la única salvedad matizada de WI-04(web)
(PARCIAL, impacto nulo). Los 2 hallazgos nuevos (API-15, WI-06) son de
severidad BAJA, no explotables, y quedan documentados para una ronda futura.

---

## 7. Candidatos a CUMPLIDO para el orquestador (no se edita `ACEPTACION.md`)

Recomendación de este agente, para que el orquestador decida y actualice
`docs/ACEPTACION.md` bajo su propio criterio (fuera del alcance de escritura
de esta auditoría):

**`apps/api`**:
- AE-08, AE-11, AE-14, API-14, AE-15 (ronda 4): código + test dedicado +
  reverificación dinámica independiente CERRADA, sin PARCIAL/NO CERRADO
  relacionado → candidatos a CUMPLIDO.
- WI-01 (lado API), WI-04 (lado API): mismo criterio → candidatos a
  CUMPLIDO.
- A1, A2, A6, A8, A11, A12 (parcial, ver nota), A15: tienen test integrado
  real con HTTP+PGlite nombrado explícitamente y reverificación adversarial
  sin hallazgos abiertos relacionados → candidatos a CUMPLIDO (dejar A12
  como CUMPLIDO **parcial**/anotado, porque REQ-064 — passkey/OTP — sigue
  PENDIENTE dentro del mismo criterio de aceptación).

**`apps/web`**:
- WI-01, WI-02, WI-03, WI-05: código + test E2E dedicado + reverificación
  dinámica independiente CERRADA → candidatos a CUMPLIDO.
- WI-04 (lado web): dejar en **EN_EVIDENCIA** (no CUMPLIDO), por el matiz
  PARCIAL de WI-06 — el guard cliente no cierra la ventana ante doble clic
  físico simultáneo, aunque sin impacto de seguridad real.
- A5, A14: candidatos a CUMPLIDO (cobertura API+UI consistente, sin
  hallazgos abiertos).

**No candidatos a CUMPLIDO todavía** (gaps ya conocidos, no reabiertos por
esta ronda, pero que impiden marcar CUMPLIDO bajo el criterio estricto de
`ACEPTACION.md`): A3 (sin notificación al rol responsable), A4 (backend con
mock, sin E2E de valores reales), A7 (depende de EX-EXP-04/13, fuera de
alcance de esta ronda), A9/A10 (sin test nombrado en `apps/api` / banda de
precio REQ-030 pendiente), A13 (sin descarga autenticada real desde
`apps/web`), API-15 y WI-06 (nuevos, sin reparar).

---

## 8. Conteos finales

- Suites oficiales: **180 (apps/api) + 156 (packages/db) + 79 (apps/web
  unit) + 298 (apps/worker) = 713 tests, todos verdes**; `typecheck`/`lint`
  limpios en los 4 paquetes.
- `test:e2e:full`: **98 + 98 = 196 tests E2E pasados en 2 corridas
  independientes, 0 fallas, 0 flakies, determinista**.
- Ataques dinámicos nuevos de esta ronda: **13 categorías en `apps/api`**
  (con sub-ataques: 6 repeticiones de concurrencia, 8-10 rutas de cabeceras,
  10+ rutas de cuerpo vacío) **+ 8 categorías en `apps/web`** (11 specs
  Playwright reales contra Chromium, 2 rondas) **≈ 60+ aserciones
  dinámicas individuales**, todas con evidencia HTTP/navegador real.
- Hallazgos de ronda 4 reverificados: **12/12 CERRADOS** (11 sin matiz, 1
  con matiz PARCIAL de impacto nulo — WI-04 web).
- Hallazgos nuevos de esta reverificación: **2** (API-15 BAJA, WI-06 BAJA),
  ninguno explotable, ambos con reparación sugerida no implementada (rol de
  este agente es solo encontrar/verificar).

**Ningún hallazgo CRÍTICO ni ALTA. Ninguna fuga cross-tenant. Sistema
consistente con lo declarado en `apps/api/README.md`/`apps/web/README.md`
para la ronda 4.**
