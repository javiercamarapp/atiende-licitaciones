# Reverificación adversarial de `docs/auditoria-2/api-expediente.md` (AE-01..13) y DB-13/API-13

**Fecha**: 2026-09-06. **Agente**: reverificador adversarial Sonnet, contexto
independiente del proyecto, sin participación en la construcción ni en la
reparación de los hallazgos citados. Rol: **SOLO encuentra y verifica** —
ningún código de `apps/api`/`packages/db` fue modificado por este agente ni
por los 3 sub-agentes Sonnet (`model="sonnet"` explícito) que repartieron
rubros.

**Metodología**: `git worktree add <scratch>/reverify-api2 HEAD` (HEAD real
al iniciar: `b5e4303`) + `npm install` real para ancestría/suites oficiales/
regresión; 3 worktrees adicionales (`reverify-api2-sub1/2/3`, HEAD `348a456`
tras 2 commits docs-only concurrentes de otro agente, ninguno toca
`apps/api`/`packages/db`) para 3 sub-agentes Sonnet, cada uno con `npm
install` propio, que escribieron tests adversariales temporales
(`apps/api/test/zz-adversarial-reverify-sub{1,2,3}.test.ts`,
`packages/db/test/zz-adversarial-reverify-sub3.test.ts`), los ejecutaron con
`fastify.inject`/PGlite (mismo patrón que la suite oficial) y los
**borraron** al terminar — `git status --short` confirmado limpio en los 4
worktrees salvo `package-lock.json` (modificación preexistente del propio
`npm install`). Nunca se usó `git reset`/`checkout <commit>`/`stash`/
`rebase`/`commit --amend`/`add -A` en el repo principal. Los 4 worktrees se
eliminan al cierre. Evidencia completa de comandos en
`docs/logs/reverify-api-auditoria2.log`.

Documentos base leídos: `docs/auditoria-2/api-expediente.md` (columna
"Estado reparación"), `docs/auditoria-1/db-api-seguridad-reverificacion.md`
(DB-13/API-13), `apps/api/README.md`, migraciones `0050`-`0051` de
`packages/db`.

---

## Resumen ejecutivo

**Los 10 commits citados son reales, ancestros lineales de HEAD, y hacen
exactamente lo que declaran** (`git merge-base --is-ancestor` + `git show
--stat` para cada uno, ver §1). **Las suites oficiales reproducen
exactamente los conteos declarados**: `apps/api` 121/121 (36 archivos),
`packages/db` 147/147 (20 archivos), `typecheck`/`lint` limpios en ambos.
**Regresión confirmada limpia**: `apps/web typecheck` y `apps/worker
typecheck`+`test` (298/298) en verde.

De los 46 ataques dinámicos nuevos ejecutados por 3 sub-agentes (todos con
evidencia HTTP/SQL real, no solo lectura de código), **AE-01, AE-03, AE-04,
AE-05, AE-09, AE-10, DB-13 y API-13 (el mecanismo central) quedan
confirmados como RESUELTOS**, sin huecos nuevos pese a vectores adicionales
(offset de firma, políglotas reales PDF/ZIP construidos con `pdf-lib`/
`jszip`, zip-bomb 1004:1 medido, ZIP anidado, 10k entradas, entidades HTML,
fronteras exactas de zona horaria/régimen legal/fin de semana, escala real
de 10,000 entradas de caché, suplantación de `p_user_id` comparada contra
`create_refresh_token`). **AE-02 está correctamente reparado en su mecanismo
central** (edición de sección invalida la aprobación, coexiste sin pisarse
con `conditionEvaluations`, aislamiento cross-tender intacto), **pero la
investigación reveló una laguna real, no cubierta por el fix original**:

- **AE-14 (nuevo, MEDIA)**: tras invalidar una aprobación por edición de
  sección, `GET /package/latest` y `GET /package/download` **no se
  re-derivan** — siguen sirviendo `status:"ready"` y el mismo ZIP en bytes
  hasta que alguien vuelve a llamar `POST /package/assemble` explícitamente.

Dos hallazgos adicionales, ambos de severidad acotada:

