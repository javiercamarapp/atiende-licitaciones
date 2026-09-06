# @atiende/web

Frontend del back office de **Atiende Licitaciones** (marca Atiende, plataforma
de IA para gestión de licitaciones públicas). Ronda 1: solo interfaz — no hay
`apps/api` conectado todavía, así que toda pantalla que necesitaría datos
reales muestra un estado vacío u honesto en vez de datos "de demo".

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
```

La primera vez que se corre `test:e2e`, instala el navegador de Playwright
con `npx playwright install chromium` (una sola vez por máquina/CI).

Variables de entorno (`.env`, ver `.env.example`):

- `VITE_API_URL` — URL base de `apps/api`. Sin backend desplegado, el cliente
  en `src/lib/api.ts` lanza `ApiError` con el mensaje real del fallo de red y
  la UI lo muestra en `<ErrorState/>` con botón de reintentar — nunca oculta
  el error ni simula una respuesta exitosa.

## Estructura

```
src/
  App.tsx                  # Router raíz, lazy routes por página, error boundary, loading screen
  main.tsx                 # entry point
  index.css                # tokens de diseño (HSL), tipografías, dark mode, keyframes del logo
  config/navigation.ts     # única fuente de verdad del sidebar (grupos + items + rutas)
  lib/
    utils.ts               # cn() (clsx + tailwind-merge)
    api.ts                 # cliente HTTP tipado hacia apps/api (aún sin backend real)
  components/
    AtiendeLogo.tsx         # AtiendeMark / AtiendeWordmark (mismo glifo que atiende-restaurantes)
    ThemeSelector.tsx        # claro/sistema/oscuro, persistido en localStorage, clase .dark en <html>
    SkipLink.tsx              # "saltar a..." con foco real (.focus() explícito, no solo href="#id")
    AiDisclosureNote.tsx       # aviso de uso de IA (REQ-115), antepuesto a módulos con `disclosure: true`
    layout/
      AppShell.tsx            # layout raíz: sidebar desktop + drawer móvil (Sheet) + header + main
      SidebarNav.tsx           # contenido de navegación (compartido entre sidebar y drawer)
      SectionHeader.tsx        # encabezado estándar de cada página de módulo
      OrganizationSwitcher.tsx # selector de organización (placeholder controlado por estado)
    ui/                      # primitivas shadcn/ui adaptadas (button, card, dialog, sheet, table,
                              # tabs, select, dropdown-menu, form, sonner, tooltip, separator,
                              # scroll-area, skeleton, badge, empty-state, error-state, loading-state,
                              # source-status-badge, package-status-badge)
  pages/
    LoginPage.tsx            # pantalla partida (kicker + h1 serif + lámina), contraseña + magic link
    login.css                 # fuente Fraunces del titular, exclusiva de esta pantalla
    NotFoundPage.tsx
    createModulePage.tsx     # fábrica: SectionHeader + EmptyState honesto por módulo
    empresa/                 # Perfil y capacidades, Documentos y vigencias, Firmantes, Tarifas
    convocatorias/            # Descubrimiento, Matching, Fuentes y frescura
    evaluacion/                # Go/No-Go, Análisis de bases
    preparacion/                # Cumplimiento documental, Redacción, Revisión, Expediente, Aprobaciones
    entrega/                     # Entregas, Paquete descargable, Seguimiento post-adjudicación
    backoffice/                   # Organizaciones, Usuarios y roles, Agentes y herramientas, Auditoría
    ConfiguracionPage.tsx
  test/
    setup.ts                 # extiende expect con jest-dom + vitest-axe, limpia entre tests
    utils.tsx                # renderWithProviders() (QueryClient + Router + TooltipProvider)
e2e/                          # suite Playwright + axe-core sobre el navegador real (REQ-049/065)
  fixtures.ts                 # test/expect propios: goto() espera networkidle (rutas con lazy())
  recorrido.spec.ts            # login→shell, las 24 rutas del sidebar, drawer móvil, tema oscuro,
                                # Fuentes y frescura, Paquete "Borrador", sin scroll horizontal a 390px
  contraste.spec.ts, heading-order.spec.ts, login-landmarks.spec.ts, login-parity.spec.ts,
  skip-link.spec.ts, touch-targets.spec.ts, ai-disclosure.spec.ts  # regresión por hallazgo (ver
                                                                     # docs/auditoria-1/web.md)
playwright.config.ts          # sirve dist/ con `vite preview` (webServer), proyecto chromium
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
| Métodos de acceso | Solo enlace mágico + Google OAuth | Contraseña **y** enlace mágico (tabs), sin OAuth | El backend de licitaciones (`apps/api`) expone `/auth/login` con contraseña; no hay integración con Google configurada en esta ronda. Se documenta como decisión de producto, no como omisión accidental |
| Roles / redirect post-login | Lógica de `superadmin` vs. `admin` específica de restaurantes | No aplica — sin backend de sesión todavía | Fuera de alcance de esta ronda (ver "Qué falta") |

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

## Control de acceso (W-12)

`apps/web` **no tiene ningún guard de ruta**: `/panel` y todas las rutas de
`AppShell` son accesibles sin sesión, y `login()`/`requestMagicLink()`
(`src/lib/api.ts`) no persisten ningún token tras un login exitoso — no hay
ni siquiera un lugar donde guardar una sesión todavía. Añadir un guard
client-side ahora mismo sería una barrera cosmética (no hay sesión real que
verificar, así que "proteger" una ruta equivaldría a comprobar la ausencia
de una clave de `localStorage` que ningún flujo real escribe), lo que daría
una falsa sensación de control de acceso sin ninguna garantía real. Se
documenta aquí en vez de simularlo: el control de acceso real (verificar
sesión contra `apps/api`, redirigir a `/login` si no hay sesión válida)
queda pendiente para cuando exista persistencia de sesión real — ver "Qué
falta" abajo.

## Qué falta (fuera de alcance de esta ronda)

- Conectar `apps/api` real: hoy `src/lib/api.ts` apunta a `VITE_API_URL` pero
  no hay backend implementado; todas las páginas muestran `EmptyState`.
- Autenticación real (el formulario de login valida con zod pero `login()` /
  `requestMagicLink()` fallarán hasta que exista el backend).
- Selector de organización con datos reales (hoy usa `listOrganizaciones()`,
  que fallará limpiamente contra `ErrorState`/estado deshabilitado hasta que
  exista el endpoint).
- Contenido real de los módulos de back office ampliados (matriz de
  requisitos del Expediente, tabla de fuentes con estado real, etc.) — esta
  ronda entrega la navegación, las rutas y los estados vacíos/honestos, no la
  lógica de negocio ni la integración con CompraNet/portal oficial.
