# Auditoría web integrado — ronda 3 (Atiende Licitaciones)

**Auditor**: agente adversarial independiente (Sonnet), sin contexto previo del proyecto.
**Alcance**: `apps/web` conectado a `apps/api` real (ronda 3), evaluado en un `git worktree`
aislado (`<scratchpad>/audit-web3`, HEAD `51044ab`), con `npm install` y `npx playwright
install chromium` propios. Puertos usados: API `3893` (y `3482`/`3800`+ en corridas previas),
web `5280` (y `4721`), todos verificados libres antes de usarse (no colisión con los otros
worktrees `reverify-api2*` activos en la misma máquina).

Metodología: lectura de `apps/web/README.md`, `docs/logs/web-ronda3.log`,
`docs/auditoria-1/web-reverificacion-2.md`, `docs/REQUISITOS.md` (secc. 11-12, 20-22, 29-33),
`docs/ACEPTACION.md` (A1-A5, A12) y `docs/AMPLIACION-BACKOFFICE.md` §9; después, ejecución
real de la suite (unit + `test:e2e:full`), lectura directa de código fuente de `apps/web` y
`apps/api` para verificar cada afirmación del README contra el código real (no se tomó
ninguna afirmación de README/ACEPTACION como cierta sin verificarla en código o en ejecución),
y una prueba Playwright ad-hoc propia (no committeada, solo su evidencia) para verificar
320px con datos reales, punto que la suite existente no cubre.

Se encontraron **5 hallazgos nuevos** (WI-01 a WI-05, ninguno crítico) y se confirmó
correcto un volumen sustancial de lo documentado — detallado en "Comprobado correcto" al
final. No se corrigió nada (auditor de solo hallazgo).

---

## 1. Reproducibilidad

**Unitarias**: `npm run -w apps/web test` → **63/63 en verde**, reproducible sin red ni
`apps/api` (jsdom + MSW). Único ruido: `axe-core` emite `Error: Not implemented:
HTMLCanvasElement.prototype.getContext` en jsdom (limitación conocida de jsdom sin el
paquete `canvas`, no afecta el resultado — los 63 tests igual pasan).

**`test:e2e:full` contra `apps/api` real** (PGlite en memoria, seed real vía la propia API):
corrido **dos veces** en esta ronda de auditoría, con puertos distintos cada vez
(`E2E_API_PORT`/`PLAYWRIGHT_PORT` aleatorizados como indica el propio script). Resultado
**idéntico** en ambas corridas y **idéntico** al de `docs/logs/web-ronda3.log` del agente
implementador:

```
89 passed
 2 flaky (recuperados en el reintento)
 3 failed — los 3 en e2e/skip-link.spec.ts (Expediente, Aprobaciones, Entregas)
```

Causa raíz confirmada en el log de esta corrida (no un supuesto): `429 Rate limit
exceeded` real de `apps/api` durante el barrido de las ~29 rutas de `skip-link.spec.ts`,
p. ej.:

```
Error: Login de seed falló (429) para e2e-admin-mtpkjeod@atiende.test:
{"type":"...","title":"Rate limit exceeded, retry in 9 seconds","status":429,...}
```

**No existe ningún `RATE_LIMIT_PROFILE` (ni variable equivalente) en `apps/api`** —
verificado con `grep -rn "RATE_LIMIT_PROFILE" apps/api` (sin resultados). El único límite
configurable es el hardcodeado en `apps/api/src/app.ts`: `rateLimit({ global: true, max:
100, timeWindow: '1 minute' })` más el override de `/auth/login` (`max: 5, timeWindow: '1
minute'`, `apps/api/src/modules/auth/routes.ts:123`). Como pidió el mandato, se documenta
como hallazgo en vez de inventar la variable:

- **WI-05 (Baja, Rubro 1 — Reproducibilidad)**: `test:e2e:full` no es determinísticamente
  verde de corrida en corrida por una condición de carrera real contra el limitador de
  tasa global de `apps/api` (100 req/min), específica de `e2e/skip-link.spec.ts` (recorre
  las ~29 rutas de `ALL_NAV_ITEMS` sin pausa, cada una disparando varias peticiones de
  arranque). Confirmado reproducible dos veces en esta auditoría, con el mismo patrón de
  fallo (siempre los mismos 3 tests) documentado ya por el agente implementador — **no es
  una regresión de código**, es un efecto de entorno/orquestación de la propia suite
  contra un límite de tasa que además es un requisito de seguridad real (no se debe
  relajar el límite en producción). El mandato de esta auditoría sugería
  `RATE_LIMIT_PROFILE=e2e`: esa variable **no existe** en el código, así que no pudo
  usarse. Reparación (no aplicada, fuera de mandato de un auditor de solo-hallazgo):
  añadir un perfil de rate-limit de test explícitamente fuera de producción en
  `apps/api`, o hacer que `skip-link.spec.ts` espacie sus peticiones (p. ej. un pequeño
  `waitForTimeout` cada N rutas) para no autoinducirse el límite que en sí mismo prueba
  que funciona.