- **AE-15 (nuevo, BAJA, documental/informativo, NO explotable
  ofensivamente)**: el límite de subida real es **1MB** (default de
  Fastify, `bodyLimit` nunca configurado en `apps/api/src/app.ts`), no los
  "~22MB" que `apps/api/src/lib/storage.ts:26` documenta y valida
  explícitamente — el efecto neto es MÁS restrictivo, pero la
  documentación/comentarios quedan desalineados con el comportamiento real.
- **API-14 (nuevo, BAJA/MEDIA, matiz de diseño ya parcialmente reconocido
  por el propio equipo)**: `app.record_auth_event` (migración `0051`)
  acepta un `p_actor_id uuid` como parámetro explícito del llamador **sin**
  compararlo contra `app.current_user_id()` (a diferencia de
  `app.create_refresh_token`, que sí exige coincidencia) — un ataque real
  confirmó que, con sesión de un usuario A, es posible insertar en
  `audit_log` un evento `auth.logout` atribuido a un usuario B real
  distinto. Mitigado hoy porque el único llamador en todo el repo
  (`apps/api/src/lib/audit.ts` → `recordAuthAudit`, invocado solo desde
  `auth/routes.ts`) siempre pasa un `actorId` ya verificado por el servidor
  — el propio `security-definer-audit.test.ts` ya documenta y acepta
  conscientemente esta propiedad.

**Ningún hallazgo CRÍTICO ni fuga cross-tenant nueva.**

---

## 1. Ancestría y contenido de los 10 commits

```
f2fef8a fix(api): AE-01 - asOfIso ya no lo decide el cliente, se deriva de submission_deadline
6c43174 fix(api): AE-02 - editar contenido de sección aprobada invalida la aprobación
3532308 fix(api): AE-09 - calendarNote y legalRegime (REQ-050) en plazo de pago
2170bf3 fix(api): AE-03/AE-05 - magic bytes en todo el buffer; rechaza ZIP (anti zip-bomb)
622dbe2 fix(api): AE-04 - sanitiza HTML/script del texto extraído; anti PDF-bomb
6534f5f fix(api): AE-10 - caché de contexto de agent_run con límite de tamaño (LRU)
d4788fe docs(api): AE-12 - corrige conteo de rutas de /expediente (26)
f8ffaa6 fix(db): DB-13 - vigencia de tarifa evaluada siempre en America/Mexico_City
e097c27 fix(api,db): API-13 - eventos de autenticación quedan en audit_log
668a082 fix(db): API-13 -- registra app.record_auth_event en la lista blanca de SECURITY DEFINER
```

Los 10: `git merge-base --is-ancestor <hash> HEAD` → **sí**, cadena de
timestamps consistente (2026-09-06 01:45–02:40). `git show --stat` de cada
uno confirma que los archivos tocados coinciden exactamente con lo
declarado: migraciones SQL nuevas + tests nuevos + cambios quirúrgicos en
`routes.ts`/`lib/*.ts` (nunca reescrituras masivas que podrían esconder
algo). Detalle línea por línea en `docs/logs/reverify-api-auditoria2.log`
§1.

**Veredicto: CUMPLE.**

---

## 2. Suites oficiales y regresión

| Comando | Resultado |
|---|---|
| `npm run -w apps/api typecheck` | exit 0 |
| `npm run -w apps/api lint` | exit 0 |
| `npm run -w apps/api test` | **121/121, 36/36 archivos** |
| `npm run -w packages/db typecheck` | exit 0 |
| `npm run -w packages/db lint` | exit 0 |
| `npm run -w packages/db test` | **147/147, 20/20 archivos** |
| `npm run -w apps/web typecheck` | exit 0 |
| `npm run -w apps/worker typecheck` | exit 0 |
| `npm run -w apps/worker test` | **298/298, 11/11 archivos** |

**Veredicto: CUMPLE.** Conteos exactos coinciden con lo declarado en el
encargo (api 121, db 147); regresión limpia en `apps/web`/`apps/worker`.

---

## 3. Ataques por hallazgo

### AE-01 (`asOfIso` server-derived)

