# @atiende/web

Frontend del back office de **Atiende Licitaciones** (marca Atiende, plataforma
de IA para gestión de licitaciones públicas). Ronda 3: conectado a `apps/api`
real (sin mocks en producción — MSW solo en pruebas de componente, ver
`src/test/msw.ts`). Toda pantalla que todavía no tiene un endpoint real detrás
sigue mostrando un estado honesto (vacío, error con `request_id`, o "endpoint
pendiente en apps/api") en vez de datos ficticios.

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
    api/                    # cliente API tipado hacia apps/api (ver "Ronda 3" arriba)
      http.ts, session.ts, client.ts, schemas.ts
      auth.ts, organizations.ts, company.ts, tenders.ts, matching.ts, go-no-go.ts, agents.ts, admin.ts
  hooks/
    useAuth.tsx              # AuthProvider/useAuth() — sesión real
    useCompany.ts, useTenders.ts, useMatching.ts, useGoNoGo.ts, useAgents.ts, useAdmin.ts
  components/
    AtiendeLogo.tsx         # AtiendeMark / AtiendeWordmark (mismo glifo que atiende-restaurantes)
    ThemeSelector.tsx        # claro/sistema/oscuro; vive en el header (md+) y en el drawer (<md, W-21)
    SkipLink.tsx              # "saltar a..." con foco real (.focus() explícito, no solo href="#id")
    AiDisclosureNote.tsx       # aviso de uso de IA (REQ-115), antepuesto a módulos con `disclosure: true`
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
    NotFoundPage.tsx
    createModulePage.tsx     # fábrica: SectionHeader + EmptyState honesto (módulos aún sin backend)
    empresa/                 # Perfil y capacidades, Documentos y vigencias, Firmantes, Tarifas — datos reales
    convocatorias/            # Descubrimiento, detalle, Matching, Fuentes y frescura — datos reales
    evaluacion/                # Go/No-Go (real), Análisis de bases (sin backend, ver abajo)
    preparacion/                # Cumplimiento documental, Redacción, Revisión, Expediente, Aprobaciones
                                 # (fuera de alcance de esta ronda — ver "Módulos sin conectar")
    entrega/                     # Entregas, Paquete descargable, Seguimiento post-adjudicación (ídem)
    backoffice/                   # Organizaciones, Agentes y herramientas (reales); Usuarios y roles,
                                   # Auditoría (endpoint pendiente en apps/api); Conectores, Jobs,
                                   # Costos, Incidentes, Aprobaciones (reales, solo superadmin)
    ConfiguracionPage.tsx
  test/
    setup.ts                 # jest-dom + vitest-axe + servidor MSW (server.listen/reset/close) + limpia sesión
    utils.tsx                # renderWithProviders() (QueryClient + Router + TooltipProvider + AuthProvider)
    msw.ts                   # servidor MSW compartido (éxito/401/403/500/red caída en pruebas de componente)
e2e/                          # suite Playwright + axe-core sobre el navegador real (REQ-049/065)
  fixtures.ts                 # `page` (admin, login fresco por worker), `writerPage`, `noAuthPage`
  global-setup.ts             # siembra 2 orgs + 2 usuarios reales vía la propia apps/api (test:e2e:full)
  seed-client.ts               # cliente HTTP mínimo del seed (independiente del cliente de producción)
  ronda3-flujo-real.spec.ts    # login→cambiar org→perfil→documento→tarifa→convocatorias vacías→403
  recorrido.spec.ts            # login→shell, las 24+ rutas del sidebar, drawer móvil, tema oscuro,
                                # Fuentes y frescura, Paquete "Borrador", sin scroll horizontal a 390px
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

## Módulos sin conectar (fuera de alcance de esta ronda)

`apps/api` (ver su README) no expone endpoints para estos módulos todavía;
siguen mostrando el `EmptyState` genérico de `createModulePage.tsx`, no una
integración real: **Análisis de bases**, **Cumplimiento documental**,
**Redacción**, **Revisión**, **Expediente**, **Aprobaciones** (Preparación),
**Entregas**, **Paquete descargable**, **Seguimiento post-adjudicación**.
Son responsabilidad de `packages/expediente` y de la orquestación de
agentes (`packages/agents`) cableada con proveedores LLM reales, ninguno de
los cuales expone HTTP todavía — ver sus propios README para el estado real.

## Endpoints de apps/api que SÍ existen pero no se pudieron conectar (gaps documentados en el código)

- **Usuarios y roles** (`/backoffice/usuarios-roles`): `apps/api` no expone
  ningún endpoint para LISTAR los miembros de una organización.
  `GET /organizations` solo devuelve las organizaciones del USUARIO ACTUAL
  (`app.my_organizations`), no la lista de miembros de una organización
  dada; existen mutaciones (`POST /organizations/invitations`,
  `PATCH/DELETE /organizations/memberships/:userId`) pero ninguna consulta
  previa. Hace falta un `GET /organizations/memberships` (o equivalente).
- **Auditoría / Trazabilidad** (`/backoffice/auditoria`): `apps/api`
  mantiene `audit_log` con cadena de hashes verificable
  (`app.verify_audit_log_chain()`, ver `packages/db/README.md`) y escribe
  en cada mutación relevante, pero no expone NINGÚN endpoint HTTP para
  leerlo. Hace falta un `GET /audit-log` (con filtro por organización) o
  `GET /admin/audit-log` para el back office.
- **Aprobación cross-org de tool_calls** (`/backoffice/aprobaciones`):
  `GET /admin/approvals` (superadmin) lista tool_calls pendientes de TODAS
  las organizaciones, pero aprobar/denegar de verdad
  (`POST /agents/tool-calls/:id/approve|deny`) exige `X-Org-Id` + rol
  owner/admin DE ESA organización — un superadmin no necesariamente lo es.
  La pantalla es de solo lectura a propósito, con el flujo real explicado
  (cambiar de organización en el selector y aprobar desde "Agentes y
  herramientas").

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