`typecheck`/`lint`/`build` no se re-corrieron exhaustivamente por tiempo, pero `npm run
build` (usado para servir el bundle de producción a Playwright, dos veces) terminó limpio
las dos veces (`✓ built in ~1.2-1.4s`).

---

## 2. Sesión y auth en el navegador

**Dónde vive cada token** (verificado en `src/lib/api/session.ts`): access token **solo en
memoria** (variable de módulo, nunca `localStorage`); refresh token en
`localStorage["atiende.refreshToken"]`. Esto está **documentado honestamente** en el propio
código y en el README como una limitación de `apps/api` (el refresh token llega en el
CUERPO de `/auth/login`/`/auth/refresh`, no como cookie httpOnly) — **comprobado
correcto**, no hay nada oculto aquí.

**XSS → ¿robo de sesión?** Sí, sería posible: cualquier XSS con acceso a `localStorage`
puede leer `atiende.refreshToken` y rotarlo indefinidamente para mantener sesión. Este
riesgo YA está documentado por el propio proyecto (no es un hallazgo nuevo), pero su
mitigación de defensa en profundidad más obvia — una Content-Security-Policy real que
dificulte la inyección de script en primer lugar — **no existe en absoluto**, ver **WI-01**
abajo (rubro 6). Esa combinación (token legible por JS + cero CSP) sí es una novedad de
esta auditoría: el README documenta el primer hecho pero no menciona el segundo.

**Rotación de refresh / reutilización**: no se pudo ejercer un ataque de replay real de
principio a fin en esta ronda (tiempo), pero el propio comentario de
`e2e/global-setup.ts` confirma que `refresh_tokens` es de un solo uso con rotación real
del lado del servidor (`apps/api/src/modules/auth/routes.ts`) — el diseño de
`global-setup.ts` tuvo que evitar compartir un `storageState` estático PRECISAMENTE
porque un segundo consumidor del mismo refresh token ya rotado recibe 401. Esto es
evidencia indirecta pero real (un bug de comportamiento, no solo una promesa) de que la
rotación de un solo uso funciona.

**Logout**: `UserMenu.tsx` → `useAuth().logout()` llama a `POST /auth/logout` con el
refresh token (revocación real en servidor) y luego `clearTokens()` +
`writeStoredOrgId(null)` + limpia `user`/`memberships`/`currentOrgId` — **comprobado
correcto** para tokens y estado de React. Pero:

- **WI-03 (Baja/Media, Rubro 2 — Sesión)**: `logout()` (`src/hooks/useAuth.tsx`) **nunca
  llama a `queryClient.clear()`**; el `QueryClient` se crea en `src/App.tsx:45` y
  `useAuth.tsx` no tiene ninguna referencia a él. Verificado que las queries por
  organización (`useCompany`, `useTenders`, `useMatching`, `useGoNoGo`, `useAgents`) SÍ
  incluyen `currentOrgId` en su `queryKey` (grep completo de los 5 archivos de hooks), así
  que un cambio de organización normal **no** filtra datos de una org a otra (cada
  combinación org+recurso tiene su propia entrada de caché; al cambiar de org, la UI
  simplemente no tiene caché todavía para la org nueva → loading limpio, sin datos
  viejos). Pero las queries de `useAdmin.ts` (`["admin","organizations"]`,
  `["admin","jobs",status]`, `["admin","costs"]`, `["admin","incidents"]`,
  `["admin","approvals"]`) y `useSourceFreshness()` (`["tenders","sources-freshness"]`)
  **no** están asociadas a ningún usuario u organización en su clave. En un escenario de
  navegador compartido (kiosco, o dos analistas usando el mismo equipo sin recargar la
  pestaña entre sesiones), si un segundo usuario superadmin inicia sesión tras el logout
  del primero, esas pantallas renderizarán por un instante los datos EN CACHÉ de la
  sesión anterior (stale, `staleTime` global es `0` por defecto en
  `App.tsx:45-46`, así que sí se refresca en segundo plano al montar — pero primero
  pinta lo viejo). No es una fuga entre organizaciones (el dato admin es de toda la
  plataforma, visible a cualquier superadmin), pero sí es un residuo de sesión anterior
  visible brevemente en pantalla tras un logout real. Reparación: `queryClient.clear()`
  dentro de `logout()` (exponer el `queryClient` a `useAuth`, p. ej. inyectándolo como
  parámetro del `AuthProvider` o con un pequeño wrapper en `App.tsx`).

**Guard de rutas (W-12) + deep-link**: `RequireAuth.tsx` redirige a `/login` con
`state={{from: location}}` cuando `status === "unauthenticated"`; `LoginPage.tsx` (línea
93-94) lee `location.state.from.pathname` y navega ahí tras login exitoso, con `"/panel"`
como default — **comprobado correcto** en código (no hay red real de por medio necesaria
para verificar esta lógica, es determinística).