| # | Ataque | Veredicto | Evidencia |
|---|---|---|---|
| 1 | `asOfIso` en body con fecha favorable al atacante | CUMPLE | `resolveExpedienteAsOfIso` (`apps/api/src/lib/expediente/dates.ts:63-73`) nunca lee `tender.asOfIso` |
| 2 | `asOfIso` en query string / header custom | CUMPLE (vector no existe) | grep confirma 0 lecturas fuera de `request.body`, y ese único lugar se ignora |
| 3 | Tender sin `submission_deadline` | CUMPLE | 422 explícito en `technical/generate`, `economic/generate`, `checklist/run` |
| 4 | Deadline de versión antigua vs. vigente | CUMPLE | `tenders.submission_deadline` fresco en cada request (`requireTender`), sin caché |
| 5 | Frontera 23:59 MX vs. UTC | CUMPLE | Comparación por instante absoluto (`isPast`, `packages/expediente/src/types.ts:181-185`); `valid_until` anclado a fin de día MX (`dateOnlyToMexicoCityIso`, `dates.ts:26-30`); frontera exacta probada (2030-01-16T00:00:00Z no vencida vs. 2030-01-16T06:00:00Z sí vencida) |

**Veredicto: RESUELTO, sin huecos nuevos.**

### AE-02 (edición de sección invalida aprobación)

| # | Ataque | Veredicto | Evidencia |
|---|---|---|---|
| 6 | Editar A→X→A (revertir al original) | MATIZ (no vulnerabilidad, fail-safe) | `contentChanged` compara contra el ÚLTIMO guardado, no un baseline histórico — la reversión también invalida (sobre-invalida, no sub-invalida) |
| 7 | Editar sección de otro tender/propuesta | CUMPLE | 404, filtro por `proposal_id` derivado de `tenderId` intacto |
| 8 | `conditionEvaluations` tras invalidación por sección | CUMPLE | Ambos mecanismos coexisten sin pisarse ni duplicar eventos (`ApprovalWorkflow.recordChange` solo afecta aprobaciones "vigente") |
| 9 | Paquete "ready" → editar sección → `/package/latest`/`download` | **FALLA — AE-14 (nuevo, MEDIA)** | Ver hallazgo abajo |

**Veredicto: mecanismo central RESUELTO; laguna nueva no cubierta por el fix original (AE-14).**

### AE-03/AE-04/AE-05 (subida de documentos)

| # | Ataque | Veredicto | Evidencia |
|---|---|---|---|
| 1 | `%PDF-` en offset 512 | CUMPLE (matiz de diseño documentado) | Con `%%EOF` → 201 correcto; sin `%%EOF` → 422; offset 2000 (fuera de la ventana de 1024 bytes) no activa la validación de estructura, pero la defensa contra ejecutables/ZIP/PEM sigue aplicando en TODO el buffer sin ventana |
| 2 | Políglota PDF/ZIP real (construido y verificado abrible como ambos formatos) | CUMPLE | 422 en ambas direcciones de concatenación, por `containsSignatureAnywhere` detectando `PK\x03\x04` en cualquier posición |
| 3 | ZIP ratio 1004:1 (medido, no simulado) | CUMPLE | 422 en 1.8ms, rechazo por firma antes de cualquier descompresión |
| 4 | ZIP anidado 3 niveles | CUMPLE | 422 en 1.1ms, sin recursión |
| 5 | ZIP con 10,000 entradas | CUMPLE (con hallazgo AE-15) | Rechazado por `bodyLimit` de Fastify (1MB) antes de llegar al validador de firma; con 5,000 entradas (bajo 1MB) → 422 rápido por firma |
| — | `<img onerror>` en texto plano | CUMPLE | `sanitizePlainText` (regex genérico `/<[^>]+>/g`) elimina cualquier etiqueta con atributos |
| — | Entidades HTML ya escapadas | CUMPLE | Se conservan literalmente, nunca se decodifican a HTML vivo |
| — | Markdown con `javascript:` URI | FUERA DE ALCANCE (correcto) | Sanitización solo opera sobre `<...>`, no sintaxis markdown — responsabilidad de un eventual renderer del frontend |
| — | Propagación a `GET /matrix` | CUMPLE | Texto sanitizado en la respuesta JSON real, sin script/onerror |

**Veredicto: RESUELTO, con un hallazgo documental nuevo (AE-15, BAJA).**

### AE-09 (calendarNote / legalRegime)

