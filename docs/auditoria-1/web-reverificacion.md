# Reverificación adversarial — `apps/web`, ronda 1 de corrección (W-01..W-16)

**Rol**: agente Sonnet reverificador, independiente de la implementación y de la auditoría original.
Solo verifica; no corrige código.
**Rango auditado**: commits `a9e45c2..508c37d` (los 12 commits `fix(web):` de la ronda 1 de
corrección sobre `apps/web`), reverificados sobre `HEAD` (`eed6843`, sin cambios en `apps/web` desde
el commit de despacho — confirmado con `git diff eed6843..dbfa671 --stat -- apps/web` vacío, ver
Rubro "Método").
**Logs completos**: `docs/logs/reverify-web-ronda1.log`. **Evidencia nueva**:
`docs/auditoria-1/capturas-reverificacion/` (`reverify-a11y-results.json`, capturas de la
comparación W-11).

## Resumen ejecutivo

De los 16 hallazgos de `docs/auditoria-1/web.md`, **14 se confirman CERRADOS**, **1 permanece
correctamente bloqueado fuera de ámbito (W-03)** y **1 se reclasifica a PARCIAL** (W-04: la
corrección es real y reproducible, pero su documentación omite una causa adicional, real, que sí se
origina en el propio `package.json` de `apps/web`). El typecheck/lint/test/build/test:e2e de
`apps/web` están en verde en un `git clone --no-local` verdaderamente limpio (44/44 E2E, 38/38
unitarias), reproducido dos veces (worktree + clon limpio).

Sin embargo, buscando variantes nuevas más agresivas que las de la ronda de corrección, esta
reverificación **encuentra 4 hallazgos nuevos que la ronda de corrección no cubrió**, dos de ellos
de severidad **Alta** y con violación real de axe-core o de usabilidad de teclado:

