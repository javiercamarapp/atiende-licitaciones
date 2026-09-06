# @atiende/web

Frontend del back office de **Atiende Licitaciones** (marca Atiende, plataforma
de IA para gestión de licitaciones públicas). Conectado a `apps/api` real (sin
mocks en producción — MSW solo en pruebas de componente, ver `src/test/msw.ts`).
Toda pantalla que todavía no tiene un endpoint real detrás sigue mostrando un
estado honesto (vacío, error con `request_id`, o "endpoint pendiente en
apps/api") en vez de datos ficticios.

## Ronda 5 — expediente de participación completo + back office restante

Conecta los últimos módulos de dominio que quedaban en `EmptyState` genérico
(ver "Módulos sin conectar" de la ronda 3, ya retirada) contra las 26 rutas
reales de `apps/api` bajo `/expediente/tenders/:tenderId/...`, y cierra los
huecos de back office que ronda 3/4 habían dejado documentados como
"endpoint pendiente":

- **Análisis de bases** (`pages/evaluacion/AnalisisBasesPage.tsx`): subida de
  documentos (con validación de tipo/tamaño en cliente), `textExtractionStatus`
  explícito (incluido `requires_ocr`, nunca oculto), matriz de requisitos
  editable por rol (estado/responsable), y conflictos escalados con
  resolución.
- **Cumplimiento documental** (`CumplimientoDocumentalPage.tsx`): ejecuta
  `IntegrityChecklist` real (7 dimensiones) declarando solo lo que la API
  exige del llamador (archivos finales, firmas confirmadas por el usuario,
  anexos ya adjuntos) — documentos de empresa y cálculo económico se validan
  con datos reales, sin declaración manual.
- **Redacción** (`RedaccionPage.tsx`): genera la propuesta técnica mapeando
  cada requisito a un dato real y aprobado de la empresa (capacidad,
  experiencia, documento, firmante) y la propuesta económica con tarifas
  reales (bloqueo íntegro de un concepto sin tarifa aprobada/vigente, nunca
  total parcial); lista secciones con `source_ref` visibles y permite
  editarlas (nueva versión, invalida aprobaciones vigentes de esa sección).
- **Revisión** (`RevisionPage.tsx`): solicitar revisión, comentar,
  aprobar (reviewer/admin/owner, nunca el autor) e invalidación visible de
  aprobaciones tras un cambio (A11). La API no modela un estado de "rechazo"
  propio (solo borrador/en_revisión/aprobado) — un rechazo se registra aquí
  como comentario explícito, documentado como gap de dominio, no simulado.
- **Expediente** (`ExpedientePage.tsx`): panel general por convocatoria que
  resume bases, propuesta, checklist, aprobación, paquete y presentación con
  enlaces a cada módulo.
- **Aprobaciones** (Preparación, `AprobacionesPage.tsx`): bandeja de estado
  de aprobación por convocatoria (armada en el cliente — no existe un
  endpoint agregado "todas las pendientes de mi organización"), distinta de
  "Aprobaciones (tool_calls)" del back office.
- **Entregas** (`EntregasPage.tsx`) y **Paquete descargable**
  (`PaqueteDescargablePage.tsx`): ensamblar el paquete, ver manifiesto real
  (`status`/`draftReasons`/`missing`/`notice`, SIEMPRE derivado por el
  servidor — A13/A14), descarga autenticada, y declarar la presentación
  (fecha + acuse opcional) con el aviso permanente de que el sistema nunca
  envía ni firma nada.
- **Seguimiento post-adjudicación** (`SeguimientoPage.tsx`): hitos,
  garantías, facturación y pago — para `kind="pago"` solo se declara la
  fecha de verificación de la factura; `calendarNote`/`legalRegime` (LAASSP
  Art. 73 o régimen abrogado según la fecha de publicación) los deriva y
  muestra el propio servidor.
- **Back office**: "Usuarios y roles" (`UsuariosRolesPage.tsx`, ahora sobre
  `GET /organizations/:orgId/memberships`, ronda 4 de apps/api) e invitar/
  cambiar rol/eliminar; "Auditoría" (`AuditoriaPage.tsx`, sobre
  `GET /audit-log`); "Aprobaciones" de tool_calls ahora aprueba/deniega
  cross-org de verdad (`POST /admin/tool-calls/:id/approve|deny`, antes de
  solo lectura). Conectores/Jobs/Costos/Incidentes ya estaban conectados
  desde ronda 3 y no cambiaron.
- **Guard 404 de tenant cruzado** (`ResourceNotFoundPage.tsx` +
  `isNotFoundOrForbidden()` en `lib/api/http.ts`): un recurso de otra
  organización (403/404 real de apps/api vía RLS) se muestra como "recurso
  no encontrado" dedicado en `ConvocatoriaDetallePage` (la única ruta con un
  `:id` tomado directo de la URL) — nunca el mensaje crudo del 403, que
  confirmaría implícitamente su existencia.
- **Aviso de privacidad** (`PrivacyNoticePage.tsx`, ruta pública
  `/privacidad`, fuera de `RequireAuth`): contenido basado en
  `docs/legal/verificacion-legal.md` (nueva LFPDPPP DOF 20-mar-2025,
  responsable SABG, ARCO 20 días, multas 200-320,000 UMA, disclosure de
  enrutamiento a IA por REQ-131), marcado explícitamente como **borrador
  pendiente de validación jurídica**.
- **E2E completo contra apps/api real**
  (`e2e/expediente-flujo-completo.spec.ts`): bases → matriz → propuesta
  técnica/económica → checklist verde → revisión/aprobación con DOS actores
  reales (`writer` solicita, `admin` aprueba) → paquete "borrador" → paquete
  "listo" → descarga autenticada → declarar presentación; cubre además A11
  (editar una sección tras aprobar invalida y el paquete vuelve a
  "borrador"), A12 (writer no puede aprobar) y A14 (paquete incompleto nunca
  "listo"), con axe-core y 320×568/390×844 sobre las pantallas con datos
  reales cargados. Corre en una organización dedicada (`orgC` del seed,
  `e2e/global-setup.ts`) con una convocatoria real sembrada por
  `POST /internal/tenders/ingest` — aislada de `orgA`/`orgB` para no romper
  los supuestos ya probados de `ronda3-flujo-real.spec.ts` (convocatorias
  vacías en `orgA`) ni de `recorrido.spec.ts` (paquete de la organización
  por defecto sin convocatorias).
- **Polyfills de jsdom** (`src/test/setup.ts`): `hasPointerCapture`/
  `setPointerCapture`/`releasePointerCapture`/`scrollIntoView`/
  `ResizeObserver` — sin ellos, cualquier prueba de componente que abra un
  `<Select/>` real de Radix (el selector de convocatoria, usado por todos
  los módulos nuevos) se queda colgada en vez de fallar o pasar. De paso,
  `vite.config.ts` (test) fija `testTimeout: 20000` + `retry: 1`: este
  entorno sandboxeado tiene contención real de CPU bajo la suite completa
  en paralelo, y una prueba que interactúa con un `<Select/>` y encadena
  varias queries puede tardar más que el timeout por defecto (5s) sin que
  haya ningún bug.
