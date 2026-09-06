# Auditoría adversarial ronda 5 — `apps/api` (2FA/step-up, E11 calendario oficial, correlation-id, procedencia, aviso de privacidad)

Fecha: 2026-09-06. Agente: auditor adversarial independiente, contexto
separado del proyecto. Rol: **SOLO encuentra/verifica** — ningún código de
`apps/api`, `packages/db`, `apps/web` ni `apps/worker` fue modificado por
este agente.

**Metodología**: `git worktree add <scratchpad>/audit-api5 HEAD` (HEAD real
al iniciar: `6dab9f3`) + `npm install` real; el árbol principal nunca se
tocó con comandos destructivos ni de escritura de código. Se reprodujeron
de forma independiente `typecheck`/`lint`/`test` de `apps/api`,
`packages/db`, `packages/expediente`, y `typecheck` de `apps/web` +
`typecheck`/`test` de `apps/worker`. Para verificar comportamiento real (no
solo lectura de código) se escribieron 3 pruebas adversariales temporales
(`apps/api/test/_audit-probe-*.test.ts`), ejecutadas con `fastify.inject` +
PGlite y **borradas** al terminar — `git status --short` del worktree
confirmado limpio salvo `package-lock.json`/`node_modules` (subproducto de
`npm install`, no de este agente) antes de eliminarlo. Evidencia de comandos
reales en `docs/logs/audit-api-ronda5.log`.

Documentos base leídos: `apps/api/docs/e11-cobertura.md`, `apps/api/README.md`
(secciones ronda 5: 2fa, legal, admin/calendar-holidays, post-award),
migraciones `0055`-`0057` de `packages/db`, `docs/logs/api-ronda5.log`,
`docs/REQUISITOS.md` (REQ-044/064, REQ-050/056, REQ-119/131, REQ-142,
REQ-171), `docs/legal/verificacion-legal.md`, `docs/TABLERO.md`,
`docs/BACKLOG.md`, diff completo de los commits `53427ff` (2FA),
`234eb54` (aviso de privacidad) y `1025978`/`480d691`/`67394d8` (rondas
previas de esta misma sesión: procedencia, E11, correlation-id).

---

## Resumen ejecutivo

La ronda 5 reproduce limpio (200 tests `apps/api` / 158 `packages/db` / 413
`packages/expediente`, typecheck y lint sin errores en las tres áreas, más
`apps/web` typecheck y `apps/worker` typecheck+test — 298 tests — también
limpios) y el diseño de 2FA/step-up, procedencia (REQ-142) y
`X-Correlation-Id` (REQ-171) es en su mayoría sólido y consistente con lo
que el README declara. Sin embargo, esta ronda encuentra **dos hallazgos
CRÍTICOS** verificados con reproducción real (no solo lectura de código):

- **R5-01 (CRÍTICA)**: el calendario oficial de días inhábiles
  (`calendar_holidays`, la pieza nueva de REQ-050/056) **nunca afecta el
  cómputo real del plazo de pago** por un bug de conversión de fecha —
  y la API **miente activamente** en `calendarNote` diciendo que el feriado
  "fue incluido en el cómputo" cuando no lo fue.
- **R5-02 (CRÍTICA)**: los endpoints de verificación TOTP
  (`/auth/2fa/step-up`, `/auth/2fa/verify-enrollment`, `/auth/2fa/enroll`)
  **no tienen ningún límite de tasa específico** anti-fuerza-bruta — solo
  heredan el límite global de 300 req/min por IP, verificado con 40
  intentos consecutivos de código incorrecto sin un solo 429.

Además: intentos fallidos de 2FA no dejan rastro en `audit_log` (R5-03,
MEDIA); la traza "de extremo a extremo desde la convocatoria" de REQ-171 en
realidad nunca incluye el paso de ingesta/descubrimiento (R5-04, MEDIA);
`step_up_sessions` no está ligado a una acción/organización específica
(R5-05, BAJA-MEDIA, diseño discutible más que defecto); y tres hallazgos
BAJA (esquema de URL sin restringir a http/https, fecha calendario inválida
produce 500 en vez de 422, documentación de seguimiento de épicas
desactualizada). Ningún hallazgo compromete aislamiento multi-tenant ni
control de roles, que se reprodujeron intactos.

---

## Hallazgos

### R5-01 (CRÍTICA) — `calendar_holidays` cargado NUNCA excluye el día real del plazo; `calendarNote` lo afirma falsamente

