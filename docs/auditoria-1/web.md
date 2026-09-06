# Auditoría adversarial — `apps/web` (Atiende Licitaciones)

**Auditor**: agente Sonnet independiente, sin participación en la implementación.
**Commit auditado**: `a43efd7` (feat(web): scaffolding de apps/web con AppShell, sidebar y modulos de
licitaciones). `apps/web` no cambió entre `a43efd7` y el `HEAD` observado al iniciar (`6ded3a0`) —
confirmado con `git diff a43efd7..6ded3a0 --stat -- apps/web` (vacío). Durante la auditoría otros
agentes siguieron trabajando en paralelo sobre el mismo repo (`apps/api`, `packages/db`,
`packages/agents`, `packages/expediente` recibieron commits nuevos mientras esto se escribía); esos
cambios no tocan `apps/web` y no alteran ninguna conclusión de este informe, pero si se lee este
documento mucho después puede que el estado de `packages/*` en git (ver W-01) ya no sea el mismo.
**Logs completos**: `docs/logs/audit-web-ronda1.log`. **Capturas y reportes axe**:
`docs/auditoria-1/capturas/` (script fuente: `capturar.mjs`).

## Resumen ejecutivo

`apps/web` es, en su propio alcance declarado (solo interfaz, sin backend), notablemente honesto:
no hay datos ficticios, el paquete de entrega nunca arranca en "Listo", los 5 estados de fuente
existen tal como los pide la ampliación de back office, y las 29 pruebas unitarias/de componente
son pruebas de comportamiento reales (confirmado por mutación manual), no solo de presencia. Sin
embargo, la auditoría con render real (Playwright, no jsdom) y con un clon de git verdaderamente
limpio expone tres problemas que el registro `docs/logs/web-ronda1.log` de la ronda 1 no podía ver
porque se generó en un monorepo contaminado por directorios (`packages/*`, `apps/api`) que **nunca
se versionaron en git**:

1. **La build de producción y el typecheck de `apps/web` están rotos en cualquier clon real del
   repositorio** (`@types/node` ausente, hoisting fantasma). Esto es el hallazgo más grave (W-02).
2. **El estado "verde" de seguridad (0 vulnerabilidades) y de reproducibilidad de la ronda 1 no
   corresponde a `apps/web` real** sino a un árbol de dependencias inflado por workspaces que no
   existen en el historial de git (W-01, W-03, W-04).
3. **La auditoría de accesibilidad automatizada de la propia suite de pruebas no puede detectar
   toda una clase de violaciones** (landmarks/heading de documento) porque corre sobre un subárbol
   jsdom en vez de sobre el documento completo — y el render real sí encuentra 2 violaciones
   *serious* de contraste de color que REQ-089 prohíbe explícitamente (W-05, W-06, W-13).

Ningún hallazgo de esta auditoría involucra datos inventados, fuga entre tenants ni envío/firma
automática — en esas dimensiones el andamiaje de esta ronda cumple lo que promete.

**Conteo de hallazgos**: 2 críticos, 5 altos, 6 medios, 3 bajos (16 en total, W-01 a W-16).

---

## Rubro 1 — Reproducibilidad

**Veredicto: FALLA**

Metodología: clon de git *verdaderamente* limpio (`git clone --no-local` a un directorio en
scratchpad, `git checkout a43efd7`) — no una reinstalación de `node_modules` sobre el working tree
existente, que habría heredado la contaminación descrita abajo.

- `npm install` (raíz, clon limpio): **OK**, pero con una diferencia reveladora frente al log
  original: 499 paquetes añadidos / 501 auditados / **0 vulnerabilidades**, contra "64 paquetes
  añadidos / 622 auditados / **5 vulnerabilidades (3 moderate, 1 high, 1 critical)**" en
  `docs/logs/web-ronda1.log`. La diferencia es que el repo donde se generó ese log tiene en disco
  `apps/api/` y los cuatro `packages/*`, que **nunca fueron añadidos a git** (ver W-01) — un clon
  real no los trae.