- **Corrección real encontrada**: `hooks/useAdmin.ts` disparaba sus queries
  en el primer render, antes de que `AuthProvider` terminara de rotar el
  refresh token guardado y consiguiera un access token real — en producción
  el `retry: 1` por defecto de `queryClient` disimulaba la carrera, pero
  seguía siendo una petición real de más. Ahora cada lectura admin espera
  `status === "authenticated"`.

### Ronda 5, segunda mitad — apps/api agregó 2FA/step-up, aviso versionado, alertas y traza

Mientras se conectaban los módulos de arriba, `apps/api` despachó en
paralelo su propia ronda 5 (2FA/step-up TOTP, aviso de privacidad
versionado, E11 ampliado con alertas, `correlation_id` de extremo a
extremo). Se conecta todo desde `apps/web` en la misma ronda:

- **2FA/step-up (REQ-044/064)**: `POST /company/rates/:id/approve` y
  `POST .../approval/approve` ahora exigen el encabezado `X-Step-Up`
  (sesión de step-up vigente, `POST /auth/2fa/step-up`). Agrega
  `lib/api/twofa.ts` + `hooks/useTwoFactor.ts` +
  `components/StepUpDialog.tsx` (modal reutilizado por
  `TarifasAprobadasPage` y `RevisionPage`: pide el código TOTP o de
  respaldo, o dirige a Configuración si no hay 2FA enrolado) y una
  sección de enrolamiento real en `ConfiguracionPage.tsx` (QR/secreto,
  códigos de respaldo mostrados una sola vez, confirmación con código).
  Solo TOTP en esta ronda (passkey/WebAuthn pendiente, igual que
  documenta `apps/api`).
- **Aviso de privacidad real** (`GET /legal/privacy-notice`, público):
  `PrivacyNoticePage.tsx` ya no tiene el texto redactado a mano — lo
  obtiene versionado del servidor y lo renderiza con un Markdown mínimo
  propio (`lib/renderSimpleMarkdown.tsx`, sin dependencia nueva ni
  `dangerouslySetInnerHTML`).
- **Alertas de vencimiento (REQ-056)**: `SeguimientoPage.tsx` agrega una
  tarjeta de alertas (`GET /expediente/post-award-alerts`) a través de
  TODAS las convocatorias de la organización activa, y el formulario de
  seguimiento gana los campos de los kinds ampliados (`garantia` con
  tipo, `facturacion` con CFDI + fecha de aceptación,
  `penalizacion`/`convenio_modificatorio` con referencia registrada).
- **Traza por correlación (REQ-171)**: `AuditoriaPage.tsx` agrega un
  filtro por `correlationId` y un botón "Ver traza" por fila para
  reconstruir el flujo completo (perfil → tarifa → propuesta →
  checklist → aprobación → paquete) desde un solo evento.
- **E2E real con 2FA**: el enrolamiento (mismo algoritmo TOTP que
  `apps/api`, vía `otplib` como devDependency de `apps/web`) ocurre UNA
  SOLA VEZ en `e2e/global-setup.ts` — un único proceso Node, ejecutado
  antes de que arranque cualquier test — y el secreto queda persistido en
  `.artifacts/seed.json`, nunca solo en memoria de un archivo de prueba.
  **Corrección real encontrada**: una primera versión enrolaba 2FA desde
  un test vía UI, cacheando el secreto/códigos de respaldo en un módulo
  compartido; asumía que `workers: 1` (modo "full") bastaba para que ese
  estado sobreviviera entre archivos y reintentos, pero Playwright
  reintenta un test fallido en un worker **nuevo** por defecto, perdiendo
  la caché en memoria mientras el enrolamiento del lado del servidor
  seguía existiendo — el guard del helper fallaba con "ya tiene 2FA
  enrolado pero este worker no cacheó". Ahora `e2e/two-factor-helpers.ts`
  solo expone `getAdminStepUpCode(seed)` (calcula un código TOTP VIGENTE
  en el momento de cada llamada, leyendo siempre `seed.json`) y
  `completeStepUp(page, code)`, usados por
  `e2e/ronda3-flujo-real.spec.ts` y `e2e/expediente-flujo-completo.spec.ts`
  — nunca se reutiliza un código ya usado, así que ni el rechazo de replay
  de `apps/api` ni un reintento de Playwright rompen el flujo.

### Ronda 5, cierre — R5-09 (orgId/purpose obligatorios en el step-up) y endurecimiento del E2E

`apps/api` cerró R5-09 (docs/auditoria-2/api-ronda5-reverificacion.md):
`org_id`/`purpose` pasan a **obligatorios** en `step_up_sessions`
(migraciones 0062/0063) — antes ningún cliente los declaraba, así que
toda sesión de step-up quedaba "genérica" (servía para aprobar cualquier
tarifa/expediente de cualquier organización dentro de su vigencia). Se
conecta desde `apps/web`:

- `verifyStepUp(code, orgId, purpose)` (`lib/api/twofa.ts`) manda
  `X-Org-Id` y `{ code, purpose }`; `StepUpDialog` exige un `purpose` por
  prop, EXACTO al que la ruta consumidora exige:
  `"company.rate_approval"` en `TarifasAprobadasPage`,
  `"expediente.approval"` en `RevisionPage`. Tests unitarios nuevos (MSW
  verifica el header/body reales) en ambas páginas.
- **Corrección real encontrada, la misma migración**: `POST
  /auth/2fa/verify-enrollment` también emite una sesión de step-up (para
  no exigir un segundo código al confirmar el enrolamiento) e inserta en
  la MISMA tabla ahora NOT NULL — pero esa ruta no fue actualizada para
  EXIGIR `orgId`/`purpose` a nivel de aplicación (a diferencia de
  `/2fa/step-up`), así que sin declararlos igual responde 500 real. Se
  declaran también ahí (`purpose: "admin.action"`, el más genérico de la
  lista cerrada de apps/api) desde `useVerifyTwoFactorEnrollment` y desde
  el seed E2E (que además tuvo que reordenarse: crear la organización
  ANTES de enrolar 2FA, ya que antes no había ninguna que declarar).
- **Límite de tasa fijo del step-up (R5-02, 5 peticiones/5min por IP,
  nunca relajado ni por `RATE_LIMIT_PROFILE=e2e`)**: la suite E2E
  necesitaba más verificaciones TOTP reales de las que el cupo permite
  (enrolamiento + 4 aprobaciones = 6 > 5) — se fusionó el test WI-06
  (doble clic físico) con la aprobación real de `ronda3-flujo-real.spec.ts`
  (un solo step-up cubre ambas aserciones) y se desactivaron los
  reintentos de Playwright (`retries: 0`) en los dos archivos con step-up
  real: reintentar un test que falló por un límite de tasa real no lo
  arregla, solo gasta más cupo.