| # | Ataque | Veredicto | Evidencia |
|---|---|---|---|
| 10 | Frontera exacta de régimen legal (`published_at` <, =, > fecha de vigor) | CUMPLE | Inclusivo correcto (`business-days.ts:71`) |
| 11 | `invoiceVerifiedOn` en viernes | CUMPLE | `dueDate` no cae en fin de semana, `calendarNote` presente |
| 12 | `holidays` explícitos en el body | CUMPLE | Campo existe (`schemas.ts:270`) y excluye esos días del cómputo real |

**Veredicto: RESUELTO, sin huecos nuevos.**

### AE-10 (BoundedCache)

| # | Ataque | Veredicto | Evidencia |
|---|---|---|---|
| 13 | Fake timers, salto de 10 años sin acceso | MATIZ confirmado (no nuevo) | `BoundedCache` es LRU puro por tamaño, sin TTL real — ya documentado explícitamente en el propio código |
| 14 | Escala real (10,000 + 50 inserciones) | CUMPLE | `RUN_CONTEXT_CACHE_MAX_ENTRIES=10_000` (`agent-stores.pg.ts:14`), nunca supera el límite, LRU expulsa exactamente las 50 más antiguas |

**Veredicto: RESUELTO tal como fue diseñado (LRU por tamaño, no TTL — límite ya declarado, no oculto).**

### DB-13 (zona horaria de vigencia de tarifas)

| # | Ataque | Veredicto | Evidencia |
|---|---|---|---|
| 1-2 | Mismo escenario del hallazgo original bajo sesión `UTC`, `Asia/Tokyo` y `America/Mexico_City` explícito | CUMPLE | 3/3 veredictos idénticos (aceptado); `0050_fix_db13_rate_validity_timezone.sql:63-66` |
| 3 | Fallback `now()` (sin `submission_deadline`) | CUMPLE | También envuelto en `at time zone 'America/Mexico_City'` (línea 65), confirmado con SQL real bajo UTC/Tokyo |
| 4 | Caso base de la migración 0042 (sin regresión) | CUMPLE | Tarifa vencida antes del acto sigue rechazada |

**Veredicto: RESUELTO, sin huecos nuevos.**

### API-13 (auditoría de eventos de autenticación)

| # | Ataque | Veredicto | Evidencia |
|---|---|---|---|
| 5 | Login fallido, contraseña nunca en `audit_log` | CUMPLE | 4 variantes adversariales (unicode/comillas/backslash/emoji), TODAS las columnas inspeccionadas |
| 6 | Reuso de refresh → familia revocada | CUMPLE, con MATIZ menor | Efecto real confirmado (2ª sesión también revocada); `after` solo trae `{ip, userAgent}`, la revocación de familia se infiere del nombre de la `action`, no de un campo explícito |
| 7 | Logout, token/jti/hash nunca expuestos | CUMPLE | — |
| 8 | Invitación aceptada | Ya auditado (mecanismo preexistente, `invitation.accept`) | Fuera del alcance declarado de API-13, funcionando sin regresión |
| 9 | Cambio de rol de membresía | Ya auditado (`membership.change_role`) | Sin regresión tras 0050/0051 |
| 10 | `app.record_auth_event`: ¿acepta `user_id` externo? ¿quién puede ejecutarla? | **Ver hallazgo API-14 (nuevo)** | Ver abajo |

**Veredicto: mecanismo central RESUELTO; matiz de diseño nuevo documentado (API-14).**

---

## 4. Hallazgos nuevos (AE-14+)