- `npm run -w apps/web typecheck`: **FALLA** en el clon limpio (`TS2307: Cannot find module
  'path'`, `TS2339: Property 'dirname' does not exist on type 'ImportMeta'` en `vite.config.ts`).
  El log de ronda 1 reporta esto en verde — ver W-02.
- `npm run -w apps/web lint`: **OK**, idéntico a ronda 1 (sin salida, exit 0).
- `npm run -w apps/web test`: **OK**, idéntico a ronda 1 — 8 archivos / 29 pruebas en verde, mismos
  warnings de `HTMLCanvasElement.getContext` (axe-core probando contraste de un ligature-icon
  inexistente en jsdom, inofensivo).
- `npm run -w apps/web build`: **FALLA** en el clon limpio, mismo error de `@types/node` que
  typecheck — ver W-02.

Evidencia completa (comandos + salida real): `docs/logs/audit-web-ronda1.log`, sección "Rubro 1".

## Rubro 2 — Paridad visual con Restaurantes (render real)

**Veredicto: PARCIAL**

Se instaló Chromium con `npx playwright install chromium` (sin problemas de red) y se renderizó
`apps/web` sirviendo el build de producción (`npm run -w apps/web preview -- --port 4173
--strictPort`) con Playwright + capturas + axe-core inyectado
(`docs/auditoria-1/capturas/capturar.mjs`).

Para el proyecto de referencia: se copió el código fuente de `atiende-restaurantes` (excluyendo
`.git`, `.env`, `node_modules`, `dist`, `.vercel`, lockfiles binarios) a un directorio del
scratchpad — **nunca se tocó ni se leyó el `.env` real ni el repo original** — y se instaló con un
`.env` de placeholders (`VITE_SUPABASE_URL=https://placeholder.supabase.co`), suficiente para que
`vite dev` arrancara (no se necesita una sesión válida para renderizar el login). El servidor sí
levantó (`npm run dev -- --port 4174 --strictPort`, base `/restaurantes/`).

Hallazgo principal: **el login real de `atiende-restaurantes` no se parece en nada al descrito en
`docs/investigacion/frontend-restaurantes.md`**, documento que sirvió de base declarada para la
paridad visual (W-11). El render real (`docs/auditoria-1/capturas/ref-01-login.png`) muestra un
layout de foto-hero a pantalla partida, un botón "Continuar con Google" (`signInWithOAuth`) y una
tipografía serif (`Fraunces`) + `Instrument Sans` exclusiva de esa pantalla (`src/pages/login.css`
del repo de referencia) — nada de esto aparece en el documento de investigación, que describe un
login de tabs contraseña/enlace-mágico sin OAuth. El login de licitaciones
(`docs/auditoria-1/capturas/01-login.png`) es fiel al documento de investigación, pero por eso
mismo no se parece al login real de la marca "atiende".

Fuera del login, la paridad es sólida y verificable en código sin necesidad de credenciales
(`/admin` del proyecto de referencia redirige a login sin sesión, así que no se pudo renderizar el
dashboard autenticado real — comportamiento correcto de su parte, ver W-12 sobre licitaciones):

- Paleta HSL, radios (`0.75rem`), sombras con tokens semánticos: coinciden con
  `docs/investigacion/frontend-restaurantes.md` §2.1/2.3 y con `apps/web/src/index.css`.
- Tipografía del panel (no del login): Inter / Inter Tight / IBM Plex Mono, importadas de forma
  idéntica en ambos `index.css` (confirmado leyendo el `index.css` real del repo de referencia).
- Logo: `AtiendeLogo.tsx` es una copia fiel del componente real (mismo SVG, mismo `viewBox`,
  mismos colores) — incluyendo, sin querer, su bug de contraste en dark mode (ver W-05).
- El drawer móvil accesible es una mejora real de licitaciones sobre el original (que es
  desktop-only, confirmado en el documento de investigación y consistente con lo que se vería si
  se forzara viewport móvil en `atiende-restaurantes/admin`, que aquí no se pudo renderizar por
  requerir sesión).

## Rubro 3 — Accesibilidad (render real + teclado)

**Veredicto: FALLA** (hallazgos *serious* reales; REQ-089 exige "sin hallazgos critical/serious")