- **Falsos positivos de axe por animaciones CSS sin esperar**: dos
  hallazgos "serious" de contraste (toast de Sonner recién aparecido,
  popover de Radix Select recién cerrado) resultaron ser mediciones a
  mitad de una transición `opacity`/`transform` (400ms) — `toBeVisible()`
  de Playwright no espera a que termine una animación CSS. Cubierto con
  una espera corta antes de escanear en `expediente-flujo-completo.spec.ts`
  (y un endurecimiento adicional real en `components/ui/sonner.tsx`: el
  color de texto del toast ahora fuerza `!text-foreground` porque ni una
  clase `group-[...]` ni redeclarar `--normal-*` de Sonner vía `style`
  ganaba de forma confiable a su cascada interna).
- **`RuleBasedExtractor` sin evidencia mapeable**: la frase de bases de
  `expediente-flujo-completo.spec.ts` no contenía ninguna de las frases
  reconocidas por `extractRequiredEvidence` (packages/expediente) — un
  requisito con `requiredEvidence` vacío nunca llega a la rama de mapeo
  explícito de `TechnicalProposalBuilder` y queda "PENDIENTE" siempre,
  sin importar el mapeo declarado en la UI. Se ajustó la frase para
  incluir "poder notarial" (evidencia reconocida para un representante
  legal).

### Ronda 5, corrección post-auditoría — RF-01/02/03 (`docs/auditoria-2/ronda5-final.md`)

Un agente auditor adversarial independiente (`docs/auditoria-2/ronda5-final.md`)
encontró tres defectos reales tras el cierre de arriba, corregidos en esta
ronda (uno por commit; ver la columna "Estado reparación" de ese documento
para el detalle completo con hashes):

- **RF-01 (MEDIA-ALTA)**: `apps/web` nunca se actualizó tras R5-11 de
  `apps/api` (aprobar/denegar una `tool_call` exige `X-Step-Up`) —
  "Agentes y herramientas" (org-scoped, `purpose="tool_call.approval"`) y
  "Aprobaciones" del back office (cross-org, `purpose="admin.action"`)
  mutaban directo, sin pedir ningún código, así que siempre fallarían con
  403 en cuanto existiera una `tool_call` pendiente real. Se agrega
  `StepUpDialog` a ambas pantallas (mismo patrón que
  `TarifasAprobadasPage`/`RevisionPage`); el caso cross-org necesitó un
  `orgId` explícito en `StepUpDialog`/`useVerifyStepUp` (por defecto usa
  la organización activa) porque la sesión de step-up debe atarse a la
  organización DUEÑA de la `tool_call`, no a la del superadmin. Sin test
  E2E con una `tool_call` real sembrada vía API: `apps/api` no expone
  ninguna ruta HTTP para crear una (solo `INSERT` directo, usado por sus
  propios tests) y esta corrección tenía prohibido tocar `apps/api`.
- **RF-02 (MEDIA)**: `AuthProvider.bootstrap()` llamaba a la función de
  refresh directo, sin pasar por el mismo mutex (`refreshInFlight`) que
  ya protegía el reintento automático tras un 401 de `apiRequest` — dos
  llamadas casi simultáneas con el MISMO refresh token (de un solo uso)
  podían hacer que `apps/api` respondiera 200 a una y 401 a la otra, y el
  `catch` de la perdedora borraba el token recién rotado por la ganadora,
  deslogueando a un usuario con sesión válida (reproducido en vivo por la
  auditoría, en `vite dev` Y en el build de producción real con `vite
  preview`). `client.ts` agrega `refreshSessionOnce()` como único punto de
  entrada externo; `bootstrap()` lo usa ahora. El lock cross-tab
  (multi-pestaña, cada una con su propio mutex en memoria de módulo)
  queda fuera de esta corrección puntual.
- **RF-03 (BAJA)**: el enrolamiento de 2FA prometía "escanea el código
  QR" pero no renderizaba ningún QR real. Se agrega la dependencia
  `qrcode` (generación 100% en cliente, sin red) y un `<canvas
  role="img">` con el QR real del `otpauthUrl`; el secreto/URL en texto
  plano se conservan sin cambios como alternativa accesible.
- **RF-04** (contraste del toast de "Propuesta económica generada" en
  `test:e2e:full`) ya estaba cerrado antes de esta corrección (commit
  `40b3dfe`, en `main` pero fuera del HEAD que congeló la auditoría) — se
  reprodujo `test:e2e:full` 2/2 veces en esta ronda como verificación:
  **116 passed, 0 failed** ambas corridas, sin código nuevo.

## Ronda 4 — correcciones de la auditoría adversarial (WI-01..05)

`docs/auditoria-2/web-integrado.md` (auditor independiente, solo hallazgo)
encontró 5 hallazgos nuevos, ninguno crítico. Estado tras esta ronda (ver
también la columna "Estado reparación" de ese documento):

- **WI-01 (Media, seguridad frontend)** — Content-Security-Policy real +
  cabeceras de seguridad. Ver "Seguridad: Content-Security-Policy y
  cabeceras" más abajo.
- **WI-02 (Media, REQ-098)** — el `<input type="file">` de subida de
  documentos ahora valida tipo/tamaño en cliente (`accept` + un mensaje
  honesto antes de leer el archivo) — ver `src/lib/validateDocumentFile.ts`.
  El servidor sigue siendo la validación real (magic bytes + ~22MB); esto
  es un mensaje temprano, no un reemplazo.
- **WI-03 (Baja/Media, sesión)** — `logout()` ahora llama a
  `queryClient.clear()` y `switchOrg()` elimina las queries admin/globales
  sin `currentOrgId` en su clave — ver `src/lib/queryClient.ts`.
- **WI-04 (Baja, idempotencia/permisos)** — los botones Aprobar/Rechazar de
  `TarifasAprobadasPage` se deshabilitan (por fila, no toda la tabla)
  mientras su decisión está pendiente y hasta que el estado real se
  refresca; un 409 de la API se muestra con un mensaje honesto en vez del
  genérico. La condición de estado previo en el servidor (`UPDATE ... SET
  status = ... WHERE status = 'draft'`) es responsabilidad del lado API de
  esta misma ronda (ver `apps/api`).
- **WI-05 (Baja, reproducibilidad)** — `test:e2e:full` arranca `apps/api`
  con `RATE_LIMIT_PROFILE=e2e` (ver "Determinismo de `test:e2e:full`" más
  abajo).

## Ronda 3 — arquitectura de datos y sesión