**401→refresh→reintento (idempotencia)**: `src/lib/api/client.ts` reintenta UNA vez tras
un 401, con una promesa de refresh compartida (`refreshInFlight`) para no disparar N
refresh en paralelo. Análisis: el `preHandler` de `apps/api` valida `Authorization` ANTES
de ejecutar cualquier handler de mutación (`app.authenticate`, ver
`apps/api/src/plugins/auth.plugin.ts`), así que un 401 significa que la mutación original
**nunca llegó a ejecutarse** — el reintento tras refrescar es la ÚNICA ejecución real, sin
riesgo de doble efecto por ESTE mecanismo específico. **Comprobado correcto.** (Ver WI-04
para un problema de doble-envío DISTINTO, no relacionado con 401/refresh.)

**Cambio de organización y caché**: cubierto arriba (WI-03) — el diseño de `queryKey` es
correcto para los recursos de negocio, el gap es solo en las claves admin/globales tras
un **logout**, no tras un cambio de organización.

---

## 3. Permisos en UI vs API

Patrón verificado consistentemente en `PerfilCapacidadesPage`, `DocumentosVigenciasPage`,
`FirmantesAutorizadosPage`, `TarifasAprobadasPage`, `GoNoGoPage`,
`AgentesHerramientasPage`: cada página deriva `canWrite`/`canEdit`/`canApprove`/`canDecide`
de `currentMembership.role` (viene de `GET /organizations`, no de `localStorage` ni de
nada que el cliente controle) y, si el rol no alcanza, muestra el control **deshabilitado
o ausente con una frase explícita** ("Tu rol (viewer) no puede...") en vez de ocultarlo sin
explicación. **Comprobado correcto** contra las 6 páginas revisadas.

**La API es la barrera real**, verificado con grep de `requireOrgRole`/`requireSuperadmin`
en `apps/api/src/modules/company/routes.ts` y `apps/api/src/modules/admin/routes.ts`:
cada mutación sensible (`PUT /company/profile`, `POST /company/documents`, `DELETE
/company/documents/:id`, `POST /company/rates`, `POST /company/rates/:id/approve|reject`)
llama a `requireOrgRole(request, ROLES, mensaje)` explícitamente dentro del handler, y
TODAS las rutas de `/admin/*` llevan `preHandler: [app.authenticate, app.requireSuperadmin]`
a nivel de registro de ruta. Un intento de manipular `currentMembership.role` en el
cliente (React DevTools, consola) no otorgaría nada real: el servidor no confía en
ningún dato de rol que venga del cliente, solo en lo que resuelve de la membresía real en
BD. **Comprobado correcto.**

`/backoffice/organizaciones` y el resto de `/backoffice/*` reservado a superadmin:
confirmado en código que exige `app.requireSuperadmin` server-side; el README documenta
que un usuario sin superadmin ve un 403 real vía `<ErrorState/>` — consistente con el
patrón general de "error real con `request_id`" (ver rubro 4).