**Rubro**: 3 (E11 / REQ-050/056).

**Evidencia**: `apps/api/src/modules/expediente/post-award.routes.ts:293-301`:

```ts
async function loadOfficialHolidays(tx: DbExecutor, verifiedOnIsoDate: string): Promise<string[]> {
  const year = Number(verifiedOnIsoDate.slice(0, 4));
  if (!Number.isInteger(year)) return [];
  const { rows } = await tx.query<{ holiday_date: string }>(
    `select holiday_date from calendar_holidays where jurisdiction = 'federal' and year in ($1, $2)`,
    [year, year + 1]
  );
  return rows.map((r) => String(r.holiday_date).slice(0, 10));
}
```

El driver (`pg`/PGlite) devuelve la columna `date` como una instancia de
`Date`, no como string. `String(dateObject)` invoca `Date.prototype.toString()`
(formato `"Thu Sep 10 2026 00:00:00 GMT-0600 (...)"`, dependiente de la zona
horaria LOCAL del proceso), **no** `toISOString()`. El resultado tras
`.slice(0,10)` es basura tipo `"Wed Sep 09"` (además con el día corrido por
el offset de zona horaria) que nunca coincide con las claves
`"YYYY-MM-DD"` que usa `addBusinessDays()` (`business-days.ts:104-106`,
`toDateOnlyKey` vía `toISOString()`). El propio archivo **ya importa** la
utilidad correcta para este exacto problema (`timestampToIso`, usada dos
líneas más abajo para `tender.published_at`, línea 139) pero
`loadOfficialHolidays` no la usa.

Reproducido con una prueba adversarial real (no solo lectura de código):
cargado un feriado ficticio el 2026-09-10 (jueves, dentro de la ventana de
17 días hábiles desde una `acceptanceDate` del 2026-09-05, sábado), el
`dueDate` calculado por `POST /expediente/tenders/:id/post-award`
(`kind=facturacion`) fue **idéntico** con y sin el feriado cargado
(`2026-09-29` en ambos casos; el cálculo correcto con el feriado excluido
debía dar `2026-09-30`), mientras que la respuesta igual incluyó:

```json
"calendarNote": "solo excluye sábados y domingos; días inhábiles oficiales pendientes; 1 día(s) inhábil(es) oficial(es) cargado(s) en calendar_holidays incluido(s) en el cómputo."
```

Es decir: la API **afirma explícitamente** que el feriado fue incluido en
el cómputo cuando el cómputo real lo ignoró por completo. Esto es peor que
no tener la funcionalidad: un usuario/administrador que cargue el
calendario oficial confiando en el mensaje de la API recibirá fechas de
vencimiento legal incorrectas sin ninguna señal de alerta.

Esto también contradice el principio de determinismo por zona horaria que
el propio proyecto ya se exige en otro módulo (`EX-EXP-04`,
`packages/expediente/test/timezone-determinism.test.ts`): el resultado de
`loadOfficialHolidays` depende de `TZ` del proceso que ejecuta la API.

**Por qué no se detectó en la suite existente**: ningún test ejercita el
camino completo "cargar un feriado vía `POST /admin/calendar-holidays`" →
"crear un seguimiento `pago`/`facturacion` que caiga en esa ventana" →
"verificar que el `dueDate` lo excluye". `admin-calendar-holidays.test.ts`
solo prueba el CRUD del calendario en aislamiento;
`security-ae09-payment-deadline-calendar-and-regime.test.ts` solo prueba el
mensaje ESTÁTICO de `calendarNote` sin ningún feriado cargado;
`expediente-post-award.test.ts` nunca carga un feriado. Es exactamente el
hueco de integración que este rubro de la auditoría pedía cubrir.

**Reparación (propuesta, no aplicada)**: reemplazar
`String(r.holiday_date).slice(0, 10)` por
`timestampToIso(r.holiday_date as string | Date)!.slice(0, 10)` (o el
patrón `datePartOf` de `lib/expediente/dates.ts`), y agregar un test de
integración que cargue un feriado ficticio y confirme que el `dueDate`
real se corre un día.

---

### R5-02 (CRÍTICA) — Sin límite de tasa específico anti-fuerza-bruta en los endpoints TOTP

**Rubro**: 2 (2FA/step-up).