- **Cliente API tipado** (`src/lib/api/`): `http.ts` (fetch de bajo nivel,
  `ApiError` con mensaje real + `request_id` de la respuesta
  `application/problem+json` de la API, reintento de 429 con backoff
  respetando `Retry-After`), `client.ts` (`apiRequest`: inyecta
  `Authorization`/`X-Org-Id`, reintenta automáticamente 401→refresh→
  reintento), `schemas.ts` (esquemas zod escritos a mano a partir del código
  real de `apps/api/src/modules/*/schemas.ts` — no hay generación
  automática desde OpenAPI porque eso requiere la API arrancada con una
  sesión válida en `/docs/json`; se mantienen sincronizados a mano) y un
  archivo por dominio (`auth.ts`, `organizations.ts`, `company.ts`,
  `tenders.ts`, `matching.ts`, `go-no-go.ts`, `agents.ts`, `admin.ts`).
- **Sesión real** (`src/hooks/useAuth.tsx`): `AuthProvider`/`useAuth()`
  hidratan usuario (`GET /me`) y memberships (`GET /organizations`) tras el
  login o al restaurar sesión desde un refresh token guardado. El **access
  token vive solo en memoria** (nunca en `localStorage`); el **refresh
  token se persiste en `localStorage`** — riesgo documentado en
  `src/lib/api/session.ts`: `apps/api` lo emite en el CUERPO de
  `/auth/login`/`/auth/refresh`, no como cookie httpOnly, así que el
  cliente no tiene forma de evitar que JavaScript (y por tanto un XSS)
  pueda leerlo. La mitigación real (cookies httpOnly + rotación en el
  servidor) requeriría un cambio de contrato en `apps/api`, fuera del
  alcance de `apps/web`.
- **Guard de rutas (W-12)**: `src/components/auth/RequireAuth.tsx` protege
  todo lo que cuelga de `<AppShell/>`, redirigiendo a `/login` sin sesión.
  La barrera real sigue siendo la API en cada petición (`Authorization:
  Bearer`, `app.requireOrg`, `app.requireSuperadmin`) — el guard solo evita
  mostrar el layout antes de que la primera petición falle.
- **Selector de organización real** (`OrganizationSwitcher.tsx`): lista las
  memberships reales del usuario (`GET /organizations`, con su rol real) y
  cambia el header `X-Org-Id` que usan todos los hooks de dominio
  (`useCompany`, `useTenders`, `useMatching`, `useGoNoGo`, `useAgents`). El
  servidor sigue revalidando la membresía real en cada petición.