axe-core se inyectó sobre el documento completo servido por `vite preview` (no sobre un subárbol
jsdom) en 7 vistas: login, panel, fuentes y frescura, paquete descargable, un módulo con
`EmptyState`, panel en modo oscuro real (clic en el `ThemeSelector`, no simulación de
`localStorage`) y el drawer móvil abierto. Resultados completos en
`docs/auditoria-1/capturas/axe-*.json`.

| Página | Violaciones (impacto) |
|---|---|
| `/login` | 3 *moderate*: `landmark-one-main`, `page-has-heading-one`, `region` (W-08) |
| `/panel` | 0 |
| `/convocatorias/fuentes-frescura` | 1 **serious** `color-contrast` (2 nodos) + 1 *moderate* `heading-order` (W-06, W-07) |
| `/entrega/paquete-descargable` | 1 *moderate* `heading-order` (W-07) |
| módulo con `EmptyState` (`/convocatorias/descubrimiento`) | 0 |
| `/panel` en modo oscuro (clic real en "Tema oscuro") | 1 **serious** `color-contrast` (W-05) |
| drawer móvil abierto (390×844) | 0 (2 *incomplete*, no violaciones confirmadas) |

Navegación por teclado (verificada manualmente con Playwright, no solo con axe automatizado):

- Skip-link de `AppShell` (`#main-content`) → **funciona**: tras Tab + Enter el foco queda
  realmente en `<main tabIndex={-1}>` (comprobado correcto).
- Skip-link de `LoginPage` (`#login-form`) → **roto**: tras Tab + Enter el foco queda en `<body>`,
  porque el objetivo es un `<div>` (el wrapper de `Tabs`) sin `tabindex` — el skip-link no cumple
  su función en la única pantalla no autenticada del portal (W-09).
- Drawer móvil: al abrirse, Radix marca el resto de la página `aria-hidden`/inerte (confirmado
  programáticamente) — comportamiento correcto de foco atrapado; `Escape` cierra el diálogo
  (confirmado: el `[role="dialog"]` deja de existir).

Gap metodológico confirmado empíricamente (W-13): las pruebas `vitest-axe` existentes
(`AppShell.test.tsx`, `LoginPage.test.tsx`) corren `axe(container)` sobre el nodo montado por
Testing Library, no sobre `document`. Por diseño, esto hace invisibles para esas pruebas las 3
reglas a nivel de documento que sí fallan en el render real de `/login` (W-08) — mismo componente,
mismo código, "0 violaciones" en el test y "3 violaciones" en el navegador real.

## Rubro 4 — Móvil (390×844)

**Veredicto: PARCIAL**

- Sin scroll horizontal: confirmado (`document.documentElement.scrollWidth ===
  document.documentElement.clientWidth`) en `/panel` a 390px.
- Drawer móvil: funcional, se abre con el botón hamburguesa, comparte el mismo `SidebarNav` que el
  escritorio, cierra con clic en la X y con `Escape` — comprobado correcto.
- Targets táctiles: el botón hamburguesa mide **40×40px** (medido con
  `locator.boundingBox()` antes de abrir el drawer, para evitar que Radix lo marque inerte) y el
  primer enlace de navegación dentro del drawer abierto mide 36px de alto — ambos por debajo del
  objetivo de ≥44×44px (W-10).

## Rubro 5 — Honestidad de estados

**Veredicto: CUMPLE**

Revisión de código (no solo del render) de `EmptyState`, `ErrorState`, `SourceStatusBadge`,
`PackageStatusBadge`, `createModulePage`, `LoginPage`, `PaqueteDescargablePage`, `FuentesFrescuraPage`,
`lib/api.ts`:

- `ErrorState` siempre recibe y muestra `err.message` real (`LoginPage.tsx:43,104`); nunca hay un
  mensaje genérico que oculte la causa.
- `EmptyState` tiene copy específico por módulo (no un placeholder genérico repetido) y no simula
  datos.