**Evidencia**: `apps/api/src/modules/twofa/routes.ts` no aplica ningún
`config: { rateLimit: ... }` en ninguna de sus rutas (comparar con
`apps/api/src/modules/auth/routes.ts:126`, que sí fija
`app.rateLimitSettings.auth` — 5/min — para `/auth/login`). El tier
`sensitiveAction` (30/min, ver `apps/api/src/lib/rate-limit-settings.ts`)
solo se aplica en `apps/api/src/modules/admin/routes.ts` y
`apps/api/src/modules/agents/routes.ts` (aprobación/denegación de
`tool_calls`) — nunca en `twofa/routes.ts`. Los tres endpoints
(`/auth/2fa/enroll`, `/auth/2fa/verify-enrollment`, `/auth/2fa/step-up`)
solo heredan el límite `global` (300 req/min **por IP**, hook `onRequest`).

Un código TOTP tiene 10^6 combinaciones. A 300 intentos/min desde una sola
IP, agotar el espacio completo toma ~55 horas sin disparar nunca un
comportamiento distinto del tráfico normal; distribuido entre unas pocas
IPs, el tiempo cae a minutos. Esto vacía en la práctica la protección de
"segundo factor" que motiva REQ-044/064: un atacante que ya comprometió la
contraseña de un owner/admin (o robó su `accessToken`) puede intentar
fuerza bruta contra el código de 6 dígitos sin fricción adicional
significativa.

Reproducido con una prueba adversarial real: 40 intentos consecutivos de
`POST /auth/2fa/verify-enrollment` con código incorrecto devolvieron 403 en
los 40 casos, **cero** 429.

**Reparación (propuesta, no aplicada)**: aplicar un tier de rate limit
específico y estricto (comparable a `auth`, 5-10/min) a las tres rutas de
`twofa/routes.ts`, con `keyGenerator` por `userId` (ya autenticado en las
tres) además de por IP, para que rotar de IP no reinicie el presupuesto de
intentos contra la misma cuenta.

---

### R5-03 (MEDIA) — Intentos fallidos de 2FA no quedan en `audit_log`

**Rubro**: 2 (2FA/step-up).

**Evidencia**: `recordSecurityAudit`/`app.record_security_event` solo se
invoca en las ramas de ÉXITO de `apps/api/src/modules/twofa/routes.ts`
(líneas 85-93, 134-142, 195-203). Ninguna rama de error (`ForbiddenError`
por código inválido, replay, backup code ya usado) llama a
`recordSecurityAudit`. Reproducido: tras 40 intentos fallidos consecutivos
de `verify-enrollment`, `select action from audit_log where entity in
('user_totp_secrets','step_up_sessions')` solo devuelve la fila de
`twofa.enroll` inicial — ningún fallo quedó registrado.

Esto rompe la paridad que la propia ronda 4 (API-13,
`packages/db/migrations/0051`) estableció para `/auth/login`: ahí
`auth.login_failed` SÍ se audita explícitamente para permitir detectar
fuerza bruta después del hecho. Aquí no existe ese rastro, lo que además
agrava R5-02 (sin límite de tasa NI auditoría de fallos, un ataque de
fuerza bruta contra el 2FO es indetectable en retrospectiva).

**Reparación (propuesta, no aplicada)**: registrar un evento
`twofa.verification_failed`/`twofa.step_up_denied` (agregar esos dos
literales a la lista blanca de `app.record_security_event` en una nueva
migración) en cada rama de rechazo de `twofa/routes.ts` y `step-up.ts`.

---

### R5-04 (MEDIA) — REQ-171: la traza "de extremo a extremo desde la convocatoria" nunca incluye la convocatoria

**Rubro**: 5 (correlation-id).

**Evidencia**: la migración `0056_correlation_id_propagation.sql` agrega
`correlation_id` a `source_runs` explícitamente para cubrir "la ingesta de
la convocatoria" como primer eslabón de la cadena "convocatoria → matriz →
propuesta → paquete → archivo" (comentario propio de la migración, líneas
9-15). Pero:

- `apps/worker/src/source-runs/source-runs-repository.ts:45` (el único
  sitio que hace `insert into source_runs`) **nunca incluye la columna
  `correlation_id`** en su INSERT — la columna queda siempre `NULL` para
  toda corrida de descubrimiento real.