| ID | Severidad | Hallazgo | Evidencia | Estado |
|---|---|---|---|---|
| **AE-14** | **MEDIA** | Tras invalidar una aprobación de alcance "expediente" por edición de sección (AE-02), `GET /expediente/tenders/:tenderId/package/latest` y `GET /expediente/tenders/:tenderId/package/download` **no se re-derivan**: siguen reportando `status:"ready"` y sirviendo el MISMO ZIP en bytes (`Buffer.compare === 0` confirmado) que antes de la edición, hasta que alguien vuelve a invocar `POST /package/assemble` explícitamente. Un usuario que solo consulte `/latest` o descargue el ZIP después de una edición de última hora ve/obtiene un paquete "ready" desactualizado sin ninguna señal de que dejó de reflejar el estado aprobado. | `apps/api/src/modules/expediente/package.routes.ts:97-137` (`/latest` y `/download` solo hacen `select * from package_manifests ... order by generated_at desc limit 1`, sin recalcular contra `isFullyApprovedForCurrentHash`/hash de insumos actual); confirmado con test real por sub-agente 1 (flujo completo: ready → editar sección → `/latest` sigue "ready" → nuevo `/assemble` sí corrige a "draft"). | **RESUELTO (ronda 4)** — `deriveCurrentManifest` (nuevo helper en `package.routes.ts`) recalcula el `PackageManifest` real contra el estado vivo de la base de datos (mismos insumos que un nuevo `assemble`), sin escribir ZIP ni fila (una lectura nunca tiene efectos de escritura). Solo se re-deriva cuando el ÚLTIMO `assemble` había quedado "ready" (un paquete que nació "draft" sigue igual, sin regresión de A14). `GET /package/latest` reporta siempre el estado recién derivado; `GET /package/download` responde 409 explícito (`ConflictError`, ahora con `detail` opcional) en vez de servir el ZIP "ready" viejo. Test: `apps/api/test/security-ae14-package-status-re-derived.test.ts`. Commit `1b73639`. |
| **AE-15** | BAJA (documental, no explotable ofensivamente) | `apps/api/src/lib/storage.ts:26` documenta `MAX_BASE64_LENGTH=30_000_000` ("~22MB decodificado"), pero `apps/api/src/app.ts:41` construye Fastify sin pasar `bodyLimit`, por lo que aplica el DEFAULT de Fastify (1,048,576 bytes = 1MB) sobre el cuerpo completo de la petición — el límite de "~22MB" documentado y validado explícitamente en `storage.ts` nunca es alcanzable en la práctica; cualquier documento legítimo >~700KB reales es rechazado con un 413 genérico de framework antes de llegar a la validación de contenido. | Confirmado con un ZIP de 947,802 bytes (base64 ≈1.26MB) → 413 "Request body is too large" antes de `assertSafeFileContent`; grep confirma ausencia de `bodyLimit` en `Fastify({...})` (`apps/api/src/app.ts:41`). | **RESUELTO (ronda 4)** — `app.ts` fija `bodyLimit: MAX_BASE64_LENGTH + 2_000_000` (~32MB) al construir Fastify, coherente con el límite real documentado (`MAX_BASE64_LENGTH`, exportado desde `lib/storage.ts` para no duplicar el número). Test: `apps/api/test/security-ae15-body-limit.test.ts` (un cuerpo de 5MB ya no se rechaza por tamaño; uno por encima del límite configurado responde 413 explícito). Commit `12189a3`. |
| **API-14** | BAJA/MEDIA (matiz de diseño, ya parcialmente reconocido por el equipo) | `app.record_auth_event` (`packages/db/migrations/0051_fix_api13_auth_audit_log.sql:29-45`) acepta `p_actor_id uuid` como parámetro explícito del llamador **sin** compararlo contra `app.current_user_id()` cuando este último SÍ está fijado (a diferencia de `app.create_refresh_token`, que exige coincidencia exacta). Ataque real confirmado: con sesión autenticada como usuario A, invocar `app.record_auth_event('auth.logout', <userId_B>, ...)` inserta exitosamente una fila de `audit_log` atribuida al usuario B real. Mitigante existente: la FK `audit_log_actor_id_fkey` rechaza un UUID inventado (usuario inexistente), pero permite cualquier usuario REAL como actor suplantado. Hoy inalcanzable vía HTTP porque el único llamador en todo el repo (`apps/api/src/lib/audit.ts:71` → `recordAuthAudit`, invocado solo desde `apps/api/src/modules/auth/routes.ts`, 5 sitios) siempre pasa un `actorId` ya verificado por el servidor (JWT firmado, contraseña validada, o `null` para intentos no autenticados). | `packages/db/migrations/0051_fix_api13_auth_audit_log.sql:29-45` (firma completa); `packages/db/test/security-definer-audit.test.ts:70-71` (el propio equipo ya documenta y acepta conscientemente esta propiedad, razonando sobre el único llamador actual); confirmado con test SQL real por sub-agente 3 (suplantación exitosa + contraste directo con `create_refresh_token` que sí rechaza). | **RESUELTO (ronda 4)** — `packages/db/migrations/0054_fix_api14_auth_audit_actor_match.sql` exige exactamente lo sugerido: `p_actor_id` debe coincidir con `app.current_user_id()` ya fijado, salvo para `auth.login_failed` (el único evento genuinamente pre-sesión). `apps/api/src/modules/auth/routes.ts` se actualiza para fijar `app.current_user_id()` con el `user_id` ya verificado antes de auditar `refresh_succeeded`/`refresh_reuse_detected`/`logout` (los 3 sitios que hasta ahora nunca lo fijaban). Test de ataque real: `packages/db/test/security-api14-auth-audit-actor-match.test.ts` (un actor con sesión propia NO puede forjar `login_succeeded`/`logout`/`refresh_*` atribuidos a otro usuario; `login_failed` sigue funcionando sin sesión previa, con o sin actor conocido). Commit `a47c287`. |