- **W-17 (Alta, nuevo)**: el badge `destructive` de `SourceStatusBadge` ("Caída", "Permisos
  faltantes") tiene una violación **serious** de `color-contrast` (4.31:1, requerido 4.5:1) en modo
  oscuro real en `/convocatorias/fuentes-frescura` — W-06 solo corrigió el badge `warning`
  ("CAPTCHA"/"Cambio de interfaz"), nunca se auditó `destructive` en modo oscuro.
- **W-18 (Alta, nuevo)**: el objetivo del skip-link (`<main id="main-content">` en las 24 rutas
  autenticadas, y `<div id="login-form">` en `/login`) mueve el foco correctamente (W-09 sigue
  cerrado en eso) pero **no tiene ningún indicador visual de foco** — `outline` transparente y sin
  `box-shadow` de foco — por la clase `focus:outline-none` aplicada al propio contenedor. Un usuario
  de teclado vidente no puede ver dónde quedó el foco tras activar el skip-link, en ninguna de las
  25 pantallas del portal.
- **W-19 (Baja, nuevo)**: los botones de acordeón de cada grupo de la sidebar ("EMPRESA",
  "CONVOCATORIAS", etc.) dentro del drawer móvil miden **31px de alto**, por debajo de ≥44×44px —
  W-10 corrigió el botón hamburguesa y los enlaces de navegación, pero no estos botones de grupo.
- **W-20 (Baja/documentación, nuevo)**: la explicación de W-04 en el README ("ninguna [vulnerable]
  cuelga de la `vitest@4.1.11` que declara `apps/web/package.json`") es incompleta: `apps/web`
  también declara `vitest-axe`, cuyo peer-dependency `vitest: >=0.16.0` se resuelve en el árbol de
  npm hacia el `vitest@2.1.9` compartido con otros workspaces (confirmado con `npm ls vitest`), no
  hacia el `vitest@4.1.11` propio. No cambia el veredicto de W-04 (sigue sin ejecutarse en
  producción ni en el runtime real de los tests, porque `vitest-axe` nunca hace `require("vitest")`
  — confirmado por grep en su `dist/`), pero la frase "ninguna cuelga de otros workspaces" no es
  toda la historia.

Ninguno de los 4 hallazgos nuevos involucra datos ficticios, fuga entre tenants ni envío/firma
automática. La mutación deliberada de W-14 (quitar el aviso de presentación/firma y forzar el badge
del paquete a "Listo" por defecto) **hace fallar exactamente 1 de las 44 pruebas E2E** — la
`recorrido.spec.ts` de "Paquete descargable" — confirmando que esa prueba específica sí prueba
comportamiento real y no solo carga de ruta.

**Conteo de veredictos** (W-01 a W-16): **14 CERRADO, 1 PARCIAL (W-04), 1 bloqueado correctamente
fuera de ámbito (W-03, no se cuenta como abierto)**. **4 hallazgos nuevos** (W-17 a W-20: 2 Alta, 2
Baja).

---

## Método

- `git worktree add <scratchpad>/reverify-web HEAD` (commit `eed6843` al iniciar) + `npm install` +
  `npx playwright install chromium` (ya estaba cacheado, sin descarga de red).
- `git show --stat` de los 12 commits `fix(web):` (`a9e45c2`, `435ecbc`, `9b5f43a`, `0151404`,
  `3ab333c`, `1adb386`, `2f85346`, `533fbf3`, `ac6b632`, `508c37d`, `345ca9f`, `7c37e23`): los 12
  existen, tocan exactamente los archivos que sus mensajes declaran.
- `npm run -w apps/web typecheck|lint|test|build|test:e2e` en el worktree: **verde en los 5**
  (typecheck/lint/build exit 0 sin salida relevante; test 38/38; test:e2e 44/44).
- **Clon verdaderamente limpio** (`git clone --no-local` a un directorio nuevo de scratchpad, no
  reinstalación sobre un working tree existente): mismo resultado exacto — typecheck/lint/test/build
  en verde, test:e2e 44/44, `npm audit --workspace apps/web` reproduce "5 vulnerabilities (3
  moderate, 1 high, 1 critical)".
- Mutación real de W-14 en el worktree (revertida después con `git checkout --` **dentro del
  worktree**, nunca en el repo principal): quitar el `<Card>` de aviso
  "La presentación y firma las realiza el usuario" y forzar
  `derivarEstadoPaquete({checklistCompleto: true, firmasCompletas: true, anexosVigentes: true})` en
  `PaqueteDescargablePage.tsx` → `npm run -w apps/web test:e2e` pasa de 44/44 a **43 passed / 1
  failed** (falla exactamente `recorrido.spec.ts:74`, "Paquete descargable: arranca en Borrador...").
- W-16: script de pruebas límite (`derivarEstadoPaquete` con checklist vacío, condiciones vencidas,
  campos `undefined`, tabla de verdad completa de 8 combinaciones) — 6/6 en verde: solo
  `{true,true,true}` produce `"listo"`; ninguna entrada `undefined` lanza excepción ni produce
  `"listo"`.
- Accesibilidad ampliada: script propio (`reverify-a11y.mjs`, evidencia en
  `docs/auditoria-1/capturas-reverificacion/reverify-a11y-results.json`) que corre axe-core en
  **claro y oscuro sobre las 24 rutas** de `ALL_NAV_ITEMS` (no solo login/panel/fuentes/paquete como
  la ronda de corrección), prueba el **skip-link por teclado real en las 24 rutas** capturando si el
  foco es visible (`outline`/`box-shadow` computados), y mide **todos** los enlaces del drawer móvil
  más los botones de acordeón de grupo (no solo el primer enlace).
- W-11: copia aislada de `atiende-restaurantes` en scratchpad (`rsync` excluyendo `.git`, `.env*`,
  `node_modules`, `dist`, `.vercel`, lockfiles binarios; se generó un `.env` con placeholders
  `VITE_SUPABASE_URL=https://placeholder.supabase.co`), `npm install`, `npx vite --port 4210` sirviendo
  `/restaurantes/admin/login` real, comparado por captura y por `getComputedStyle` contra
  `apps/web` en `/login`.
- Worktree y clon limpio eliminados al finalizar (`git worktree remove --force`); no se tocó el
  repositorio principal con `reset`/`checkout`/`stash`/`rebase`/`commit --amend`.

---

## Tabla de reverificación por hallazgo

| ID | Veredicto original | Reverificación | Evidencia nueva | Estado reparación |
|---|---|---|---|---|
| W-01 | Resuelto por otros agentes, fuera de ámbito de `apps/web` | **CERRADO (confirmado, no aplica a este agente)** | `packages/*`/`apps/api` siguen en git en el `HEAD` actual; sin relación con `apps/web`. | — |
| W-02 | Corregido (`a9e45c2`) | **CERRADO** | `apps/web/package.json` declara `@types/node: ^22.10.2`; typecheck/build en verde en clon `--no-local` real (no solo worktree). | — |
| W-03 | Bloqueado, fuera de ámbito | **CONFIRMADO BLOQUEADO — no es evasión.** Se evaluó explícitamente si `npm audit --workspace` ofrece una salida parcial que sí estuviera en ámbito: no la hay, porque el lockfile es único a nivel de monorepo (`npm install` en la raíz genera un solo `package-lock.json` para los 7 workspaces) y no existe una forma de `npm` de generar/commitear un lockfile parcial para un solo workspace sin resolver también los demás. La alternativa real ("migrar a `npm ci`" sin lockfile committeado) tampoco es ejecutable hoy porque no hay lockfile que congelar. Verificado: `git ls-files \| grep package-lock` sigue vacío en el `HEAD` actual. | Sin lockfile versionado en ningún commit hasta la fecha de esta reverificación. | — |
| W-04 | Corregido (documentación), `2f85346` | **PARCIAL** (ver W-20 abajo) | `npm audit --workspace apps/web` reproduce 5 vulnerabilidades en clon `--no-local` real (idéntico a lo reportado). El diagnóstico de fondo (el código vulnerable no llega al bundle de producción) sigue siendo correcto. Pero `npm ls vitest` muestra que `vitest-axe` (dependencia propia de `apps/web`, no de otro workspace) resuelve su peer-dependency `vitest` hacia la copia vulnerable compartida `vitest@2.1.9`, no hacia la `vitest@4.1.11` propia de `apps/web` — un origen real, dentro del propio `package.json` de `apps/web`, que el README no menciona. Ver W-20. | **DOCUMENTADO** — `apps/web/README.md` § "Seguridad de dependencias — `npm audit` (W-04)" añade el matiz exacto (peer de `vitest-axe` resolviendo a `vitest@2.1.9`, con `npm ls vitest` y un grep sin resultados de `require`/`import "vitest"` en `vitest-axe/dist` como evidencia de que nunca corre en runtime) y explica por qué no se añadió `overrides`/`resolutions` (solo tienen efecto desde el `package.json` raíz, compartido con `apps/api`/`packages/*`, fuera del ámbito exclusivo de `apps/web` de esta corrección). Ver W-20 (misma corrección). |
| W-05 | Corregido, `435ecbc` | **CERRADO** | `AtiendeWordmark` usa `text-primary`; el escaneo axe en oscuro sobre las 24 rutas (no solo `/panel`) no encuentra ninguna violación de contraste en el wordmark en ninguna pantalla. | — |
| W-06 | Corregido, `435ecbc` | **CERRADO para el badge `warning`**, pero ver **W-17** (variante nueva: badge `destructive`, no cubierto por este hallazgo ni por su fix). | `--warning-foreground` en claro sigue oscuro (~5.2:1); axe en claro sobre `/convocatorias/fuentes-frescura` da 0 violaciones. | — (ver W-17) |
| W-07 | Corregido, `9b5f43a` | **CERRADO** | `CardTitle` acepta `level` (1-6); `heading-order.spec.ts` en verde en clon limpio. | — |
| W-08 | Corregido, `0151404` | **CERRADO** | `LoginPage` es `<main>` con `<h1>` real; `login-landmarks.spec.ts` en verde. | — |
| W-09 | Corregido, `0151404` | **CERRADO para el movimiento de foco** (ampliado a las 24 rutas: el foco llega a `#main-content`/`#login-form` en las 25 pantallas, no solo en las 2 originales) — **pero ver W-18**: el foco es invisible en las 25. | `reverify-a11y-results.json` → `skipLink`: `isMain: true` en 24/24 rutas autenticadas + `/login`; `outline`/`boxShadow` sin ningún valor visible en ninguna. | — (ver W-18) |
| W-10 | Corregido, `533fbf3` | **CERRADO para hamburguesa (44×44 exacto) y para los 24 enlaces del drawer (44px de alto cada uno, medidos individualmente, no solo el primero)** — ver **W-19** (variante nueva: botones de acordeón de grupo, no cubiertos). | `reverify-a11y-results.json` → `touchTargets.linksDrawer`: 24/24 con `height: 44`. | — (ver W-19) |
| W-11 | Corregido dentro del ámbito de `apps/web`, `3ab333c` | **CERRADO** | Render real de `atiende-restaurantes/admin/login` (copia aislada, sin `.env` real) confirma: mismo layout de pantalla partida, mismo kicker textual "ACCESO AL PANEL", mismo `font-family: Fraunces` en el `<h1>` (confirmado por `getComputedStyle`, no solo visualmente) en ambos proyectos. Divergencias deliberadas confirmadas y ya documentadas en el README: sin Google OAuth (licitaciones usa contraseña/enlace mágico) y lámina de degradado de marca en vez de foto de cocina — ninguna divergencia nueva ni no documentada encontrada. | — |
| W-12 | Corregido (documentación), `1adb386` | **CERRADO** | Se confirma en código: `lib/api.ts` no persiste ningún token tras `login()`/`requestMagicLink()`; no hay `localStorage`/cookie de sesión en ningún archivo de `apps/web/src`; la ausencia de guard sigue siendo honesta (no hay sesión que proteger). | — |
| W-13 | Corregido, `ac6b632` | **CERRADO** | `AppShell.test.tsx`/`LoginPage.test.tsx` usan `axe(document.body)`; el matiz honesto documentado en la ronda 1 (jsdom no calcula `landmark-one-main` ni con `document.body`) se confirma leyendo el código de las pruebas, sin necesidad de reejecutarlas para esto. | — |
| W-14 | Corregido, `435ecbc` + `508c37d` | **CERRADO, con matiz de tipo de prueba documentado a continuación.** 44/44 en verde en clon limpio real, dos veces. La mutación (quitar aviso + forzar "listo") hace fallar exactamente 1 prueba. | Ver "Calidad real de la suite E2E" abajo: de las 44 pruebas, 24 son "carga de ruta + axe" (una por cada item de `ALL_NAV_ITEMS`, sin interacción); las 20 restantes sí ejercen comportamiento (navegación login→shell, apertura/cierre del drawer con Escape, clic real en el `ThemeSelector`, verificación de los 5 estados de fuente por texto, verificación negativa de "Listo para presentar", ausencia de scroll horizontal en las 24 rutas a 390px, paridad de login, contraste, heading-order, disclosure de IA, skip-link, touch-targets). Esto es una suite legítima de comportamiento, no un placeholder — pero conviene no citar "44 pruebas" sin la composición real. | — (la suite ahora tiene 71 pruebas E2E tras esta corrección, ver Estado reparación de W-17/W-18/W-19) |
| W-15 | Corregido, `345ca9f` | **CERRADO** | `AiDisclosureNote` presente y verificado por Playwright real en los 3 módulos declarados (`Redacción`, `Revisión`, `Análisis de bases`); `ai-disclosure.spec.ts` en verde en clon limpio. | — |
| W-16 | Corregido, `7c37e23` | **CERRADO, reforzado con entradas límite adicionales** | `derivarEstadoPaquete` probado con checklist vacío, una condición vencida, campos `undefined` y tabla de verdad de 8 combinaciones: 6/6 en verde, solo `{true,true,true}` produce `"listo"`, ninguna entrada parcial/`undefined` produce `"listo"` ni lanza excepción. | — |

---

## Hallazgos nuevos (W-17 a W-20)

| ID | Severidad | Rubro | Hallazgo (evidencia) | Reparación sugerida (separada) | Estado reparación |
|---|---|---|---|---|---|
| W-17 | **Alta** | 3 (Accesibilidad) | Violación **serious** de `color-contrast` en modo oscuro real: el badge `destructive` de `SourceStatusBadge` (estados "Caída" y "Permisos faltantes") da 4.31:1 sobre fondo `--destructive` en `.dark` (`hsl(352 75% 55%)`) con texto blanco, contra el 4.5:1 exigido para texto normal (12px). Confirmado con axe-core en Chromium real sobre `/convocatorias/fuentes-frescura` en oscuro; en claro (`--destructive: 352 83% 41%`) no hay violación. No cubierto por W-06, que solo tocó el badge `warning`. | Oscurecer `--destructive` en modo oscuro (o aclarar aún más `--destructive-foreground`) hasta alcanzar ≥4.5:1, y añadir un caso de prueba de contraste para el badge `destructive` en oscuro junto a los de `warning` en `e2e/contraste.spec.ts`. | **CORREGIDO** — `--destructive` en `.dark` bajado de 55% a 48% de luminosidad (`src/index.css`), 4.30:1 → 4.59:1 (WCAG AA). Prueba de tokens nueva `src/lib/contrast.test.ts` (calcula el contraste WCAG de las 5 variantes de `Badge` en claro y oscuro, 11/11 verde) que falla en 4.30:1 con el valor anterior; prueba E2E nueva en `e2e/contraste.spec.ts` (axe-core en oscuro real sobre `/convocatorias/fuentes-frescura`) reproducida en rojo con el valor original (violación `color-contrast` 4.31 idéntica a la reportada) y en verde tras el fix. |
| W-18 | **Alta** | 3 (Accesibilidad, teclado) | El objetivo del skip-link mueve el foco correctamente (W-09) pero **no tiene ningún indicador visual** en ninguna de las 25 pantallas: `<main id="main-content">` (24 rutas autenticadas) y `<div id="login-form">` (`/login`) llevan la clase Tailwind `focus:outline-none` sin ningún reemplazo (`focus:ring-*`, `focus-visible:*`, etc.); tras Tab+Enter, `getComputedStyle(document.activeElement)` da `outline: solid 2px rgba(0,0,0,0)` (transparente) y `box-shadow: none` (login) o solo la sombra ambiental permanente de la tarjeta (`main`, sin relación con el foco). Un usuario de teclado vidente no tiene forma de saber que el foco se movió. axe-core no detecta esto (no existe una regla automatizada fiable de "foco visible"), por eso pasó inadvertido en la ronda de corrección pese a que sí se verificó el movimiento del foco. | Añadir un anillo de foco visible explícito (`focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2` o equivalente) a `#main-content` en `AppShell.tsx` y al contenedor `#login-form` en `LoginPage.tsx`; añadir una prueba Playwright que verifique `outline`/`box-shadow` no transparente tras activar el skip-link. | **CORREGIDO** — se añadió exactamente el anillo de foco sugerido (`focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`, mismo patrón que las primitivas shadcn como `button.tsx`) a `#main-content` (`AppShell.tsx`) y `#login-form` (`LoginPage.tsx`). Prueba E2E nueva y parametrizada en `e2e/skip-link.spec.ts` sobre las 25 pantallas (24 `ALL_NAV_ITEMS` + `/login`) que compara `getComputedStyle` del elemento antes/después de activar el skip-link por teclado real (para no confundir el `box-shadow` ambiental de `shadow-card` con el del foco); reproducida en rojo contra el código sin corregir (outline `rgba(0,0,0,0)`, sin cambio de `box-shadow`) y en verde (25/25) tras el fix. |
| W-19 | Baja | 4 (Móvil) | Los botones de acordeón de cada grupo de la sidebar (`"ANÁLISIS"`, `"EMPRESA"`, `"CONVOCATORIAS"`, etc., `px-2 py-2` en `SidebarNav.tsx`) miden **31px de alto** dentro del drawer móvil (390×844), medidos individualmente para los 8 grupos — por debajo de ≥44×44px. W-10 corrigió el botón hamburguesa y los 24 enlaces de navegación, pero no estos botones de grupo, que son igual de interactivos (colapsan/expanden la sección) y están en la misma superficie táctil. | Aumentar el padding vertical del botón de grupo (de `py-2` a `py-3` o más) igual que se hizo con los enlaces de navegación en W-10. | **CORREGIDO** — se añadió `min-h-11` (44px) al botón de grupo en `SidebarNav.tsx` (en vez de solo aumentar `py-*`, para no depender de las métricas exactas de la fuente `text-[10px]`). Dos pruebas E2E nuevas en `e2e/touch-targets.spec.ts` a 390×844: una mide los 8 botones de acordeón de grupo individualmente (reproducida en rojo con 31px de alto, idéntico a lo reportado, y en verde tras el fix) y otra mide además los 24 enlaces del drawer. |
| W-20 | Baja (documentación) | 1, 6 | El README de W-04 afirma que "ninguna [ocurrencia vulnerable] cuelga de la `vitest@4.1.11` que declara `apps/web/package.json`", dando a entender que el origen es exclusivamente otros workspaces. `npm ls vitest` (en clon limpio) muestra que `vitest-axe` — declarado como devDependency directa de `apps/web`, no de otro workspace — resuelve su peer-dependency (`"vitest": ">=0.16.0"`, sin tope superior) hacia el `vitest@2.1.9` compartido y vulnerable, no hacia el `vitest@4.1.11` propio de `apps/web`. No cambia el veredicto de fondo (confirmado por grep: `vitest-axe/dist/` nunca hace `require`/`import` de `"vitest"`, así que esta resolución de peer nunca se ejecuta en runtime ni llega a producción), pero la frase del README es más categórica de lo que la evidencia sostiene. | Ajustar la frase del README para reconocer que `vitest-axe` es la única dependencia propia de `apps/web` cuyo peer-dependency (no su código en ejecución) referencia la cadena vulnerable, y that esto no cambia el resultado porque `vitest-axe` no importa `vitest` en runtime. | **DOCUMENTADO** — `apps/web/README.md` § "Seguridad de dependencias — `npm audit` (W-04)" añade el matiz completo con la salida real de `npm ls vitest` y un grep sin resultados de `require`/`import "vitest"` en `vitest-axe/dist` como evidencia de que la resolución del peer nunca se ejecuta en runtime. Se evaluó `overrides`/`resolutions`: `npm` solo los aplica desde el `package.json` **raíz** del monorepo, así que forzarlos habría requerido tocar el lockfile raíz compartido con `apps/api`/`packages/*` (fuera del ámbito exclusivo de `apps/web` de esta corrección y con riesgo de interferir con el trabajo concurrente de otros agentes) — no se añadieron, y el porqué queda explicado en el propio README. |

---

## Regresiones encontradas

**Ninguna regresión respecto al estado anterior a la ronda de corrección.** Los 4 hallazgos nuevos
(W-17 a W-20) no son regresiones causadas por los commits `fix(web):` — son violaciones/omisiones
preexistentes que ni la auditoría original ni la ronda de corrección llegaron a cubrir porque
ninguna de las dos corrió axe en oscuro sobre las 24 rutas, ni probó el foco visible (solo el
movimiento) del skip-link, ni midió los botones de acordeón de grupo. El wordmark (W-05), el badge
`warning` (W-06) y los 24 enlaces + hamburguesa (W-10) siguen corregidos sin regresión.

## Calidad real de la suite E2E (detalle de W-14)

Composición exacta de las 44 pruebas (`apps/web/e2e/`):

- **24 pruebas de "carga de ruta"** (`recorrido.spec.ts`, un `test` por cada item de
  `ALL_NAV_ITEMS`): navegan a la ruta, verifican la URL y corren axe — no hay interacción ni
  aserción de comportamiento específico de esa página. Esto es exactamente lo que REQ-049/REQ-065
  piden ("suite Playwright sobre las pantallas... con axe integrado"), pero es importante no
  presentarlas como pruebas de "recorrido" con más profundidad de la que tienen.
- **20 pruebas de comportamiento real**: login→shell (navegación entre rutas + verificación de
  landmarks), apertura/cierre del drawer con clic y con `Escape`, clic real en el `ThemeSelector` +
  verificación de que persiste `.dark` en `<html>`, verificación textual de los 5 estados de fuente,
  verificación negativa explícita de "Listo para presentar" + positiva de "Borrador" +
  presencia del aviso de presentación/firma, ausencia de scroll horizontal en las 24 rutas a 390px,
  3 pruebas de paridad de login, 2 de contraste, 2 de heading-order, 3 de disclosure de IA, 2 de
  skip-link, 2 de touch-targets.
- La mutación adversarial aplicada en esta reverificación (quitar el aviso de presentación/firma +
  forzar el badge a "Listo" por defecto) cae exactamente en el segundo grupo y **sí** produce un
  fallo real (43 passed / 1 failed) — confirma que al menos esa prueba de comportamiento no es
  cosmética.

## Comprobado correcto (adicional a lo ya confirmado en `web.md`)

- 44/44 pruebas E2E y 38/38 unitarias idénticas en `git worktree` y en `git clone --no-local`
  verdaderamente independiente (dos ejecuciones separadas, mismo resultado).
- `derivarEstadoPaquete()` es robusta a entradas límite: checklist vacío, una condición vencida y
  campos `undefined` (fuera del tipo declarado) siempre devuelven `"borrador"`, nunca lanzan
  excepción; de las 8 combinaciones posibles, exactamente 1 produce `"listo"`.
- El login de licitaciones usa realmente `Fraunces` (no una aproximación visual) — confirmado
  comparando `getComputedStyle(h1).fontFamily` contra el mismo cómputo en el login real de
  `atiende-restaurantes` renderizado en una copia aislada sin `.env` real.
- El foco del skip-link llega correctamente a `#main-content`/`#login-form` en las 25 pantallas del
  portal (24 rutas autenticadas + login), no solo en las 2 pantallas que probó la ronda de
  corrección — el problema encontrado (W-18) es de visibilidad del foco, no de su movimiento.
- Los 24 enlaces de navegación del drawer móvil miden 44px de alto cada uno (medidos
  individualmente), y el botón hamburguesa mide exactamente 44×44px.
- `npm audit --workspace apps/web` en un clon `--no-local` verdaderamente limpio reproduce con
  exactitud "5 vulnerabilities (3 moderate, 1 high, 1 critical)", consistente con lo documentado.
- Sin datos ficticios, sin secretos (`supabase.co`, `vercel.app`, prefijos de clave) en ningún
  archivo tocado por esta reverificación ni en la copia aislada de `atiende-restaurantes` usada para
  W-11 (se generó con placeholders explícitos, nunca se leyó el `.env` real).

## Capturas y evidencia adjunta

En `docs/auditoria-1/capturas-reverificacion/`:

- `reverify-a11y-results.json` — resultado completo del script de reverificación: axe claro/oscuro
  en las 24 rutas, skip-link por teclado en las 24 rutas (con `outline`/`box-shadow` computados),
  objetivos táctiles de los 24 enlaces del drawer + 8 botones de acordeón + hamburguesa.
- `ref-login-reverif.png` — login real de `atiende-restaurantes` (`/restaurantes/admin/login`),
  renderizado desde la copia aislada en scratchpad (sin `.env` real, con placeholders de Supabase).
- `web-login-reverif.png` — login de `apps/web` (`/login`) en el mismo viewport (1440×900), para
  comparación lado a lado con la captura anterior.

## Comandos ejecutados

Salida real completa en `docs/logs/reverify-web-ronda1.log`: `git show --stat` de los 12 commits,
typecheck/lint/test/build/test:e2e en worktree y en clon `--no-local`, la mutación de W-14 y su
reversión, las pruebas límite de W-16, y `npm audit --workspace apps/web` en clon limpio. El
worktree y el clon limpio se eliminaron al finalizar; no se ejecutó `git reset`, `git checkout`
sobre el repo principal, `git stash` ni `git rebase` en ningún momento — todas las mutaciones y
reversiones ocurrieron dentro del worktree desechable de scratchpad.