- `apps/api/src/modules/tenders/internal-ingest.routes.ts:210` inserta en
  `audit_log` con columnas explícitas
  `(org_id, actor_id, action, entity, entity_id, after, request_id)` —
  **omite `correlation_id`** aunque `request.correlationId` ya está
  disponible (lo llena el plugin global en `onRequest` para cualquier
  request, incluida esta). Un cliente que mande `X-Correlation-Id` a esta
  ruta lo recibe reflejado en la respuesta pero nunca se propaga a ningún
  dato persistido de esa request.
- `tenders`/`tender_versions`/`tender_change_events` no tienen columna
  `correlation_id` en ninguna migración — la convocatoria en sí no es
  correlacionable nunca, ni con la mejor intención del cliente.

El propio test que valida REQ-171 de punta a punta
(`apps/api/test/correlation-id-e2e.test.ts`, función `createTender` +
segundo `it`) confirma esto indirectamente: crea la convocatoria SIN ningún
`X-Correlation-Id` (solo con `x-platform-api-key`), y el `correlationId`
real que se rastrea después empieza recién en `PUT /company/profile`. El
docstring del test dice "convocatoria -> propuesta -> checklist ->
aprobación -> paquete" pero la convocatoria nunca participa realmente en la
cadena verificada.

**Impacto**: para el flujo automatizado (descubrimiento por
`apps/worker` → `POST /internal/tenders/ingest`), que es el camino real de
producción para nueva convocatoria, no existe ningún id de correlación que
permita reconstruir "esta convocatoria específica generó esta corrida de
scraping" en `GET /audit-log`. El resto de la cadena (perfil → tarifa →
propuesta → checklist → aprobación → paquete) sí queda perfectamente
correlacionada cuando el cliente lo decide (verificado, ver "Comprobado
correcto" abajo) — el hueco es específicamente el primer eslabón.

**Reparación (propuesta, no aplicada)**: generar/heredar un
`correlationId` en el `discover_tenders` handler de `apps/worker`,
propagarlo en el INSERT de `source_runs` y como header `X-Correlation-Id`
al llamar a `POST /internal/tenders/ingest`; en `internal-ingest.routes.ts`
incluir `correlation_id: request.correlationId` en su INSERT a
`audit_log`. Considerar agregar la columna a `tenders`/`tender_versions`
si se quiere una trazabilidad real desde el primer registro.

---

### R5-05 (BAJA-MEDIA, diseño) — `step_up_sessions` no está ligado a una acción ni a una organización específica

**Rubro**: 2 (2FA/step-up).

**Evidencia**: `requireStepUp` (`apps/api/src/lib/step-up.ts:114-143`) solo
valida `user_id` y `expires_at` de la fila de `step_up_sessions` — no hay
columna ni comprobación de `org_id`, `scope`/`action`, ni del recurso
(`rateId`/`tenderId`) que se está aprobando. Un `stepUpToken` emitido una
vez es reutilizable, dentro de la ventana de `STEP_UP_WINDOW_MINUTES`
(default 5 min), para aprobar **cualquier número** de tarifas y/o
expedientes distintos, en **cualquier** organización de la que el usuario
sea miembro (esto último es coherente con el diseño declarado — 2FA es de
cuenta, no de organización — pero la reutilización entre acciones distintas
dentro de la ventana no está documentada como decisión deliberada).

Esto es un patrón legítimo ("modo sudo" temporal, común en 2FA de otros
productos) pero es más laxo que la lectura literal de la tarea de esta
auditoría ("no reutilizable para otra acción") y que el espíritu de
REQ-064 ("re-autenticación... específicamente en la aprobación económica").
No es una vulnerabilidad de autorización (todavía se exige el rol correcto
y el step-up en sí), pero vale la pena documentarlo explícitamente como
decisión de diseño o, si no es deliberado, endurecerlo.

**Reparación (propuesta, no aplicada)**: si se decide mantener el modelo de
ventana, documentarlo explícitamente en el README (ya no como pendiente
oculto); si se quiere alcance por acción, agregar a `step_up_sessions` un
`consumed_at` que se marque en el primer uso (single-use) o un `scope_ref`
que amarre el token a la entidad concreta que se aprobará.

---

### R5-06 (BAJA) — `sourceUrl` de `calendar_holidays` acepta cualquier esquema de URL

**Rubro**: 3 (E11 / carga de feriados).

**Evidencia**: `apps/api/src/modules/admin/schemas.ts:18`,
`sourceUrl: z.string().url()`, acepta `javascript:...`, `data:...`,
`ftp://...` (verificado: `z.string().url().parse('javascript:alert(1)')`
no lanza). Solo superadmin puede escribir esta tabla, así que el vector de
explotación requiere una cuenta superadmin ya comprometida o maliciosa; el
riesgo real es que si `apps/web` alguna vez renderiza `sourceUrl` como
enlace clicable sin sanitizar, se abre un vector de auto-XSS para
cualquiera que abra ese enlace desde el back office.

**Reparación (propuesta, no aplicada)**: `z.string().url().refine(u =>
/^https?:\/\//i.test(u))`.

---

### R5-07 (BAJA) — Fecha calendario inexistente en `POST /admin/calendar-holidays` produce 500 en vez de 422

**Rubro**: 3 (E11 / carga de feriados).

**Evidencia**: `calendarHolidayCreateSchema.date`/`sourceConsultedOn`
(`apps/api/src/modules/admin/schemas.ts:16,19`) solo validan el patrón
`/^\d{4}-\d{2}-\d{2}$/`, no que sea una fecha calendario real. Reproducido:
`POST /admin/calendar-holidays` con `date: "2026-02-30"` devuelve
`500 {"title":"date/time field value out of range: \"2026-02-30\""}` en vez
de un `422` explícito. En producción (`NODE_ENV=production`) el título se
redacta a "Error interno del servidor" (`plugins/error-handler.ts`,
confirmado en código — no hay fuga de información en producción), pero
sigue siendo un 500 (error de servidor) por lo que en realidad es un error
de validación de cliente, y solo lo puede disparar un superadmin.

**Reparación (propuesta, no aplicada)**: validar con
`z.string().date()` (Zod ya soporta fechas calendario reales desde v3.23)
o un `refine` que intente `new Date(...)` y compruebe que no es
`Invalid Date`/que el día no se "corrió" (p. ej. comparar
`toISOString().slice(0,10)` contra el valor de entrada).

---

### R5-08 (BAJA, documentación) — `docs/TABLERO.md`/`docs/BACKLOG.md` no se actualizaron tras el trabajo real de E11 en esta ronda

**Rubro**: 8 (trazabilidad).

**Evidencia**: `docs/TABLERO.md:42` y `docs/BACKLOG.md:142` siguen
diciendo, respectivamente, `"E11 ... PENDIENTE (0% construido, sin
cambio)"` y `"Módulo post-adjudicación completo (E11, REQ-050 a REQ-056):
0% construido, sin trabajo despachado"`. `git log` confirma que ambos
archivos se tocaron por última vez en el commit `e61156e`
(2026-09-06 05:22:23), **antes** del commit `480d691`
(2026-09-06 05:55:56) que construyó el trabajo real de E11 de esta ronda
(columnas estructuradas de `post_award_followups`, tabla
`calendar_holidays`, endpoints `/admin/calendar-holidays`,
`/expediente/.../post-award-alerts`). `apps/api/docs/e11-cobertura.md` sí
documenta el estado real y corrige la reconciliación honestamente, pero esa
corrección nunca se propagó a los documentos de seguimiento de más alto
nivel que el propio proyecto usa como fuente de verdad de progreso por
épica.

La dirección del error es "segura" (subestima el avance en vez de
sobreestimarlo — no hay riesgo de que alguien confíe en una funcionalidad
que no existe), pero rompe la práctica de reconciliación que el propio
proyecto se exige (ver el encabezado de `e11-cobertura.md`, que
explícitamente señala esta misma inconsistencia como motivo de existir del
documento, sin cerrarla en la fuente).

**Reparación (propuesta, no aplicada)**: actualizar la fila E11 de
`docs/TABLERO.md` y la sección correspondiente de `docs/BACKLOG.md` para
reflejar el estado PARCIAL real descrito en `e11-cobertura.md` (y, dado
R5-01, dejar constancia de que el calendario cargado hoy no afecta el
cómputo real hasta que se corrija).

---

## Comprobado correcto

- **Reproducibilidad** (rubro 1): reproducido de forma independiente en un
  worktree limpio — `apps/api` 53 archivos/200 tests, `packages/db` 23
  archivos/158 tests, `packages/expediente` 16 archivos/413 tests, los tres
  con `typecheck`/`lint` sin errores. `apps/web typecheck` limpio.
  `apps/worker typecheck` limpio y `apps/worker test` 11 archivos/298 tests
  en verde. Ningún resultado se tomó del log preexistente sin re-ejecutar.
- **`TOTP_ENCRYPTION_KEY` fail-closed**: `apps/api/src/config.ts:50-54`
  lanza una excepción de arranque si la variable falta o mide menos de 16
  caracteres — no hay ninguna clave por defecto insegura ni arranque
  degradado.
- **Cifrado del secreto TOTP**: AES-256-GCM con IV aleatorio de 12 bytes
  por operación y verificación de `authTag` (`lib/step-up.ts:32-51`); el
  secreto en claro nunca se persiste, solo se devuelve una vez en la
  respuesta de `POST /auth/2fa/enroll`.
- **Replay de TOTP rechazado**: verificado por lectura y por la suite
  existente — un código de un `timeStep` ≤ al último aceptado se rechaza
  tanto en `verify-enrollment` como en `step-up`, incluso si sigue siendo
  válido dentro de la ventana de tolerancia de `otplib`.
- **Códigos de respaldo**: 10 por enrolamiento, alfabeto sin caracteres
  ambiguos, hasheados con SHA-256 (entropía suficientemente alta para que
  la falta de sal no sea explotable), marcados `used_at` en el primer uso
  (de un solo uso real), reemplazados por completo (no acumulados) en cada
  reenrolamiento.
- **`step_up_sessions` no transferible entre usuarios**: un `stepUpToken`
  de otro usuario es rechazado explícitamente (probado en la suite
  existente y consistente con el código de `requireStepUp`, que filtra por
  `user_id` además de por RLS).
- **`actor_id` protegido en `app.record_security_event`** (migración
  `0057`): exige sin excepción que `p_actor_id` coincida con
  `app.current_user_id()`, mismo patrón que API-14/0054 — ya incorporado
  correctamente a la whitelist de
  `packages/db/test/security-definer-audit.test.ts` con justificación
  explícita por función.
- **Aprobación sin 2FA enrolado → 403 explícito**: verificado en ambos
  endpoints protegidos (`POST /company/rates/:id/approve`,
  `POST /expediente/.../approval/approve`), con mensaje que indica el paso
  siguiente (enrolar) en vez de un 403 mudo.
- **Desenrolar 2FA sin verificación**: no aplica — no existe ningún
  endpoint de desenrolamiento en esta ronda (declarado explícitamente fuera
  de alcance en el README), así que no hay vector real que auditar todavía.
- **`calendar_holidays` — RLS y contrato de escritura**: lectura abierta a
  cualquier autenticado, escritura (`insert`/`update`/`delete`) restringida
  a `app.is_superadmin()` a nivel de política (migración `0055`); `POST
  /admin/calendar-holidays` exige `sourceUrl` + `sourceConsultedOn` y
  responde 422 explícito si faltan (probado). La tabla arranca vacía y
  `calendarNote` lo declara honestamente cuando no hay feriados cargados
  para el año relevante.
- **Diseño de composición de feriados** (aparte del bug de serialización de
  R5-01): la idea de combinar `calendar_holidays` (oficiales) con
  `holidays` declarado a mano por el llamador, y de anunciar en
  `calendarNote` cuántos oficiales se usaron, es la solución correcta al
  requisito — el defecto es puramente de implementación (formato de
  fecha), no de diseño.
- **REQ-142 — `source` de procedencia no falsificable por el cliente**:
  cada sitio de escritura que llama a `recordFieldProvenance` (factory
  genérica `lib/company-crud.ts`, y los tres sitios especiales de
  `modules/company/routes.ts` — perfil, documentos, tarifas) fija
  `source: 'manual'` como literal en el propio código del servidor; no
  existe ningún camino donde el body de la request controle ese valor.
  (Nota aparte, no un hallazgo de seguridad: como consecuencia, `source`
  nunca toma los valores `'import'`/`'agent'` en la práctica actual — el
  campo existe en el tipo pero ningún flujo real lo usa todavía.)
- **REQ-142 — bloqueo real por falta de procedencia**: reproducido con la
  suite existente (`security-req142-provenance-binding.test.ts`) — una
  capacidad insertada sin pasar por la API (sin `field_provenance`) bloquea
  el requisito correspondiente en el expediente, y un documento de empresa
  sin procedencia genera un criterio de elegibilidad `no_evaluable`
  explícito en matching.
- **`X-Correlation-Id` — validación de entrada**: `resolveCorrelationId`
  (`plugins/correlation-id.plugin.ts:28-32`) solo acepta un UUID v4-like
  estricto (`^[0-9a-f]{8}-...$`); cualquier valor malformado, demasiado
  largo, o con intento de inyección de log se descarta silenciosamente y se
  genera un UUID nuevo — nunca se refleja el valor crudo del cliente en
  `audit_log` sin haber pasado ese filtro.
- **`GET /audit-log?correlationId=` sin fuga cross-org**: la condición
  `org_id = $1` (de `X-Org-Id`, ya validado contra la membresía real) es
  SIEMPRE la primera condición de la query
  (`apps/api/src/modules/audit/routes.ts:78-79`); un `correlationId`
  compartido accidental o deliberadamente entre dos organizaciones nunca
  permite leer eventos de la otra organización desde este endpoint.
  `GET /admin/audit-log` sí cruza organizaciones, pero eso es
  comportamiento esperado y gateado por `requireSuperadmin`.
- **Correlación real de un flujo completo** (aparte del hueco de R5-04 en
  el primer eslabón): reproducido con la suite existente — perfil de
  empresa → tarifa → propuesta económica → checklist → aprobación →
  paquete, todo con el mismo `X-Correlation-Id`, se reconstruye
  íntegramente vía `GET /audit-log?correlationId=`, y un evento de otra
  organización sin ese id nunca aparece en el resultado.
- **Aviso de privacidad** (REQ-119/131): `GET /legal/privacy-notice` es
  público (sin `Authorization`), versionado vía front matter
  (`version: 1`), marcado explícitamente
  `status: borrador_pendiente_validacion_juridica`, y **no existe ningún
  endpoint de escritura** para este recurso (ni siquiera para superadmin) —
  no es editable vía API por nadie en esta ronda. El contenido
  (`apps/api/docs/legal/privacy-notice.md`) es coherente con
  `docs/legal/verificacion-legal.md`: LFPDPPP nueva DOF 20-mar-2025,
  autoridad SABG (sucesora del INAI extinto el 20-mar-2025), plazo ARCO de
  20 días (Art. 31), multas de 200 a 320,000 UMA — ninguna cifra del aviso
  se desvía de lo verificado.
- **Regresión — diff de tests preexistentes en `53427ff`**: revisados los
  13 archivos de test modificados por el commit de 2FA
  (`company-profile.test.ts`, `correlation-id-e2e.test.ts`,
  `expediente-checklist-and-approval.test.ts`, `expediente-e2e-flow.test.ts`,
  `expediente-package-and-submission.test.ts`, `expediente-proposal.test.ts`,
  `ronda4-empty-body.test.ts`, `ronda4-rate-limit-profile.test.ts`,
  `security-ae01/02/08/11/14-*.test.ts`, `security-wi04-*.test.ts`): en
  todos los casos el único cambio es agregar el encabezado `X-Step-Up`
  (vía el nuevo helper `enrollTwoFactor`) o la nueva variable de config
  `TOTP_ENCRYPTION_KEY` requerida para que `loadConfig()`/`createTestApp()`
  sigan arrancando. Ninguna aserción (`expect(...)`) fue eliminada,
  relajada ni cambiada de valor esperado.
- **`packages/db/test/security-definer-audit.test.ts`**: la nueva entrada
  de whitelist para `app.record_security_event` sigue exactamente el mismo
  formato y nivel de justificación explícita que las entradas preexistentes
  (`app.record_auth_event`, `app.org_members`), sin relajar el test en sí
  (sigue fallando si aparece una función `SECURITY DEFINER` no
  documentada).

---

## Trazabilidad REQ (rubro 8)

`apps/api/docs/e11-cobertura.md` ya documenta con honestidad, fila por
fila, que REQ-051/052/053/054 están **PENDIENTE** (no construidos, no
despachados en esta ronda) y que REQ-050/055/056 son **PARCIAL** — ninguno
de los tres se declara "hecho" sin matiz en ningún documento de esta ronda.
El único problema de trazabilidad real encontrado es R5-08 (arriba):
`docs/TABLERO.md`/`docs/BACKLOG.md` no se sincronizaron con esa
reconciliación, no que se haya sobreclamado nada.

---

## Nota de alcance

No se auditó `apps/web` más allá de `typecheck` (no se pidió explícitamente
una revisión de UI de 2FA/calendario/aviso de privacidad en esta ronda) ni
se profundizó en `apps/worker` más allá de `typecheck`+`test` — ambos en
verde, sin hallazgos de regresión. El worktree `audit-api5` se eliminó al
cierre de esta auditoría.