**Gap real de integridad de estado** (no exactamente "permisos", pero adyacente —
documentado también en el rubro 2 como WI-04): las rutas `POST
/company/rates/:id/approve` y `.../reject` (`apps/api/src/modules/company/routes.ts:578-648`)
hacen un `UPDATE ... SET status = 'approved'|'archived' WHERE id = $1 AND org_id = $2`
**sin ninguna condición sobre el `status` actual de la fila**. El único gate de "solo se
puede aprobar/rechazar una tarifa en borrador" vive **en la UI** (`rate.status ===
"draft"` decide si se muestran los botones, `TarifasAprobadasPage.tsx:164`) — un
owner/admin real (rol correcto, sin ninguna manipulación de permisos) que repita la
petición HTTP directamente (o haga doble clic, ver WI-04) puede re-aprobar una tarifa ya
rechazada/archivada o re-escribir `approved_at`/`approved_by` de una ya aprobada, sin que
el servidor lo impida. No es una escalada de privilegios (el rol se sigue exigiendo), pero
sí es una violación de la máquina de estados esperada (draft→approved es unidireccional
según la propia descripción de la pantalla) y genera entradas de `audit_log` redundantes
para el mismo evento de negocio.

---

## 4. Honestidad de estados

**Loading/empty/error con `request_id`**: `describeApiError()` (`useAuth.tsx:156-160`)
concatena `(request_id: ...)` a cualquier mensaje de `ApiError` que traiga uno, y
`ApiError` lo extrae de la respuesta `application/problem+json` real
(`src/lib/api/http.ts` — RFC 7807: `type/title/status/detail/requestId`). Todas las
páginas revisadas usan `<ErrorState message={describeApiError(error)} onRetry={...}/>`.
**Comprobado correcto.**

**Fuentes y frescura — ¿real o demo estática?** `docs/ACEPTACION.md` (A4, escrito antes de
esta ronda) decía textualmente: *"UI: `source-status-badge.tsx` es demo estática no
conectada a `source_runs`"* → PENDIENTE. Se verificó en código que esto **ya no es
cierto** en ronda 3: `useSourceFreshness()` (`src/hooks/useTenders.ts:44-49`) llama a
`GET /tenders/sources/freshness`, que en `apps/api/src/modules/tenders/routes.ts:172-201`
ejecuta `select * from app.source_freshness()` (una función SQL real sobre
`source_runs`, ver `packages/db/migrations/0018_source_freshness.sql` citado en el propio
comentario del código) y calcula `ageSeconds` a partir de `last_success_at` real — nada
hardcodeado. Confirmado también en vivo: con una `apps/api` recién levantada sin ninguna
fuente configurada, la pantalla `/convocatorias/fuentes-frescura` muestra honestamente
"Aún no hay fuentes configuradas" (ver captura
`docs/auditoria-2/capturas-web/320px-convocatorias-fuentes-frescura.png`), no una lista
fabricada. **Este hallazgo de `ACEPTACION.md` (A4, parte UI) debe considerarse CERRADO** a
partir de esta verificación — queda pendiente que quien mantenga `docs/ACEPTACION.md`
actualice esa fila (fuera del alcance de escritura de esta auditoría).

**Paquete "Borrador" por defecto**: `PaqueteDescargablePage.tsx` deriva el estado con
`derivarEstadoPaquete({ checklistCompleto: false, firmasCompletas: false, anexosVigentes:
false })` — los 3 flags están hardcodeados en `false` porque, como documenta el propio
comentario, "esa lógica de backend no existe todavía en esta ronda". Nunca puede mostrar
"Listo" porque no hay ninguna vía en el código actual para que esos 3 flags se vuelvan
`true`. Verificado también por el test `recorrido.spec.ts` ("Paquete descargable: arranca
en 'Borrador', nunca en 'Listo'..." — pasó en esta corrida) y por el aviso permanente "La
presentación y firma las realiza el usuario". **Comprobado correcto.**

**Usuarios y roles / Auditoría (pantallas sin conectar)**: ambas muestran
`EmptyState` con título **"Endpoint pendiente en apps/api"** y una descripción técnica
específica de qué falta (`GET /organizations/memberships` para Usuarios y roles,
`GET /audit-log` para Auditoría) — no un vacío genérico que pudiera confundirse con "no
hay datos". **Comprobado correcto**, exactamente lo que pide el mandato ("estado honesto,
no vacío engañoso").

**Sin datos ficticios**: no se encontró en ningún componente de página real (fuera de
`src/test/msw.ts`, exclusivo de pruebas) ningún dato hardcodeado que se presente como si
viniera de la API.

---

## 5. Accesibilidad y móvil con datos reales

**axe (serious/critical)**: `e2e/recorrido.spec.ts` corre `AxeBuilder({page}).analyze()`
y filtra violaciones `serious`/`critical` en las **29 rutas** de `ALL_NAV_ITEMS`, más
login, drawer móvil, dark mode y los badges de estado de fuente — **todas en verde** en
esta corrida (parte de los 89 passed). REQ-089 ("sin hallazgos critical/serious") tiene
evidencia E2E real y nombrable.

**Teclado / foco tras acciones**: `e2e/skip-link.spec.ts` verifica foco visible real
(outline/box-shadow, no solo `:focus` en el DOM) tras activar el skip-link en múltiples
rutas — pasó en esta corrida salvo las 3 fallas ya atribuidas a rate-limit (WI-05), no a
regresión de foco.

**320/390px con tablas reales — verificación propia de esta auditoría**: la suite
existente solo comprueba "sin scroll horizontal" a **390×844** sobre las 29 rutas
(`recorrido.spec.ts`, mayormente con tablas VACÍAS en un seed mínimo) y mide posiciones de
controles del header a 320×568 (`touch-targets.spec.ts`, W-21/W-22) — pero **no existía
ninguna prueba de "sin scroll horizontal" a 320px con tablas realmente pobladas**. Se
construyó una prueba Playwright ad-hoc (no comprometida al repo, solo su evidencia): login
real → proponer una tarifa con descripción larga real (`SRV-AUDIT-001`, ~120 caracteres) →
subir un documento PDF real con un `documentType` largo → viewport 320×640 → recorrer las
29 rutas midiendo `document.documentElement.scrollWidth` vs `clientWidth`. Resultado:
**0 rutas con overflow horizontal de página**, incluidas las dos tablas recién pobladas.
Las capturas (`docs/auditoria-2/capturas-web/320px-empresa-tarifas-aprobadas.png` y
`320px-empresa-documentos-vigencias.png`) muestran el patrón correcto: la tabla se recorta
en su propio borde derecho (columnas "Precio"/"Estado"/"Acciones" fuera de vista) sin
empujar la página — confirma que el wrapper `<div className="relative w-full
overflow-auto ...">` de `src/components/ui/table.tsx` cumple su función de scroll
**interno** también a 320px con datos reales, no solo a 390px con datos vacíos. **Se
confirma correcto en la práctica**, pero se deja como observación de cobertura de pruebas
(no un defecto de producto): la suite de regresión debería agregar 320px con datos reales
a su barrido, no solo 390px con datos vacíos, para no depender de una verificación manual
como esta en el futuro.