- `PackageStatusBadge`: `ESTADO_ACTUAL` está hardcodeado a `"borrador"`
  (`PaqueteDescargablePage.tsx:12`) con un comentario explícito de por qué, y no hay ninguna otra
  ruta de código en esta ronda que pueda producir `"listo"` — cumple el criterio de ACEPTACION.md
  de "nunca Listo por defecto". El aviso "La presentación y firma las realiza el usuario" está
  presente y es prominente (`Card` de advertencia, no un texto pequeño al pie).
- `SourceStatusBadge` implementa exactamente los 5 estados exigidos por REQ-148/AMPLIACION §2:
  `ok | caida | captcha | cambio_interfaz | permisos_faltantes`, cada uno con etiqueta y color
  propios — ninguno colapsa "sin respuesta" en "cero convocatorias".
- No se encontró ningún texto, botón o flujo que sugiera envío/firma automática a un portal
  oficial; `lib/api.ts` no tiene ninguna función de ese tipo.

Matiz menor sin severidad de hallazgo: `PackageStatusBadge` acepta `"listo"` como valor de tipo
válido sin ninguna guarda adicional a nivel de componente — el día que se conecte a un backend real,
la responsabilidad de no pasar `"listo"` sin validación completa recae enteramente en quien llame al
componente. No es un bug hoy (no hay ningún llamador que lo haga), pero es un recordatorio de diseño
para cuando exista integración real.

## Rubro 6 — Seguridad frontend

**Veredicto: PARCIAL** (limpio en lo propio de `apps/web`; el reporte de la ronda 1 está contaminado)

- Grep exhaustivo de `apps/web/src`, `*.json`, `*.ts`, `*.html`, `.env.example` en busca de
  `supabase.co`, `vercel.app`, `SUPABASE_`, prefijos de claves (`sk-`, `AIza`, `service_role`):
  **sin coincidencias**. No hay secretos, URLs ni IDs de despliegue copiados de
  `atiende-restaurantes`.
- Ningún `.cer/.key/.pfx/.p12` ni patrón DER/PKCS#8 en el árbol (no hay siquiera manejo de e.firma
  en esta ronda).
- Dependencias: cada paquete declarado en `apps/web/package.json` tiene uso real confirmado por
  grep (ninguna dependencia "de adorno"); no existe `next-themes` (a diferencia del origen, que sí
  la tenía sin usar) y solo hay **un** sistema de toast (Sonner) — ambas decisiones documentadas en
  el README se verifican en el código.
- `npm audit --workspace apps/web` en el **clon limpio**: **0 vulnerabilidades** (todas las
  severidades en 0).
- `npm audit --workspace apps/web` en el **repo real de trabajo** (contaminado por `packages/*` y
  `apps/api` no versionados): reporta las mismas "5 vulnerabilities (3 moderate, 1 high, 1
  critical)" del log de ronda 1, todas originadas en una copia anidada vieja de
  `esbuild`/`vite`/`vitest` dentro de `node_modules/vite-node` y `node_modules/vitest` — es decir,
  el filtro `--workspace apps/web` de npm **no aísla correctamente** el árbol de dependencias
  cuando hay conflictos de hoisting entre workspaces (ver W-04). El estado de seguridad "real" de
  `apps/web` tal como lo verá cualquiera que clone el repo es 0 vulnerabilidades; el que se
  registró en `docs/logs/web-ronda1.log` no lo es.

## Rubro 7 — Calidad de pruebas

**Veredicto: PARCIAL**