---

## 5. Trazabilidad — nombre del test por cada ataque (A6-A15)

Sin cambios respecto a lo ya confirmado en `docs/auditoria-2/api-expediente.md`
§7 (tabla A6-A15) — esta reverificación no re-auditó la trazabilidad
completa de A6-A15 porque no fue objeto de ningún commit de reparación en
esta ronda (ninguno de los 10 commits citados toca esa tabla). Se confirma
que los tests nombrados allí (`expediente-documents-and-matrix.test.ts`,
`company-profile.test.ts`, `matching-and-go-no-go.test.ts`,
`expediente-proposal.test.ts`, `expediente-e2e-flow.test.ts`,
`expediente-checklist-and-approval.test.ts`, `expediente-package-and-submission.test.ts`)
siguen presentes y en verde en la suite de 121 tests (§2). Los nuevos tests
oficiales de esta ronda (`security-ae01-asofiso-server-derived.test.ts`,
`security-ae02-section-edit-invalidates-approval.test.ts`,
`security-ae03-ae05-magic-bytes-fullscan-zip.test.ts`,
`security-ae04-sanitize-extracted-text.test.ts`,
`security-ae09-payment-deadline-calendar-and-regime.test.ts`,
`security-ae10-bounded-cache.test.ts`, `security-api13-auth-audit-log.test.ts`,
`security-db13-rate-validity-timezone.test.ts`) refuerzan A8/A11 sin abrir
ningún nuevo criterio A6-A15.

---

## 6. Balance de `apps/api`

De los 13 hallazgos originales de `docs/auditoria-2/api-expediente.md`:
- **RESUELTO y reverificado sin huecos**: AE-01, AE-03, AE-04, AE-05, AE-09,
  AE-10, AE-12.
- **RESUELTO en su mecanismo central, con laguna nueva no cubierta por el
  fix**: AE-02 (ver AE-14).
- **FUERA DE ALCANCE del corrector** (viven en `packages/expediente` o son
  tarea del orquestador, no reabiertos por esta reverificación): AE-06,
  AE-07, AE-13.
- **PENDIENTE, sin cambios** (fuera del encargo de reparación de esta
  ronda): AE-08, AE-11.

De `docs/auditoria-1/db-api-seguridad-reverificacion.md`:
- **RESUELTO y reverificado sin huecos**: DB-13, y el mecanismo central de
  API-13.
- **Matiz de diseño nuevo, no una regresión de lo reparado**: API-14 (ver
  §4).

**Total de hallazgos nuevos de esta reverificación: 3** (AE-14 MEDIA, AE-15
BAJA, API-14 BAJA/MEDIA). **Ningún hallazgo CRÍTICO ni fuga cross-tenant
nueva.** 46 ataques dinámicos ejecutados con evidencia real (HTTP/SQL),
0 regresiones en `apps/web`/`apps/worker`.

**Adenda ronda 4 (docs/logs/api-ronda4.log)**: los 5 pendientes de este
documento y de `docs/auditoria-2/api-expediente.md` asignados a `apps/api`
quedan **RESUELTOS** con test rojo→verde y commit dedicado por ítem:
AE-08 (`9064469`), AE-11 (`e30e41c`), AE-14 (`1b73639`), AE-15 (`12189a3`),
API-14 (`a47c287`). Ver el detalle de cada uno en su fila de la tabla
correspondiente (§4 de este documento, o la tabla principal de
`api-expediente.md` para AE-08/AE-11).