**W-21/W-22/W-23**: los tres se reprodujeron **CERRADOS** en esta corrida
(`touch-targets.spec.ts` en verde: OrganizationSwitcher y "Cerrar menú" ≥44×44px a
320×568 y 390×844; controles del header dentro del viewport a ambos anchos; puerto E2E
configurable sin colisión, confirmado al no chocar con los otros worktrees activos
`reverify-api2*` durante esta misma auditoría).

---

## 6. Seguridad frontend

**CSP / headers servidos — hallazgo nuevo**:

- **WI-01 (Media, Rubro 6 — Seguridad frontend)**: no existe **ninguna
  Content-Security-Policy** en todo el sistema. `apps/api/src/app.ts:66` registra
  `@fastify/helmet` con `contentSecurityPolicy: false` explícito (comentario propio:
  "Cabeceras de seguridad básicas"), y el resto de cabeceras de helmet (HSTS,
  X-Frame-Options, X-Content-Type-Options, etc.) sí se envían **en las respuestas de la
  API**, verificado con `curl -sD - http://127.0.0.1:<puerto>/healthz`. Pero **el HTML/JS
  de `apps/web` en sí mismo no lleva NINGUNA cabecera de seguridad** — verificado sirviendo
  el build de producción real con `vite preview` y `curl -sD -`: la respuesta trae
  únicamente `Vary/Content-Type/Cache-Control/Etag/Content-Length` (sin CSP, sin
  `X-Frame-Options`, sin `X-Content-Type-Options`). No hay ningún archivo de
  configuración de despliegue (`_headers`, `vercel.json`, `netlify.toml`, config de
  nginx) en `apps/web` que las añada para un hosting estático real. Esto es agravante
  porque el propio proyecto documenta (correctamente, ver rubro 2) que el refresh token
  vive en `localStorage` y es legible por cualquier XSS — una CSP real (`script-src`
  restrictivo) es precisamente la mitigación de defensa en profundidad que reduciría la
  probabilidad de que un XSS llegue a ejecutarse en primer lugar, y no existe. A
  diferencia del riesgo de `localStorage` (documentado explícitamente como trade-off
  aceptado), esta ausencia de CSP **no está mencionada en ningún README ni documento de
  esta ronda**. Reparación: registrar una CSP real en el `helmet` de `apps/api` (o en el
  reverse proxy/CDN que sirva `apps/web` en producción) con al menos
  `default-src 'self'; script-src 'self'; connect-src 'self' <API_URL>; object-src
  'none'; frame-ancestors 'none'`, y añadir `X-Frame-Options`/`X-Content-Type-Options`
  al hosting estático de `apps/web`.

**Dependencias (`npm audit --workspace apps/web`)**: reproducido en el worktree limpio de
esta auditoría: **"5 vulnerabilities (3 moderate, 1 high, 1 critical)"**, idéntico a lo
documentado en el README. Confirmado con `npm ls vitest` que las apariciones vulnerables
de `esbuild`/`vite` cuelgan de `vitest@2.1.9` (usada por `vitest-axe`, peer-dependency sin
tope, y por otros workspaces), nunca de `vitest@4.1.11` propia de `apps/web`. **Comprobado
correcto** — el análisis del README sobre el origen real de estas vulnerabilidades
(herramientas de test, no runtime de producción) es preciso y verificable.

**Secretos en el bundle**: `grep` recursivo con patrones de claves API/secretos/llaves
privadas (`sk-...`, `api[_-]?key`, `-----BEGIN...KEY-----`, etc.) sobre `dist/assets/*.js`
del build de producción real → **sin resultados**. **Comprobado correcto.**

**Subida de archivo (tipo/tamaño en cliente + servidor) — hallazgo nuevo**:

- **WI-02 (Media, Rubro 6 — Seguridad frontend / REQ-098)**: el `<input type="file"
  id="document-file">` de `DocumentosVigenciasPage.tsx` (~línea 116) **no tiene atributo
  `accept`** y no hay ningún chequeo de tipo/tamaño en el cliente antes de que
  `fileToBase64()` lea el archivo completo y `useUploadDocument` lo envíe. El servidor SÍ
  valida en profundidad y correctamente (`apps/api/src/lib/storage.ts`:
  `assertSafeFileContent` rechaza firmas de ejecutables/ZIP/PEM/DER en cualquier parte
  del buffer —no solo el offset 0—, valida estructura mínima de PDF, y
  `decodeBase64Content` limita a ~22MB), así que el REQ-098 ("prohibido leer/subir/...
  `.cer/.key/.pfx/.p12`") **sí se cumple de extremo a extremo en la práctica** — pero el
  criterio explícito de REQ-098 pide *"UI rechaza por extensión y magic bytes"*, y la UI
  actualmente no rechaza nada: el usuario descubre el rechazo (o el timeout por un
  archivo de 22MB+) solo después de que el navegador ya codificó todo el archivo a
  base64 y lo envió por red. Reparación: añadir `accept` (lista de extensiones
  esperadas) y una validación de tamaño/tipo en el cliente antes de leer el archivo,
  con un toast honesto inmediato si no cumple — sin pretender reemplazar la validación
  real del servidor, que ya es sólida.

**Enlaces de descarga de paquete autenticados**: no aplica todavía — `PaqueteDescargablePage.tsx`
no tiene ningún enlace de descarga real (el módulo está honestamente sin conectar, ver
rubro 4/8), así que no hay superficie que auditar aquí en esta ronda.

---

## 7. Paridad visual con Restaurantes

El login (única pantalla con un equivalente directo documentado en
`docs/investigacion/frontend-restaurantes.md`) tiene evidencia E2E nombrable
(`e2e/login-parity.spec.ts`, 3 tests, verde en esta corrida) que verifica layout de
pantalla partida, kicker + titular serif, y la divergencia deliberada y documentada
(solo contraseña, sin OAuth/enlace mágico, con la razón técnica exacta: `apps/api` no
expone `/auth/magic-link`). **Comprobado correcto** y bien documentado (tabla de
divergencias en el README, con justificación por fila).

Las pantallas nuevas de esta ampliación (Empresa, Fuentes y frescura, back office
extendido) no tienen equivalente en Restaurantes para comparar 1:1 — se verificó en su
lugar que **reutilizan consistentemente las mismas primitivas de UI**
(`@/components/ui/card`, `table`, `badge`, `button`, `form`, `dialog`, `sheet`, `sonner`)
en vez de introducir componentes o patrones visuales nuevos: grep de imports en
`src/pages/empresa/*.tsx`, `src/pages/convocatorias/*.tsx` y `src/pages/backoffice/*.tsx`
confirma el mismo set de primitivas usado en todo el panel. Esto es coherencia de
sistema de diseño, que es lo verificable de forma objetiva para pantallas sin análogo
directo — **comprobado correcto** en ese sentido más limitado.

---

## 8. Trazabilidad

**Con evidencia E2E integrada (tests nombrados)**:

| REQ/A | Evidencia E2E |
|---|---|
| REQ-049, REQ-065, REQ-089 | `e2e/recorrido.spec.ts` (29 rutas × axe serious/critical + shell) |
| REQ-115 (disclosure IA) | `e2e/ai-disclosure.spec.ts` (3 rutas) |
| W-12 (guard de rutas) | `RequireAuth.tsx` + `e2e/ronda3-flujo-real.spec.ts` ("login... redirige a /panel") |
| A4 (frescura de fuente, parte UI) | Código verificado en esta auditoría (`useSourceFreshness` → `GET /tenders/sources/freshness` → `app.source_freshness()`); sin test E2E dedicado que aserte el valor real de `ageSeconds`, pero `FuentesFrescuraPage.test.tsx` (componente) y la ruta en `recorrido.spec.ts` sí la ejercitan sin violaciones de accesibilidad |
| A5 (aislamiento cross-org, parte UI) | `e2e/ronda3-flujo-real.spec.ts` → "cambia de organización con el selector real (X-Org-Id)" |
| A12 (autorización desde rol indebido, parcial) | `e2e/ronda3-flujo-real.spec.ts` → "propone una tarifa, que queda en borrador (no puede aprobarla)" [writer], "recibe un 403 honesto de la API al entrar a back office (no es superadmin)" [writer], "aprueba la tarifa propuesta por writer" [admin] |
| W-05/06/07/08/10/11/15/18/19/21/22 | specs dedicados por hallazgo (`contraste`, `heading-order`, `login-landmarks`, `touch-targets`, `login-parity`, `skip-link`, `ai-disclosure`), todos verdes en esta corrida |

**Sin evidencia E2E (declarado honestamente como gap, no descubierto por esta auditoría)**:

- **REQ-064** (re-autenticación passkey/OTP para aprobación 2/2): no existe ninguna
  implementación en `apps/web` — `grep -rni "passkey|OTP|reauth"` sin resultados fuera de
  comentarios genéricos. Confirma lo que `ACEPTACION.md` (A12) ya marcaba como PENDIENTE.
  No hay flujo de aprobación 2/2 diferenciado de una aprobación simple de owner/admin en
  la UI actual.
- **Usuarios y roles / Auditoría** (`/backoffice/usuarios-roles`, `/backoffice/auditoria`):
  sin backend, sin E2E posible más allá de "muestra el estado honesto de endpoint
  pendiente" (eso sí está cubierto implícitamente por el barrido general de
  `recorrido.spec.ts`, que visita la ruta y pasa axe, pero no asertúa el mensaje exacto
  con un test dedicado).