- Las 29 pruebas (8 archivos) sí verifican comportamiento, no solo presencia — confirmado con
  **mutación manual real** en un `git worktree` aislado (`git worktree add` sobre `a43efd7` en
  scratchpad, sin usar `git stash`):
  1. Cambiar el `aria-label` de "Abrir menú de navegación" → "Abrir menu" en `AppShell.tsx`:
     **1 prueba falla** (`AppShell.test.tsx`, que busca el botón por ese nombre accesible exacto).
  2. Eliminar el item "Fuentes y frescura" de `NAV_GROUPS` en `config/navigation.ts`: **1 prueba
     falla** — importante: esa prueba (`AppShell.test.tsx`, "incluye los items de la ampliación de
     back office") usa una lista de items **hardcodeada en el propio test**, no derivada del mismo
     archivo de configuración que se mutó, así que sí detecta una regresión real y no solo
     compara la fuente contra sí misma.
  3. Cambiar `ESTADO_ACTUAL` de `"borrador"` a `"listo"` en `PaqueteDescargablePage.tsx`: **1
     prueba falla** (`PaqueteDescargablePage.test.tsx` busca el texto "Borrador" y confirma la
     ausencia de "Listo para presentar").
  Las tres mutaciones se restauraron con `git checkout --` sobre el worktree, que después se
  eliminó con `git worktree remove --force`; el repo principal no se tocó en este paso.
- Cobertura real (de `docs/logs/web-ronda1.log`, no reejecutada aquí por costo/tiempo): 48.1%
  statements / 57.85% branches / 44.44% functions / 51.23% lines — coherente con que la mayoría de
  páginas de módulo (`createModulePage`) no tienen test propio (comparten la fábrica probada una
  vez) y con que `App.tsx` (0% cobertura) no se ejercita directamente en ningún test.
- Gap real de cobertura de *tipo* de prueba, no de cantidad: **no existe ninguna suite Playwright/E2E**
  en `apps/web` (W-14) — solo Vitest + Testing Library a nivel de componente. REQ-049 y REQ-065
  exigen explícitamente una suite Playwright sobre las pantallas del portal con axe integrado;
  hoy no hay ni un esqueleto de esa suite.
- Ver también W-13 (rubro 3): la prueba de accesibilidad de `vitest-axe` tiene un alcance (subárbol
  jsdom) que no puede detectar el tipo de violación que el render real sí encontró.

## Rubro 8 — Trazabilidad con REQUISITOS (secc. 20-22, 29-33)

**Veredicto: PARCIAL**

| REQ | Requisito (resumen) | Evidencia en `apps/web` | Estado |
|---|---|---|---|
| REQ-089 | Portal sin hallazgos axe critical/serious | Render real encuentra 2 *serious* de contraste (W-05, W-06); la suite de tests no los detecta (W-13) | **FALLA** |
| REQ-090/091/092/093 | WhatsApp/voz (horario, disclosure, guardrails) | Fuera del alcance de un portal web; sin evidencia ni reclamo — correcto no abordarlo aquí | N/A (correcto) |
| REQ-094 | Definir si se requiere app nativa | Sin decisión, correctamente no implementado | PENDIENTE (fuera de alcance de ingeniería) |
| REQ-095 | Nunca secretos en código/commits | Grep limpio en `apps/web` (rubro 6) | **CUMPLE** (para este workspace) |
| REQ-096/097/098/099 | Webhooks, red-teaming, e.firma, minimización PII | Sin backend ni manejo de archivos en esta ronda; sin evidencia en ningún sentido | N/A por alcance |
| REQ-115 | Disclosure de IA también en "portal" | Grep exhaustivo: ningún texto de disclosure en `apps/web/src` (W-15) | **SIN EVIDENCIA** |
| REQ-049 | Suite Playwright 10 pantallas + axe | No existe Playwright en `apps/web` (W-14) | **FALLA** |
| REQ-065 | Suite Playwright completa en verde + axe | Igual que REQ-049 | **FALLA** |
| REQ-141 | Perfil de empresa, 8 categorías, CRUD por categoría | Solo navegación + `EmptyState` (`empresa/*Page.tsx`); sin CRUD, declarado fuera de alcance en README | **SIN EVIDENCIA** (esperado esta ronda) |
| REQ-148 | Estados explícitos de fuente (caída/CAPTCHA/interfaz/permisos), nunca lista vacía silenciosa | `SourceStatusBadge` implementa los 5 estados exactos; sin conector real que los alimente | **PARCIAL** (componente listo, integración pendiente) |
| REQ-149 | Badge de obsolescencia por frescura vs. umbral | No implementado (no hay cálculo de frescura aún) | **SIN EVIDENCIA** |
| REQ-163 | Paquete incompleto exporta "BORRADOR"; solo completo exporta "listo" | UI por defecto "Borrador" con aviso; no existe generación real de ZIP/portada todavía | **PARCIAL** |
| REQ-165 | Ninguna ruta ejecuta envío/firma sin `approval_request` | No existe ninguna función de envío/firma en el código (cumple por ausencia, no por bloqueo activo demostrado) | **CUMPLE** (por abstención) |
| REQ-166 | Ausencia de dato nunca produce `elegible=true` | No existe lógica de elegibilidad todavía | **SIN EVIDENCIA** |
| REQ-168 | Relevancia y elegibilidad como valores separados | `MatchingPage` es un `EmptyState`, sin scoring implementado | **SIN EVIDENCIA** |
| REQ-169 | Métricas honestas, proyecciones etiquetadas | `PanelPage` no muestra ninguna métrica hasta tener datos reales | **CUMPLE** (por abstención) |
| REQ-170 | Back office con 6 módulos reales (conectores/frescura, jobs, costos IA, evals, incidentes, aprobaciones) | Existen 4 páginas de back office con otra nomenclatura (Organizaciones, Usuarios y roles, Agentes y herramientas, Auditoría); ninguna muestra datos reales aún (correcto) pero no hay mapeo 1:1 confirmable a los 6 módulos exactos exigidos | **PARCIAL** |
| REQ-171 | `correlation_id` reconstruye la cadena completa | Sin backend/logs; sin evidencia | **SIN EVIDENCIA** |

El resto de REQ-142 a REQ-171 no cubiertos arriba no tienen evidencia en `apps/web` en esta ronda,
consistente con lo que el propio `apps/web/README.md` declara como "Qué falta" — no se cuentan como
hallazgos porque el alcance de la ronda 1 (solo interfaz, sin lógica de negocio) está declarado
explícitamente, no oculto.

---

## Tabla de hallazgos

| ID | Severidad | Rubro | Hallazgo (evidencia) | Reparación sugerida (separada) |
|---|---|---|---|---|
| W-01 | **Crítica** | 1, 8 | `packages/agents`, `packages/sources`, `packages/db`, `packages/expediente` y `apps/api` existen en disco pero **nunca fueron añadidos a git** en ningún commit (`git log --all -- packages/` vacío; un clon limpio de `a43efd7` solo trae `apps/web/`, `docs/`, `package.json`), pese a que varios commits/documentos narran esos módulos como completados | Añadir esos directorios a git con `git add`/commit explícito, o si se decide mantenerlos fuera del repo principal, documentarlo y dejar de reportarlos como "despachados" en `docs/PROGRESO.md`/`docs/DECISIONES.md` |
| W-02 | **Crítica** | 1 | `npm run -w apps/web typecheck` y `build` **fallan** en un clon limpio (`TS2307`/`TS2339` en `vite.config.ts`) porque `apps/web/package.json` nunca declara `@types/node`; solo "funcionan" hoy porque `@types/node` queda hospedado en la raíz gracias a W-01 | Agregar `"@types/node"` (versión fija) a `devDependencies` de `apps/web/package.json` |
| W-03 | Alta | 1 | No hay `package-lock.json` versionado en git (ni raíz ni `apps/web`) en ningún commit; `npm install` resuelve rangos semver frescos en cada corrida | Commitear el lockfile generado (o migrar los scripts a `npm ci`) |
| W-04 | Alta | 1, 6 | El reporte "5 vulnerabilities" de `docs/logs/web-ronda1.log` no pertenece a `apps/web`: en clon limpio `npm audit --workspace apps/web` da 0; en el repo de trabajo el mismo comando sigue reportando 5 por una copia anidada vieja de vite/vitest ligada a W-01 — el filtro `--workspace` de `npm audit` no aísla el árbol real | Resolver W-01/W-03 y re-auditar `apps/web` de forma aislada; no confiar en `npm audit --workspace` cuando hay hoisting cruzado entre workspaces no versionados |
| W-05 | Alta | 2, 3 | Violación **serious** de `color-contrast` (2.49:1, requerido 3:1) en modo oscuro: `AtiendeWordmark` (`AtiendeLogo.tsx:51`) usa `style={{ color: "#1D4ED8" }}` fijo, copiado tal cual del componente de referencia, que no se adapta al fondo oscuro | Sustituir el color inline por un token Tailwind (`text-primary` o equivalente) con valor propio en `.dark` |
| W-06 | Alta | 3, 5 | Violación **serious** de `color-contrast` (3.28:1, requerido 4.5:1) en modo claro sobre el badge `warning` de `SourceStatusBadge` (estados "CAPTCHA" y "Cambio de interfaz" — precisamente las dos alertas de fuente caída) | Oscurecer el token `--warning` en modo claro o usar texto oscuro sobre el fondo actual; re-medir con axe |
| W-07 | Media | 3 | Salto de encabezado h1→h3 (sin h2): `CardTitle` (`card.tsx:21`) está fijo a `<h3>` sin forma de configurar el nivel; se repite en cualquier página que combine `SectionHeader` + `Card` | Añadir prop de nivel de encabezado a `CardTitle` (o usar `<h2>` en `SectionHeader`) y ajustar los usos afectados |
| W-08 | Media | 3 | `LoginPage` no tiene landmark `<main>` ni `<h1>` ni envuelve su contenido en un landmark (3 violaciones *moderate* de axe); es la única pantalla que no usa `AppShell` | Envolver el formulario en `<main>` y usar un `<h1>` real para el título |
| W-09 | Alta | 3 | El skip-link de `LoginPage` (`#login-form`) no mueve el foco al activarse (el objetivo es un `<div>` sin `tabindex`) — verificado por teclado real, no detectado por axe automatizado | Dar `tabIndex={-1}` al contenedor `#login-form` o redirigir el `id`/foco a un elemento real |
| W-10 | Baja | 4 | Botón hamburguesa mide 40×40px y el primer link del drawer móvil 36px de alto, por debajo de ≥44×44px recomendado | Aumentar tamaño/padding de esos elementos en el contexto móvil |
| W-11 | Alta | 2 | `docs/investigacion/frontend-restaurantes.md` describe el login real de forma incompleta (sin Google OAuth, sin hero, sin Fraunces/Instrument Sans); `LoginPage.tsx` de licitaciones, fiel a ese documento, no se parece al login real de la marca | Corregir/ampliar el documento de investigación con la anatomía real; decidir explícitamente si licitaciones adopta esa misma anatomía o documenta la divergencia como decisión de producto |
| W-12 | Media | 2, 8 | `apps/web` no tiene ningún guard de ruta: `/panel` y todas las rutas del `AppShell` son accesibles sin sesión; el proyecto de referencia sí protege `/admin` (confirmado por render real) | Agregar un guard mínimo client-side o documentar explícitamente en el README que esta ronda no tiene control de acceso |
| W-13 | Media | 3, 7 | Las pruebas `vitest-axe` corren sobre el subárbol montado por Testing Library, no sobre `document` — no pueden detectar las violaciones de nivel de documento que el render real sí encontró en `/login` (W-08) | Ejecutar axe sobre `document` completo en pruebas de página, o complementar con Playwright+axe (W-14) |
| W-14 | Alta | 7, 8 | No existe ninguna suite Playwright/E2E en `apps/web`; REQ-049 y REQ-065 la exigen explícitamente | Introducir `@playwright/test` y una suite mínima sobre las pantallas existentes (puede partir de `docs/auditoria-1/capturas/capturar.mjs`) |
| W-15 | Baja | 8 | REQ-115 exige disclosure de IA también en el "portal"; no existe ningún texto de ese tipo en `apps/web` | Añadir un elemento de disclosure reutilizable antes de que Redacción/Revisión muestren contenido generado |
| W-16 | Info | 5 | `PackageStatusBadge` acepta `"listo"` sin ninguna guarda propia; hoy no hay ningún llamador que lo produzca, pero la responsabilidad recae enteramente en el futuro integrador | Documentar (o, mejor, forzar en tipos) que `"listo"` solo puede originarse desde una validación de backend explícita |

## Comprobado correcto

- 29/29 pruebas pasan de forma idéntica en un clon de git verdaderamente limpio (mismos 8 archivos,
  mismo resultado que `docs/logs/web-ronda1.log`) — la suite en sí es reproducible aunque el
  build/typecheck no lo sean (W-02).
- Las 3 mutaciones manuales aplicadas en un `git worktree` aislado (aria-label, item de sidebar
  eliminado, estado de paquete forzado a "listo") fueron detectadas por la suite existente — las
  pruebas verifican comportamiento real, no solo presencia de texto.
- `EmptyState`/`ErrorState`: sin datos ficticios en ningún módulo revisado; `ErrorState` siempre
  muestra el mensaje real del error con acción de reintentar.
- `PackageStatusBadge` nunca arranca en "Listo" (hardcodeado a "Borrador", sin ruta de código que
  lo cambie hoy) y `PaqueteDescargablePage` muestra el aviso de que la presentación/firma la hace
  el usuario de forma prominente.
- `SourceStatusBadge` implementa los 5 estados exactos exigidos por la ampliación de back office.
- Sin secretos, URLs de `supabase.co` ni IDs de despliegue de Vercel en `apps/web/src` (grep
  exhaustivo).
- Sin dependencias de adorno: cada paquete declarado tiene uso real confirmado; un solo sistema de
  toast (Sonner, no dos); sin `next-themes` sin usar — mejoras reales y verificadas sobre el
  proyecto de referencia.
- `npm audit --workspace apps/web` da 0 vulnerabilidades cuando se aísla el árbol de dependencias
  real (clon limpio).
- Drawer móvil: accesible, con foco atrapado (fondo marcado `aria-hidden` mientras está abierto,
  confirmado programáticamente), cierra con `Escape` y con el botón de cerrar.
- Sin scroll horizontal a 390px en las pantallas probadas.
- El skip-link de `AppShell` (usado en todas las páginas autenticadas) mueve el foco correctamente
  a `<main>` — verificado por teclado real, no solo por presencia del enlace.
- Modo oscuro real y completo a nivel de toda la interfaz (no solo un filtro superficial) salvo el
  bug puntual de contraste del wordmark (W-05).
- Los dos formularios de login validan con zod antes de llamar a la API y muestran errores reales
  de `ApiError`, nunca simulan éxito.
- El drawer móvil comparte exactamente el mismo `SidebarNav` que el escritorio (una sola fuente de
  verdad de navegación, sin duplicación de contenido que pudiera desincronizarse).

## Capturas y evidencia adjunta

Todas en `docs/auditoria-1/capturas/`:

- `01-login.png`, `01b-login-skiplink-focus.png` — login de licitaciones (desktop, claro).
- `02-panel.png`, `06-panel-focus-visible.png` — panel (desktop, claro).
- `03-fuentes-frescura.png` — módulo con los 5 estados de fuente (W-06).
- `04-paquete-descargable.png` — paquete con aviso y badge "Borrador".
- `05-modulo-empty-state.png` — módulo genérico con `EmptyState`.
- `07-panel-dark.png` — panel en modo oscuro real (clic en el selector), muestra el bug de
  contraste del wordmark (W-05).
- `08-mobile-panel-closed.png`, `09-mobile-drawer-open.png`, `10-mobile-drawer-escape-closed.png` —
  390×844, drawer cerrado/abierto/cerrado con Escape.
- `axe-*.json` — reportes completos de axe-core por página (violaciones, nodos, `failureSummary`).
- `ref-01-login.png`, `ref-02-admin.png`, `ref-03-admin-mobile.png` — render real del proyecto de
  referencia (`atiende-restaurantes`, copia aislada en scratchpad, sin `.env` real).
- `capturar.mjs` — script fuente de todas las capturas/mediciones de esta auditoría (reproducible).

## Comandos ejecutados

Salida real completa en `docs/logs/audit-web-ronda1.log`: clon limpio + `npm install` +
`typecheck`/`lint`/`test`/`build` (rubro 1), `npm audit --workspace apps/web` en clon limpio y en
repo de trabajo (rubro 6). Los pasos de mutación (rubro 7) y de render/axe (rubros 2-4) se
ejecutaron directamente en esta sesión sobre un `git worktree` desechable y sobre el build servido
por `vite preview`, respectivamente; no modificaron el repositorio principal (el worktree se
eliminó con `git worktree remove --force`, y los cambios que se aplicaron dentro de él se
revirtieron con `git checkout --` antes de eso).