- **Permisos en la UI**: cada página deriva de `currentMembership.role` si
  debe mostrar/deshabilitar una acción de escritura (p. ej. "Guardar
  perfil" solo si `owner`/`admin`), pero **nunca como única barrera** — la
  API decide de verdad, y un 403 real se muestra con `<ErrorState/>` (ver
  `/backoffice/organizaciones` para un usuario sin superadmin).

## Cómo correr

```bash
# Desde la raíz del monorepo (workspaces de npm)
npm install

npm run -w apps/web dev            # servidor de desarrollo (puerto 8080)
npm run -w apps/web build          # build de producción (tsc -b && vite build)
npm run -w apps/web preview        # sirve el build de dist/

npm run -w apps/web lint           # eslint .
npm run -w apps/web typecheck      # tsc -b --noEmit (modo estricto, incluye e2e/)
npm run -w apps/web test           # vitest run (pruebas de componente, jsdom)
npm run -w apps/web test:watch     # vitest en modo watch
npm run -w apps/web test:coverage  # vitest run --coverage
npm run -w apps/web test:e2e       # build de producción + Playwright (navegador real) + axe-core
npm run -w apps/web test:e2e:full  # arranca apps/api real (PGlite) + siembra + Playwright completo
```

La primera vez que se corre `test:e2e`, instala el navegador de Playwright
con `npx playwright install chromium` (una sola vez por máquina/CI).

**`test:e2e` vs `test:e2e:full` (ronda 3):** con el guard de rutas real
(W-12), casi ninguna pantalla es alcanzable sin sesión. `test:e2e` a secas
(sin `apps/api` corriendo) sigue funcionando para lo que es alcanzable sin
sesión (fundamentalmente `/login`, vía el fixture `noAuthPage` — ver
`e2e/fixtures.ts`); para ejercitar el resto (24 rutas del sidebar, el
recorrido de negocio completo) hace falta una API real, y `test:e2e:full`
(`apps/web/scripts/e2e-full.mjs`) la levanta automáticamente: arranca
`apps/api` con PGlite en memoria, espera `/healthz`, construye `apps/web`
apuntando a esa API, corre la suite Playwright completa y apaga la API al
terminar (propagando el código de salida real).

**Determinismo de `test:e2e:full` (ronda 4, WI-05).**
`docs/auditoria-2/web-integrado.md` encontró que la suite no era
determinísticamente verde: `e2e/skip-link.spec.ts` recorre ~29 rutas
seguidas, cada una con varias peticiones de arranque de sesión, y podía
autoinducir un `429` real contra el límite global de `apps/api`. Dos
mitigaciones:

- `scripts/e2e-full.mjs` arranca `apps/api` con `RATE_LIMIT_PROFILE=e2e`
  (ver `apps/api/src/lib/rate-limit-settings.ts` — literal exacto, nunca
  activado por defecto ni por `NODE_ENV`, exclusivo de este harness), que
  eleva los límites muy por encima de cualquier tráfico legítimo real.
- `e2e/skip-link.spec.ts` además espacia sus peticiones cada 5 rutas
  (`page.waitForTimeout`, solo activo en modo "full") como capa adicional,
  no como la única mitigación.

De paso se corrigió un bug de infraestructura de la propia suite
(`playwright.config.ts`): Playwright vuelve a importar el archivo de
configuración dentro de cada proceso *worker*, así que calcular el puerto a
partir de `process.pid` sin fijarlo en ningún sitio hacía que cada worker
recalculara un puerto DISTINTO al que de verdad tenía `vite preview`
corriendo (`ERR_CONNECTION_REFUSED` real, reproducido corriendo la suite
con más de un worker sin `PLAYWRIGHT_PORT` explícito) — ahora se fija en
`process.env.PLAYWRIGHT_PORT` la primera vez que se evalúa el módulo, y los
procesos worker (que heredan el `env` de Node por defecto) lo reutilizan en
vez de recalcular el suyo.

Variables de entorno (`.env`, ver `.env.example`):

- `VITE_API_URL` — URL base de `apps/api` (ver `src/lib/api/http.ts`).
  Un fallo de red real lanza `ApiError` con su mensaje real (nunca una
  respuesta simulada); un error de la API (4xx/5xx) conserva su
  `request_id` real (`application/problem+json`) para mostrarlo en
  `<ErrorState/>`.

## Estructura

```
src/
  App.tsx                  # Router raíz, AuthProvider, RequireAuth, lazy routes, error boundary
  main.tsx                 # entry point
  index.css                # tokens de diseño (HSL), tipografías, dark mode, keyframes del logo
  config/navigation.ts     # única fuente de verdad del sidebar (grupos + items + rutas)
  lib/
    utils.ts               # cn() (clsx + tailwind-merge)
    datetime.ts             # formato America/Mexico_City (plazos/aclaraciones de convocatorias)
    renderSimpleMarkdown.tsx # Markdown mínimo propio (ronda 5, aviso de privacidad — sin dependencia nueva)
    api/                    # cliente API tipado hacia apps/api (ver "Ronda 3" arriba)
      http.ts, session.ts, client.ts, schemas.ts
      auth.ts, organizations.ts, company.ts, tenders.ts, matching.ts, go-no-go.ts, agents.ts, admin.ts
      expediente.ts, audit.ts, legal.ts, twofa.ts  # ronda 5
  hooks/
    useAuth.tsx              # AuthProvider/useAuth() — sesión real
    useCompany.ts, useTenders.ts, useMatching.ts, useGoNoGo.ts, useAgents.ts, useAdmin.ts
    useExpediente.ts, useMemberships.ts, useAuditLog.ts, useTwoFactor.ts  # ronda 5
  components/
    AtiendeLogo.tsx         # AtiendeMark / AtiendeWordmark (mismo glifo que atiende-restaurantes)
    ThemeSelector.tsx        # claro/sistema/oscuro; vive en el header (md+) y en el drawer (<md, W-21)
    SkipLink.tsx              # "saltar a..." con foco real (.focus() explícito, no solo href="#id")
    AiDisclosureNote.tsx       # aviso de uso de IA (REQ-115), antepuesto a módulos con `disclosure: true`
    StepUpDialog.tsx            # modal de step-up 2FA (ronda 5, REQ-044/064)
    expediente/TenderSelect.tsx  # selector de convocatoria compartido por los módulos del expediente (ronda 5)
    auth/
      RequireAuth.tsx          # guard de rutas real (W-12)
    layout/
      AppShell.tsx            # layout raíz: sidebar desktop + drawer móvil (Sheet) + header + main
      SidebarNav.tsx           # contenido de navegación (compartido entre sidebar y drawer)
      SectionHeader.tsx        # encabezado estándar de cada página de módulo
      OrganizationSwitcher.tsx # selector de organización real (memberships de /me)
      UserMenu.tsx              # identidad real + logout real (revoca el refresh token)
    ui/                      # primitivas shadcn/ui adaptadas (button, card, dialog, sheet, table,
                              # tabs, select, dropdown-menu, form, sonner, tooltip, separator,
                              # scroll-area, skeleton, badge, empty-state, error-state, loading-state,
                              # textarea, source-status-badge, package-status-badge)
  pages/
    LoginPage.tsx            # pantalla partida (kicker + h1 serif + lámina), solo contraseña (ver abajo)
    login.css                 # fuente Fraunces del titular, exclusiva de esta pantalla
    NotFoundPage.tsx          # ruta desconocida (catch-all)
    ResourceNotFoundPage.tsx  # ronda 5: guard 404 de tenant cruzado (403 de otra org -> "no encontrado")
    PrivacyNoticePage.tsx     # ronda 5: aviso de privacidad real (GET /legal/privacy-notice), ruta pública /privacidad
    createModulePage.tsx     # fábrica: SectionHeader + EmptyState honesto (módulos aún sin backend, ya ninguno en ronda 5)
    empresa/                 # Perfil y capacidades, Documentos y vigencias, Firmantes, Tarifas — datos reales
    convocatorias/            # Descubrimiento, detalle (con guard 404), Matching, Fuentes y frescura — datos reales
    evaluacion/                # Go/No-Go, Análisis de bases (documentos+matriz+conflictos, ronda 5) — datos reales
    preparacion/                # Cumplimiento documental, Redacción, Revisión, Expediente, Aprobaciones
                                 # — conectadas en ronda 5 contra /expediente/tenders/:tenderId/...
    entrega/                     # Entregas, Paquete descargable, Seguimiento post-adjudicación — ídem, ronda 5
    backoffice/                   # Organizaciones, Agentes y herramientas, Usuarios y roles, Auditoría,
                                   # Conectores, Jobs, Costos, Incidentes, Aprobaciones — todas reales (ronda 5
                                   # cierra Usuarios y roles/Auditoría/Aprobaciones cross-org)
    ConfiguracionPage.tsx     # ronda 5: enrolamiento 2FA real (antes placeholder genérico)
  test/
    setup.ts                 # jest-dom + vitest-axe + servidor MSW (server.listen/reset/close) + limpia sesión
    utils.tsx                # renderWithProviders() (QueryClient + Router + TooltipProvider + AuthProvider)
    msw.ts                   # servidor MSW compartido (éxito/401/403/500/red caída en pruebas de componente)
e2e/                          # suite Playwright + axe-core sobre el navegador real (REQ-049/065)
  fixtures.ts                 # `page` (admin, login fresco por worker), `writerPage`, `noAuthPage`
  global-setup.ts             # siembra orgs A/B/C + 2 usuarios + una convocatoria real (orgC, ronda 5) vía la propia apps/api
  seed-client.ts               # cliente HTTP mínimo del seed (independiente del cliente de producción); ingestTender (ronda 5)
  ronda3-flujo-real.spec.ts    # login→cambiar org→perfil→documento→tarifa→convocatorias vacías→403
  recorrido.spec.ts            # login→shell, las 30+ rutas del sidebar, drawer móvil, tema oscuro,
                                # Fuentes y frescura, Paquete sin convocatorias, sin scroll horizontal a 390px
  expediente-flujo-completo.spec.ts  # ronda 5: bases→matriz→propuesta→checklist→revisión/aprobación (2FA
                                       # real, 2 actores)→paquete borrador→listo→descarga→presentación;
                                       # A11/A12/A14, axe, 320/390
  contraste.spec.ts, heading-order.spec.ts, login-landmarks.spec.ts, login-parity.spec.ts,
  skip-link.spec.ts, touch-targets.spec.ts, ai-disclosure.spec.ts  # regresión por hallazgo (ver
                                                                     # docs/auditoria-1/web*.md)
playwright.config.ts          # sirve dist/ con `vite preview`; proxy a apps/api real en modo "full"
vite.config.ts                 # proxy /auth,/company,/tenders,... → apps/api real (solo con E2E_API_URL,
                                 # evita el bug de CORS de apps/api — ver "Endpoints y gaps de API")
```

## Decisiones de esta ronda

- **Un solo sistema de toast (Sonner).** El proyecto de origen
  (`atiende-restaurantes`) mantenía Radix Toast *y* Sonner en paralelo sin un
  criterio documentado de cuándo usar cada uno. Aquí se eligió **solo
  Sonner** (`src/components/ui/sonner.tsx`) detrás de cada notificación, para
  no repetir esa ambigüedad.
- **Cómo se resolvió móvil.** El admin de `atiende-restaurantes` era
  desktop-only (sin drawer de navegación en móvil, solo un header reducido).
  Aquí el sidebar se convierte en un **drawer accesible (`Sheet` de Radix)**
  por debajo del breakpoint `md`, con botón hamburguesa (`aria-label`, foco
  gestionado por Radix Dialog) y el mismo contenido de navegación
  (`SidebarNav`) que la sidebar de escritorio, para que analistas puedan
  operar el back office desde tablet/móvil.
- **`react-query` desde el día uno.** El origen tenía `@tanstack/react-query`
  instalado pero casi sin usar (fetch manual con `useState/useEffect`). Aquí
  se usa consistentemente (ver `OrganizationSwitcher`) para cache/reintentos.
- **Sin datos de demo.** Cada módulo del sidebar muestra un `EmptyState` con
  un mensaje específico del dominio (p. ej. "Aún no hay convocatorias
  descubiertas") en vez de datos ficticios que parezcan reales. `ErrorState`
  siempre muestra el mensaje real del error (`err.message`) con acción de
  reintentar. El paquete descargable de Entrega y seguimiento **nunca**
  arranca en estado "Listo" — solo "Borrador" hasta que exista una validación
  real de completitud en el backend.
- **Ampliación de back office** (ver `docs/AMPLIACION-BACKOFFICE.md`): se
  añadió el grupo **Empresa** (perfil/capacidades, documentos y vigencias,
  firmantes autorizados, tarifas aprobadas), **Fuentes y frescura** dentro de
  Convocatorias (estado explícito por fuente — ok/caída/CAPTCHA/cambio de
  interfaz/permisos faltantes, nunca silencio interpretado como cero
  oportunidades — vía `SourceStatusBadge`), y **Expediente**/**Aprobaciones**
  dentro de Preparación, y **Paquete descargable** dentro de Entrega y
  seguimiento, con el aviso permanente de que la presentación y firma las
  realiza el usuario.
- **tsconfig estricto de verdad.** A diferencia del origen (`strict: false`
  a propósito), aquí `tsconfig.app.json` tiene `strict`, `noUnusedLocals` y
  `noUnusedParameters` en `true`.
- **`vitest-axe` en vez de auto-extender vía `@testing-library/jest-dom/vitest`
  o `vitest-axe/extend-expect`.** Este monorepo mezcla versiones de Vitest
  entre workspaces (`packages/*` usa `vitest@^2`, `apps/web` usa `vitest@^4`
  para soportar Vite 6), así que npm hoistea una sola instancia de Vitest a
  la raíz y anida la de `apps/web`. Los imports de conveniencia de esas
  librerías hacen su propio `import { expect } from "vitest"`, que se
  resuelve — por cómo Node busca módulos — contra la instancia equivocada
  (la de la raíz). Por eso `src/test/setup.ts` importa solo los *matchers*
  (que no dependen de una instancia de Vitest) y los registra a mano contra
  el `expect` correctamente resuelto de `apps/web`. También se añadió
  `src/test/vitest-axe.d.ts` porque los tipos de `vitest-axe@0.1.0` están
  escritos para una forma antigua de los tipos de Vitest (`namespace Vi`) que
  Vitest 4 ya no expone.
- **`NODE_OPTIONS=--no-experimental-webstorage` en los scripts de test.**
  Node 25 añadió un `localStorage` global experimental que, sin
  `--localstorage-file`, queda roto (el objeto existe pero sin métodos) y
  pisa el `localStorage` real de jsdom dentro de los tests. Se desactiva
  explícitamente para que `ThemeSelector` y `SidebarNav` (que sí usan
  `localStorage`) funcionen igual en test que en el navegador real.

## Paridad del login con Restaurantes (W-11)

`docs/investigacion/frontend-restaurantes.md` (la base documentada para la
paridad visual) describe el login real de `atiende-restaurantes` como "tabs
contraseña/enlace mágico" — pero el `AdminLogin.tsx` real de ese repo
(revisado directamente en código para esta corrección, sin tocar su `.env`
ni sus datos) es otra cosa: un layout de **pantalla partida** (formulario a
la izquierda, lámina fotográfica a la derecha), con un **kicker** ("Acceso
al panel"), un **titular en serif** (`Fraunces`, no la fuente del resto del
panel), un botón **"Continuar con Google"** (`signInWithOAuth`) y **sin
formulario de contraseña** (solo enlace mágico por correo). El documento de
investigación quedó incompleto en este punto; esta corrección alinea
`LoginPage.tsx` a la anatomía real que sí se pudo verificar en código,
manteniendo divergencias deliberadas para el dominio de licitaciones:

| Aspecto | Restaurantes (real) | Licitaciones (aquí) | Por qué diverge |
|---|---|---|---|
| Layout | Pantalla partida, formulario + lámina fotográfica | Igual (pantalla partida, formulario + lámina) | Adoptado tal cual — es la anatomía real de la marca |
| Kicker + titular serif (`Fraunces`) | Sí | Sí | Adoptado tal cual |
| Lámina derecha | Foto de una cocina comercial (`login-hero.png`) | Degradado con los tokens de marca (`--primary` → fondo oscuro) | Una foto de cocina es del dominio equivocado (restaurantes, no licitaciones) y no existe un asset equivalente con licencia para licitaciones; se prefirió un degradado honesto a inventar/copiar una imagen que no representa el producto |
| Métodos de acceso | Solo enlace mágico + Google OAuth | Solo contraseña, sin tabs ni OAuth | **Ronda 3**: apps/api solo expone `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout` — no existe ningún endpoint `/auth/magic-link` ni equivalente. La ronda 2 había implementado una pestaña de "enlace mágico" que llamaba a un endpoint inexistente (nunca podía funcionar); se retiró en vez de mantener una acción de UI sin backend real detrás |
| Roles / redirect post-login | Lógica de `superadmin` vs. `admin` específica de restaurantes | Redirección real a `/panel` tras `POST /auth/login`; sin lógica de rol en el login mismo (el rol se resuelve por organización, ver `OrganizationSwitcher`) | Atiende Licitaciones es multi-organización con rol POR organización (no un rol global de usuario) — no hay un análogo directo al `superadmin` de restaurantes en el login |

## Seguridad de dependencias — `npm audit` (W-04)

`npm audit --workspace apps/web` reporta actualmente "5 vulnerabilities (3
moderate, 1 high, 1 critical)" **incluso en un clon limpio**, y esto **no es
un defecto de `apps/web`**: las 5 provienen de una copia vieja de
`esbuild`/`vite` anidada bajo `vitest`/`vite-node`, arrastrada porque el
resto del monorepo (`apps/api`, `packages/agents`, `packages/db`,
`packages/expediente`, `packages/sources`) fija `"vitest": "^2.1.8"` como
dependencia de desarrollo, mientras `apps/web` necesita `vitest@^4` (para
Vite 6). `npm audit --workspace <nombre>` no aísla el árbol de dependencias
reales de ese workspace cuando hay conflictos de hoisting entre workspaces
del mismo lockfile — es una limitación conocida de `npm`, no de este código.
Verificado con `npm ls vitest` (`docs/logs/fix-web-w04.log`): todas las
apariciones de la versión vulnerable de `esbuild`/`vite` cuelgan de la
`vitest@2.1.8` de otros workspaces, ninguna de la `vitest@4.1.11` que declara
`apps/web/package.json`. Son vulnerabilidades de **herramientas de
desarrollo/test** (servidor dev de esbuild/Vite), no de código que llegue al
bundle de producción de `apps/web` (`vite build` no las incluye).

Corrección real posible: que los workspaces que fijan `vitest@^2.1.8` (fuera
del ámbito de `apps/web`, ver `docs/PROGRESO.md`) suban a una versión sin
esta cadena de arrastre. Mientras tanto, no tomar el "0 vulnerabilities" de
un `npm audit --workspace apps/web` en un clon *verdaderamente* aislado
(solo `apps/web/` sin el resto del monorepo) como el estado real del
lockfile compartido — ambos números son ciertos, pero miden árboles
distintos.

**Matiz (W-20): no "ninguna" dependencia propia de `apps/web` toca la cadena
vulnerable, sino "ninguna en runtime".** El párrafo anterior, tal como quedó
tras la corrección de W-04, decía que ninguna aparición vulnerable "cuelga
de la `vitest@4.1.11` que declara `apps/web/package.json`" — dando a
entender que el origen es exclusivamente de otros workspaces. Eso es
incompleto: `apps/web` declara `vitest-axe` como devDependency propia (no de
otro workspace), y su peer-dependency (`"vitest": ">=0.16.0"`, sin tope
superior) sí resuelve, en el árbol de npm compartido del monorepo, hacia el
`vitest@2.1.9` vulnerable en vez de hacia la `vitest@4.1.11` propia de
`apps/web`:

```
$ npm ls vitest
atiende-licitaciones@0.1.0 /ruta/al/repo
└─┬ @atiende/web@0.1.0 -> ./apps/web
  ├─┬ @vitest/coverage-v8@4.1.11
  │ └── vitest@4.1.11 deduped
  ├─┬ vitest-axe@0.1.0
  │ └── vitest@2.1.9
  └── vitest@4.1.11
```

Esto **no cambia el veredicto de fondo de W-04**: la resolución de un
peer-dependency en el árbol de `npm` no significa que el código se ejecute.
`vitest-axe` nunca hace `require("vitest")`/`import ... from "vitest"` en su
paquete publicado — confirmado por grep, sin ningún resultado:

```
$ grep -rn "require(.vitest.)\|from \"vitest\"\|from 'vitest'" node_modules/vitest-axe/dist
(sin resultados)
```

Sus tipos (`vitest-axe/matchers`) y sus matchers en sí son agnósticos de la
instancia de Vitest que los registre (por eso `src/test/setup.ts` los
registra a mano contra el `expect` correcto, ver más arriba) — el
`vitest@2.1.9` que resuelve el peer nunca llega a ejecutarse en los tests
de `apps/web` ni, por supuesto, en su bundle de producción. La corrección
real seguiría siendo la misma que ya documentaba W-04 (que los otros
workspaces suban de `vitest@^2`), no algo que `apps/web` pueda resolver
unilateralmente:

**Por qué no se añadió `overrides`/`resolutions`.** `npm` solo aplica el
campo `overrides` cuando está declarado en el `package.json` de la **raíz**
del workspace tree — un `overrides` dentro de `apps/web/package.json` no
tiene ningún efecto sobre cómo `npm` resuelve `vitest-axe` en el árbol
compartido, así que la única forma real de forzar esa resolución sería
editar el `package.json` raíz (y regenerar el lockfile raíz), lo que
recalcularía las dependencias de **todos** los workspaces (`apps/api`,
`packages/*`) — fuera del ámbito exclusivo de esta corrección (`apps/web`) y
con riesgo real de interferir con el trabajo concurrente de otros agentes
sobre esos mismos paquetes. Se documenta el matiz aquí en vez de forzar un
cambio de alcance más amplio que el mandato de esta ronda.

## Control de acceso (W-12) — ronda 3

`RequireAuth` (`src/components/auth/RequireAuth.tsx`) protege TODO lo que
cuelga de `<AppShell/>`: sin una sesión válida (`useAuth().status !==
"authenticated"`), redirige a `/login` conservando la ruta pedida en
`location.state.from` para volver ahí tras iniciar sesión. La sesión se
restaura al recargar la pestaña si hay un refresh token guardado
(`AuthProvider`, ver "Ronda 3 — arquitectura de datos y sesión" arriba); si
el refresh falla (expirado/revocado), la sesión se limpia y el guard
redirige igual. Esto sigue siendo una comodidad de UI, no la barrera de
seguridad real: cada endpoint de `apps/api` exige `Authorization: Bearer` y
valida membresía/rol por su cuenta (`app.requireOrg`, `app.requireSuperadmin`)
sin importar lo que la UI decida mostrar u ocultar.

## Seguridad: Content-Security-Policy y cabeceras (ronda 4, WI-01)

`docs/auditoria-2/web-integrado.md` (WI-01, Media) encontró que no existía
NINGUNA Content-Security-Policy en todo el sistema: `apps/api` registra
`@fastify/helmet` con `contentSecurityPolicy: false` explícito, y el HTML/JS
que sirve `apps/web` no llevaba ninguna cabecera de seguridad propia. Esto
agravaba el riesgo ya documentado de que el refresh token vive en
`localStorage` (ver arriba, "Ronda 3 — arquitectura de datos y sesión"):
sin CSP, un XSS con acceso a `document`/`window` tendría vía libre para
inyectar un `<script>` y leer ese token.

**Qué se agregó** (fuente única de verdad: `src/lib/security/csp.ts`):

- `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'
  https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com;
  img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri
  'self'; form-action 'self'` — sin `'unsafe-inline'` ni `'unsafe-eval'` en
  `script-src`: un `<script>` inline inyectado dinámicamente (el patrón
  clásico de un XSS) no se ejecuta bajo esta política (verificado con un
  test E2E real contra el navegador, `e2e/csp.spec.ts`, no solo leyendo el
  string de la política).
- `style-src` sí incluye `'unsafe-inline'`: Radix UI (base de casi todos
  los componentes de `src/components/ui/`) posiciona popovers/tooltips con
  `style="..."` calculado en tiempo de ejecución; no hay un mecanismo de
  nonce/hash práctico para eso sin parchear la librería. El riesgo real que
  importa mitigar (ejecución arbitraria de JS) sigue cerrado por
  `script-src`; permitir estilos inline es un trade-off deliberado, mucho
  menor.
- `connect-src 'self'` asume que producción sirve `apps/web` y `apps/api`
  bajo el MISMO origen (vía un reverse proxy — ver "Bug real de apps/api...
  CORS" más abajo, que documenta por qué esto además evita ese bug). Si un
  despliegue real usa `VITE_API_URL` apuntando a un origen distinto,
  `connect-src` debe ampliarse para incluirlo explícitamente (editar
  `src/lib/security/csp.ts`) — de lo contrario el propio navegador
  bloqueará las peticiones a la API bajo esta CSP.
- Dos mecanismos, misma fuente (`vite.config.ts`, plugin
  `atiende-security-headers`):
  1. Un `<meta http-equiv="Content-Security-Policy">` inyectado en el
     `index.html` de producción (`vite build`/`npm run -w apps/web
     build`) — funciona incluso en un hosting puramente estático que no
     pueda añadir cabeceras HTTP propias. Deliberadamente NO se inyecta en
     `vite dev` (rompería el preámbulo inline de Fast Refresh de
     `@vitejs/plugin-react-swc`; sin impacto real, nadie navega a `vite
     dev` en producción).
  2. Cabeceras HTTP reales en `npm run -w apps/web preview` (`vite
     preview`, el mismo artefacto que llegaría a producción) —
     `Content-Security-Policy` (con `frame-ancestors 'none'`, que el
     estándar CSP ignora dentro de un `<meta>`, ver
     https://www.w3.org/TR/CSP3/#meta-element), `X-Content-Type-Options:
     nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy:
     strict-origin-when-cross-origin`. Verificado con `curl -sD -` contra
     un `vite preview` real (antes de esta corrección, esa misma
     verificación no traía ninguna cabecera).

**Para producción real (nginx/Caddy sirviendo el `dist/` estático)**: el
meta tag y las cabeceras de `vite preview` cubren desarrollo/staging/E2E,
pero un hosting estático real (nginx, Caddy, un CDN) debe fijar las MISMAS
cabeceras a nivel de servidor — son más difíciles de evadir que un meta tag
(p. ej. `frame-ancestors` solo funciona como cabecera real) y no dependen de
que el HTML se sirva sin modificar. Ejemplo nginx (ajustar `connect-src` si
`apps/api` vive en otro origen):

```nginx
location / {
    root /var/www/atiende-web/dist;
    try_files $uri /index.html;

    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
}
```

Ejemplo Caddy (`Caddyfile`):

```caddy
atiende.example.com {
    root * /var/www/atiende-web/dist
    try_files {path} /index.html
    file_server

    header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
    header X-Content-Type-Options "nosniff"
    header X-Frame-Options "DENY"
    header Referrer-Policy "strict-origin-when-cross-origin"
}
```

**TODO pendiente (fuera de alcance de `apps/web` en esta ronda): mover el
refresh token de `localStorage` a memoria + cookie httpOnly.** La CSP de
arriba es defensa en profundidad (reduce la probabilidad de que un XSS
llegue a ejecutarse), no elimina el riesgo de fondo: mientras el refresh
token siga siendo legible por JavaScript (`localStorage`, ver
`src/lib/api/session.ts`), un XSS que sí lograra ejecutarse podría leerlo y
rotarlo indefinidamente. La mitigación real (cookie httpOnly + rotación del
lado del servidor, invisible para JavaScript) requiere que `apps/api` deje
de emitir el refresh token en el CUERPO de `/auth/login`/`/auth/refresh`
(`authTokensSchema`, `apps/api/src/modules/auth/schemas.ts`) y en su lugar
lo emita como `Set-Cookie: HttpOnly; Secure; SameSite=Strict`, además de
leerlo de la cookie (no del body) en `/auth/refresh` — un cambio de
contrato de `apps/api` que no existe hoy y está fuera del ámbito exclusivo
de esta corrección de `apps/web` (ver alcance en
`docs/auditoria-2/web-integrado.md`). Rastrear este TODO junto con REQ-098
(seguridad de credenciales) hasta que `apps/api` ofrezca esa opción.

## Módulos sin conectar (histórico, ronda 3-4 — cerrado en ronda 5)

Hasta ronda 4, `apps/api` no exponía endpoints para **Análisis de bases**,
**Cumplimiento documental**, **Redacción**, **Revisión**, **Expediente**,
**Aprobaciones** (Preparación), **Entregas**, **Paquete descargable** ni
**Seguimiento post-adjudicación** — todos mostraban el `EmptyState`
genérico de `createModulePage.tsx`. Ronda 5 conecta los 9 contra las 26
rutas reales de `/expediente/tenders/:tenderId/...` (ver sección "Ronda 5"
arriba); no queda ningún módulo de dominio sin conectar.

## Endpoints de apps/api que existían pero no se conectaron (histórico, cerrado en ronda 5)

Los tres gaps documentados hasta ronda 4 ya están conectados:

- **Usuarios y roles** — `GET /organizations/:orgId/memberships` (ronda 4
  de apps/api) conectado en `UsuariosRolesPage.tsx` (listar, invitar,
  cambiar rol, eliminar).
- **Auditoría / Trazabilidad** — `GET /audit-log` conectado en
  `AuditoriaPage.tsx` (filtro por entidad y por `correlationId`, ronda 5).
- **Aprobación cross-org de tool_calls** — `POST
  /admin/tool-calls/:id/approve|deny` (ronda 4 de apps/api) conectado en
  `AprobacionesBackofficePage.tsx`: aprobar/denegar ya no exige cambiar de
  organización.

## Bug real de apps/api encontrado por la suite E2E: CORS no permite PUT/DELETE

`apps/api` registra `@fastify/cors` sin una lista explícita de métodos
(`apps/api/src/app.ts`), y el preflight real (verificado con
`curl -X OPTIONS`, ver `docs/logs/web-ronda3.log`) responde
`access-control-allow-methods: GET,HEAD,POST` — **sin PUT, DELETE ni
PATCH**. Esto bloquea, en CUALQUIER despliegue donde `apps/web` y `apps/api`
vivan en orígenes distintos (típico en desarrollo local con puertos
separados, no solo en la suite E2E), toda escritura real que use esos
métodos: `PUT /company/profile`, `DELETE /company/documents/:id`,
`DELETE /company/capabilities/:id`, `DELETE /company/signatories/:id`, etc.
El navegador rechaza la petición en el propio preflight — nunca llega a
tocar el servidor (confirmado: cero líneas en el log de `apps/api` para esas
peticiones cuando fallan así).

**No se corrigió aquí** (fuera del ámbito exclusivo de `apps/web`, y
`apps/api` es responsabilidad de otro agente). Mitigación DENTRO de este
ámbito, solo para `test:e2e:full`: `vite.config.ts` proxea las rutas de la
API al mismo origen que sirve el front cuando `E2E_API_URL` está definida
(el patrón de despliegue real más común — un reverse proxy compartiendo
origen), así el navegador nunca ve la petición como cross-origin y el bug
deja de bloquear la suite sin necesidad de tocar `apps/api`. Reportado para
que quien mantenga `apps/api` agregue `methods: ['GET','HEAD','PUT','PATCH','POST','DELETE']`
(o equivalente) a su registro de `@fastify/cors`.