- **Endpoints declarados faltantes** (ver README de `apps/web`, sección "Endpoints de
  apps/api que SÍ existen pero no se pudieron conectar"): `GET
  /organizations/memberships`, `GET /audit-log`. Confirmados ausentes con
  `grep -rn "memberships'" apps/api/src/modules/organizations/routes.ts` (solo
  `PATCH/DELETE /organizations/memberships/:userId`, ninguna ruta `GET`) y
  `grep -rn "audit-log\|audit_log" apps/api/src/modules -l` (solo escrituras internas,
  ninguna ruta HTTP de lectura).
- **REQ-171** (trazas correlacionadas de extremo a extremo): no hay UI para reconstruir
  una cadena `convocatoria→matriz→propuesta→paquete→archivo` por `correlation_id` — la
  pantalla de Auditoría que serviría para esto es precisamente la que no tiene backend
  (ver arriba).

---

## Hallazgos nuevos (resumen)

| ID | Severidad | Rubro | Resumen | Estado reparación (ronda 4, api) |
|---|---|---|---|---|
| WI-01 | Media | 6 (Seguridad frontend) | Cero Content-Security-Policy en todo el sistema (`contentSecurityPolicy: false` en `apps/api`, y `apps/web` servido sin ninguna cabecera de seguridad propia) — agrava el riesgo ya documentado de refresh token legible por XSS en `localStorage` | **RESUELTO (lado apps/api)** — ver arriba. **RESUELTO (lado apps/web)** — CSP real (`script-src 'self'`, sin `unsafe-inline`/`unsafe-eval`) + `X-Content-Type-Options`/`X-Frame-Options`/`Referrer-Policy`, fuente única en `src/lib/security/csp.ts`: meta tag inyectado en el HTML de producción (`vite build`, nunca en `vite dev`) y cabeceras HTTP reales en `vite preview` (`configurePreviewServer`). Ejemplos nginx/Caddy para producción real y TODO enlazado (`src/lib/api/session.ts`) sobre mover el refresh token a cookie httpOnly cuando `apps/api` lo soporte — ver README §"Seguridad: Content-Security-Policy y cabeceras". Test E2E real contra el navegador (`e2e/csp.spec.ts`): lee la CSP efectiva (meta + cabecera) y confirma que un `<script>` inline inyectado dinámicamente NO se ejecuta. |
| WI-02 | Media | 6 (Seguridad frontend) / REQ-098 | `<input type="file">` de subida de documentos sin `accept` ni validación de tipo/tamaño en cliente; el servidor sí valida bien (magic bytes + 22MB), pero el criterio explícito de REQ-098 pide rechazo también en UI | **RESUELTO (lado apps/web)** — `accept` real en el `<input>` + `validateDocumentFile()` (`src/lib/validateDocumentFile.ts`): rechaza por extensión de e.firma (.cer/.key/.pfx/.p12/.der/.pem, REQ-098 tolerancia cero) y por tamaño (>22MB, alineado con el límite real del servidor) ANTES de leer el archivo a base64, con un toast honesto inmediato. No reemplaza la validación real del servidor (magic bytes en todo el buffer), solo adelanta el mensaje. Test unitario (`validateDocumentFile.test.ts`, 12 casos) y E2E real contra `apps/api` (`e2e/ronda3-flujo-real.spec.ts`: sube un PDF válido con éxito, y rechaza una `.key` con marcador PEM sin llegar a disparar `POST /company/documents`). |
| WI-03 | Baja/Media | 2 (Sesión) | `logout()` no limpia el caché de react-query (`queryClient.clear()` ausente); sin fuga entre organizaciones (las queries de negocio SÍ incluyen `currentOrgId` en su clave), pero sí un residuo visible de sesión anterior en las queries admin/globales tras un logout real en navegador compartido | **RESUELTO (lado apps/web)** — commit `74c2358`: `logout()` llama a `queryClient.clear()` (limpieza total, fin de sesión) y `switchOrg()` llama a `clearUnscopedQueries()` (elimina solo las claves admin/globales sin `currentOrgId`, ver `src/lib/queryClient.ts`). Test: `useAuth.test.tsx` (rojo verificado antes del fix, 65/65 en verde después). |
| WI-04 | Baja | 2/3 (Idempotencia / Permisos) | Botones "Aprobar"/"Rechazar" de tarifas sin `disabled` durante `isPending` (a diferencia de "Proponer"); compuesto por que la API tampoco guarda el estado previo al actualizar (`UPDATE ... SET status = ...` sin condición de estado), permitiendo re-aprobar/re-rechazar y generando entradas de auditoría redundantes para el mismo evento | **RESUELTO (lado apps/api)** — ver arriba. **RESUELTO (lado apps/web)** — botones Aprobar/Rechazar deshabilitados POR FILA (no toda la tabla) mientras esa tarifa tiene una decisión pendiente, y hasta que el estado real se refresca (`useApproveRate`/`useRejectRate` ahora esperan `queryClient.invalidateQueries` en `onSettled`, no solo `onSuccess`, antes de asentar la mutación — ver `src/hooks/useCompany.ts`); un 409 real de la API se muestra con un mensaje honesto específico (`TarifasAprobadasPage.tsx`) en vez del genérico. Test de componente: `TarifasAprobadasPage.test.tsx` (2 casos: deshabilitado + refresco tras 409). |
| WI-05 | Baja | 1 (Reproducibilidad) | `test:e2e:full` no es determinísticamente verde por un límite de tasa real de `apps/api` (100/min) autoinducido por el barrido de 29 rutas de `skip-link.spec.ts`; sin `RATE_LIMIT_PROFILE` ni variable equivalente en el código para mitigarlo en modo test | **DEPENDENCIA RESUELTA (lado apps/api)** — ver arriba. **RESUELTO (lado apps/web)** — `scripts/e2e-full.mjs` arranca `apps/api` con `RATE_LIMIT_PROFILE=e2e`; `e2e/skip-link.spec.ts` además espacia sus peticiones cada 5 rutas como capa adicional. De paso se corrigió un bug real de infraestructura de la propia suite (`playwright.config.ts`): el puerto derivado de `process.pid` sin fijarse en `process.env` hacía que cada proceso *worker* de Playwright (que reimporta la config) recalculara un puerto DISTINTO al que de verdad tenía `vite preview` corriendo, produciendo `ERR_CONNECTION_REFUSED` reproducible con más de un worker. Verificado real: `test:e2e:full` completo pasó de "89 passed / 2 flaky / 3 failed" (línea base de esta auditoría) a **97 passed / 1 flaky (recuperado en reintento) / 0 failed** (`docs/logs/fix-web-ronda3.log`). |

## Comprobado correcto (selección, no exhaustiva)

- 63/63 pruebas unitarias reproducibles sin red.
- Access token solo en memoria; riesgo de refresh token en `localStorage` documentado
  honesta y técnicamente correcto (no oculto).
- Guard de rutas + restauración de deep-link tras login (`location.state.from`).
- Reintento 401→refresh→reintento sin riesgo de doble mutación (el `preHandler` de auth
  bloquea la ejecución del handler antes de que exista la oportunidad de duplicar nada).
- `queryKey` de todos los hooks de negocio (empresa, convocatorias, matching, Go/No-Go,
  agentes) incluye `currentOrgId` — cambio de organización sin fuga de datos en pantalla
  ni en caché.
- Permisos derivados de `currentMembership.role` (dato del servidor, no manipulable desde
  el cliente) usados solo como UX, nunca como única barrera; servidor re-valida con
  `requireOrgRole`/`requireSuperadmin` en cada mutación sensible revisada.
- `/backoffice/*` reservado a superadmin real, 403 honesto verificado en código.
- `Fuentes y frescura` conectado de verdad a `source_runs` vía `app.source_freshness()` —
  cierra la brecha de UI que `ACEPTACION.md` (A4) marcaba como pendiente.
- Paquete descargable nunca sale de "Borrador" por diseño (3 flags hardcodeados en
  `false`, sin ruta de código que los cambie todavía).
- `Usuarios y roles` y `Auditoría` muestran "Endpoint pendiente en apps/api" con el
  endpoint exacto que falta, no un vacío genérico.
- Sin datos ficticios en ninguna página de producción revisada.
- axe sin violaciones serious/critical en 29 rutas + login + drawer + dark mode.
- W-05/06/07/08/10/11/15/18/19/21/22 reproducidos en verde en esta corrida.
- 320px con datos reales (verificación propia, no en la suite): sin scroll horizontal de
  página en ninguna de las 29 rutas; tablas usan scroll interno correctamente incluso con
  contenido largo real.
- `npm audit --workspace apps/web` reproducido igual al README: 5 vulnerabilidades, todas
  trazadas a `vitest@2.x` de otros workspaces / peer-dependency de `vitest-axe`, ninguna
  alcanzable desde el bundle de producción real.
- Sin secretos en el bundle de producción (`dist/assets/*.js`).
- Validación de archivo del lado del servidor sólida (magic bytes en todo el buffer,
  estructura de PDF, límite de tamaño) — el gap está solo en el cliente (WI-02).
- Login: paridad visual con Restaurantes verificada y divergencias documentadas con
  justificación técnica real.

---

## Evidencia

- `docs/logs/audit-web-ronda3.log` (este archivo): salida completa de `npm run -w
  apps/web test`, dos corridas de `test:e2e:full`, `npm audit --workspace apps/web`,
  `npm ls vitest`, `curl` de cabeceras de API y de `vite preview`, y la corrida ad-hoc de
  320px.
- `docs/auditoria-2/capturas-web/320px-empresa-tarifas-aprobadas.png`,
  `320px-empresa-documentos-vigencias.png`, `320px-convocatorias-fuentes-frescura.png`:
  capturas reales a 320×640 con datos creados en vivo contra `apps/api` real (PGlite)
  durante esta auditoría.
