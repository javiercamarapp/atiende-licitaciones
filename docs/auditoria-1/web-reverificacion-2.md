# Reverificación adversarial 2 — `apps/web` (W-17, W-18, W-19, W-04/W-20, W-03)

**Rol**: agente Sonnet reverificador, ronda 2, independiente de la implementación y de la
reverificación 1 (`docs/auditoria-1/web-reverificacion.md`). Solo verifica; no corrige código.

**Rango auditado**: los 4 commits `fix(web):` de la ronda 2 de corrección —
`946914a` (W-17), `ad26360` (W-18), `81e64b1` (W-19), `c043f7a` (W-04/W-20) — más el commit
`d739f13` (`chore: package-lock.json raíz`, W-03) del orquestador. Los 5 son ancestros directos de
`HEAD` (confirmado con `git merge-base --is-ancestor`, ver Método). El repositorio principal
avanzó por trabajo concurrente de otros agentes durante esta reverificación (de `faf54c5` a
`802cff6`); se verificó explícitamente que los 5 commits siguen siendo ancestros del nuevo `HEAD`
antes de cerrar el informe.

**Logs completos**: `docs/logs/reverify2-web.log`. **Evidencia nueva**:
`docs/auditoria-1/capturas-reverificacion-2/` (capturas + `reverify2-attack-results.json`, salida
completa del script de ataque propio).

## Resumen ejecutivo

Los 4 hallazgos de la ronda de corrección 2 (W-17, W-18, W-19) se confirman **CERRADOS**, y
resisten ataques deliberadamente más agresivos que los de sus propias pruebas: axe-core en las
**48 combinaciones** (24 rutas + login × claro/oscuro, no solo `/convocatorias/fuentes-frescura`)
da **0 violaciones** serious/critical; el foco visible del skip-link se verificó con **teclado
real** (Tab + Enter, no `.focus()` programático) en las **96 combinaciones** (25 pantallas ×
claro/oscuro × `prefers-reduced-motion` normal/reducido), con el anillo de foco dando **≥4.8:1**
de contraste contra el fondo en los 4 casos (muy por encima del 3:1 exigido por WCAG 1.4.11 para
indicadores no textuales, y por encima incluso en oscuro); los 8 botones de acordeón y los 23
enlaces del drawer miden 44px de alto en **ambos** viewports pedidos (320×568 y 390×844, no solo
390×844). W-04/W-20 (matiz de `vitest-axe` en el README) se reproduce con exactitud byte a byte
(`npm ls vitest`, el grep sin resultados, y "5 vulnerabilities (3 moderate, 1 high, 1 critical)").
W-03 (lockfile) se confirma **CERRADO**: `package-lock.json` sigue versionado en el `HEAD` actual y
`npm ci` instala limpio contra él en un clon `--no-local` real.

La regresión completa es limpia: **49/49 unitarias y 71/71 E2E** en un `git clone --no-local`
verdaderamente independiente. Se preservan los 5 estados de fuente, "Borrador" por defecto, el
aviso de presentación/firma, y no se encontraron datos ficticios ni secretos.

Sin embargo, ampliando el ataque de W-19 a **todos** los controles del header (no solo el
hamburguesa y el drawer), esta reverificación encuentra **1 hallazgo nuevo de severidad Alta**:

- **W-21 (Alta, nuevo)**: el `ThemeSelector` (los 3 botones "Tema claro/Seguir al
  sistema/Tema oscuro") queda **completamente fuera del viewport, invisible e intocable**, en
  *todo* ancho de pantalla menor a 466px CSS — es decir, en el 100% de los teléfonos móviles
  comunes en orientación vertical (320, 375, 390, 412, 414, 430px probados; el corte real está en
  466px). La causa es que `OrganizationSwitcher` fuerza `w-[180px]` fijo (nunca se encoge por
  debajo de eso) dentro de un contenedor `flex` sin `flex-wrap`, así que el `ThemeSelector` que le
  sigue queda desplazado más allá del borde derecho del viewport. Esto **no lo detecta** la prueba
  existente "sin scroll horizontal a 390×844" de `recorrido.spec.ts` porque `html { overflow-x:
  clip }` (definido en `src/index.css`) suprime cualquier barra de scroll sin arreglar el layout:
  `document.documentElement.scrollWidth === clientWidth` da `true` exactamente porque el contenido
  desbordado queda recortado y oculto, no porque quepa. El control sigue siendo alcanzable por
  teclado (`Tab`), pero un usuario de teclado vidente tabularía hacia un control que no puede ver
  en absoluto. Es una regresión de **funcionalidad completa** (no solo de tamaño táctil): en
  móvil, cambiar de tema es imposible.

Dos hallazgos adicionales de severidad Baja, en la misma superficie (header/drawer) que W-19 no
cubrió:

- **W-22 (Baja, nuevo)**: el disparador de `OrganizationSwitcher` mide 180×**36px** (por debajo de
  44px de alto) y el botón "Cerrar menú" del drawer móvil (`SheetPrimitive.Close`, `X` de 16px +
  `p-1.5`) mide **28×28px** — ninguno de los dos es un enlace de navegación ni un botón de
  acordeón de grupo, así que ninguno de los dos quedó cubierto por W-10 ni por W-19.
- **W-23 (Baja, nuevo, infraestructura de pruebas)**: el primer intento de correr
  `test:e2e` en el worktree de esta reverificación dio **65 de 71 fallidas**, todas navegando a
  una URL `/calendario` que no existe en ningún lugar de este código — causado por una colisión de
  puerto real: `playwright.config.ts` fija `PORT = 4173` (el puerto por defecto de `vite preview`)
  con `reuseExistingServer: !process.env.CI`, y en esta máquina había, en paralelo, otro worktree
  de otro agente de reverificación (`.../scratchpad/reverify2-exp`) con el **mismo**
  `playwright.config.ts` apuntando al mismo puerto. Un segundo servidor (de otro proyecto, con una
  ruta `/calendario` real) debió ocupar el puerto un instante antes; Playwright, al ver algo
  respondiendo en `127.0.0.1:4173`, lo dio por bueno sin verificar que fuera *esta* build. Una
  repetición inmediata (con el puerto verificado libre antes de arrancar) dio 71/71 en verde, dos
  veces, incluida la del clon limpio — confirmando que no es una regresión del código sino una
  fragilidad del arnés de pruebas al correr con otros agentes en la misma máquina. No cambia
  ningún veredicto (no se lo cuenta como fallo real de la suite), pero merece corrección
  independiente (puerto aleatorio o `reuseExistingServer: false` fuera de CI).

Ninguno de los 4 hallazgos nuevos involucra datos ficticios, fuga entre tenants ni
envío/firma automática.

**Conteo de veredictos de esta ronda**: W-17 CERRADO, W-18 CERRADO, W-19 CERRADO, W-04/W-20
CERRADO, W-03 CONFIRMADO CERRADO. **3 hallazgos nuevos** (W-21 Alta, W-22 Baja, W-23 Baja/infra).

**Balance de abiertos del paquete `apps/web`** (acumulando las 2 rondas): de los 20 hallazgos
originales (W-01 a W-20), **20/20 CERRADOS** (incluyendo ahora W-03, W-04 y W-20).

**Actualización ronda 3** (agente implementador, ver columna "Estado reparación" de la tabla de
hallazgos nuevos abajo y `docs/logs/web-ronda3.log`): **W-21, W-22 y W-23 quedan también
CERRADOS** — 23/23 hallazgos de `apps/web` cerrados en total. W-21 se corrigió junto con un
segundo bug relacionado que la propia verificación encontró (el drawer móvil sin
`overflow-y-auto` empujaba el footer de tema fuera del viewport en el eje Y, algo que la prueba
original de W-21 no medía por revisar solo `x`). Verificado con Playwright real contra `apps/api`
real (`test:e2e:full`, no solo el build estático) además de la propia suite de accesibilidad/layout.

---

## Método

- `git worktree add <scratchpad>/reverify2-web HEAD` (commit `faf54c5` al iniciar) + `npm install`
  (root, monorepo) + `npx playwright install chromium` (ya cacheado, sin descarga de red).
- Ancestría: `git merge-base --is-ancestor <sha> HEAD` para los 5 commits (`946914a`, `ad26360`,
  `81e64b1`, `c043f7a`, `d739f13`) — los 5 dan verdadero, tanto contra el `HEAD` inicial (`faf54c5`)
  como contra el `HEAD` final tras el avance concurrente del repo (`802cff6`).
- `git show --stat` de los 4 commits `fix(web):`: los 4 tocan exactamente los archivos que sus
  mensajes declaran (`src/index.css` + 2 archivos de prueba nuevos para W-17;
  `AppShell.tsx`/`LoginPage.tsx` + `e2e/skip-link.spec.ts` para W-18; `SidebarNav.tsx` +
  `e2e/touch-targets.spec.ts` para W-19; solo `README.md` + la tabla de la reverificación 1 para
  W-04/W-20).
- `npm run -w apps/web typecheck|lint|test|build` en el worktree: verde en los 4 (49/49 unitarias).
- `test:e2e` en el worktree: **primer intento 65 fallidos / 6 pasados** por colisión de puerto real
  con otro worktree concurrente (ver W-23); repetido con el puerto verificado libre (`lsof
  -iTCP:4173`, monitoreado cada 2s durante la corrida): **71/71 en verde**, reproducido dos veces.
- **Clon verdaderamente limpio** (`git clone --no-local` a un directorio nuevo de scratchpad):
  `npm ci` (no solo `npm install`, para ejercer W-03 tal como se usaría en CI) instala limpio
  contra el `package-lock.json` versionado; typecheck/lint/test/build/test:e2e en verde
  (49/49 + 71/71); `npm audit --workspace apps/web` reproduce exactamente "5 vulnerabilities (3
  moderate, 1 high, 1 critical)"; `npm ls vitest` y el grep de `vitest-axe/dist` reproducen
  exactamente lo que documenta el README (ver tabla W-04/W-20 abajo).
- **Ataque de accesibilidad ampliado** (`attack-reverify2.mjs`, evidencia completa en
  `reverify2-attack-results.json`):
  - axe-core (`@axe-core/playwright`) en las **24 rutas de `ALL_NAV_ITEMS` + `/login`**, en
    **claro y oscuro** (48 combinaciones) — no solo `/panel` y `/convocatorias/fuentes-frescura`
    como las pruebas ya commiteadas.
  - Skip-link con **teclado real** (`page.keyboard.press("Tab")` + `("Enter")`, nunca
    `element.focus()` desde JS) en las 25 pantallas (24 rutas + login), cruzado con
    **claro/oscuro** y **`prefers-reduced-motion: no-preference/reduce`** (vía
    `browser.newContext({ reducedMotion })` de Playwright) — 96 combinaciones. Para cada una se
    leyó `getComputedStyle` del elemento enfocado y se calculó el contraste WCAG real (fórmula de
    luminancia relativa) del color del anillo de foco contra el color de fondo detrás de él.
  - Objetivos táctiles a **320×568** (además de 390×844) de **todos** los controles interactivos
    del header (hamburguesa, `OrganizationSwitcher`, los 3 botones de `ThemeSelector`) y del
    drawer móvil (23 enlaces, 8 botones de acordeón de grupo, y el botón "Cerrar menú" del
    `Sheet`) — no solo los enlaces y los botones de grupo que ya prueba `touch-targets.spec.ts`.
  - Al revisar por qué el `ThemeSelector` no aparecía en las capturas de 320px, se midió su
    `getBoundingClientRect()` en 320/375/390/412/414/430/466/480/500px de viewport — confirmando
    que queda fuera del viewport (`rect.left > vw`) en todo ancho <466px (W-21).
- Capturas en `docs/auditoria-1/capturas-reverificacion-2/`: badges en oscuro (`w17-badges-oscuro.png`),
  foco visible en oscuro tras skip-link (`w18-foco-oscuro.png`), header + drawer a 320px
  (`w21-header-320.png`, `w21-drawer-320.png`), y el header a 390px mostrando la ausencia visual
  del `ThemeSelector` (`w22-header-390-theme-oculto.png` — el nombre del archivo usa el número de
  hallazgo asignado antes de reordenar la numeración final a W-21/W-22; el contenido es el mismo).
- Worktree y clon limpio eliminados al finalizar (`git worktree remove --force`); no se tocó el
  repositorio principal con `reset`/`checkout`/`stash`/`rebase`/`commit --amend`.

---

## Tabla de reverificación por hallazgo

| ID | Corrección | Reverificación | Evidencia nueva | Veredicto |
|---|---|---|---|---|
| W-17 | `946914a`: `--destructive` en `.dark` 55%→48% de luminosidad | **CERRADO, reforzado.** axe-core en las 48 combinaciones (24 rutas + login × claro/oscuro) da 0 violaciones serious/critical — no solo en `/convocatorias/fuentes-frescura` como el fix original. El contraste real medido (52.5%→48% en HSL, `4.30:1→4.59:1` documentado) se confirma consistente con el resto de la paleta: `warning`/`success`/`default`/`secondary` también pasan en ambos temas. | `reverify2-attack-results.json` → `axe`: 0/48 rutas con violaciones. | **CERRADO** |
| W-18 | `ad26360`: anillo `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2` en `#main-content`/`#login-form` | **CERRADO, reforzado.** El foco llega al destino correcto en las 96 combinaciones (25 pantallas × claro/oscuro × reduced-motion). El anillo de foco (color `--ring`) da **6.37:1** (claro, contra `--background`) y **6.04:1** (oscuro, contra `--background`) de contraste — muy por encima del 3:1 mínimo de WCAG 1.4.11 para indicadores de foco no textuales, y sin degradarse con `prefers-reduced-motion: reduce` (el anillo no depende de animación). | `reverify2-attack-results.json` → `skipLinkFocus`: 96/96 con foco en el destino correcto; contraste del anillo calculado por fórmula de luminancia relativa (código en `attack-reverify2.mjs`). | **CERRADO** |
| W-19 | `81e64b1`: `min-h-11` en los botones de acordeón de grupo de `SidebarNav.tsx` | **CERRADO, ampliado a 320×568.** Los 8 botones de acordeón miden 44px de alto en **ambos** viewports (320×568 y 390×844) — la ronda de corrección solo había verificado 390×844. Los 23 enlaces del drawer y el botón hamburguesa también miden 44px/44×44px en ambos. | `reverify2-attack-results.json` → `touchTargets["320x568"]` y `["390x844"]`: 8/8 botones de grupo y 23/23 enlaces a 44px en ambos. | **CERRADO** |
| W-04 / W-20 | `c043f7a`: matiz de `vitest-axe`→`vitest@2.1.9` en el README | **CERRADO.** `npm ls vitest` en clon `--no-local` reproduce exactamente el árbol citado en el README (`vitest-axe@0.1.0` → `vitest@2.1.9 deduped`, separado del `vitest@4.1.11` propio); el grep de `require`/`import "vitest"` en `vitest-axe/dist` sigue sin resultados; `npm audit --workspace apps/web` reproduce "5 vulnerabilities (3 moderate, 1 high, 1 critical)" con exactitud. | Ver Método; salida completa en `docs/logs/reverify2-web.log`. | **CERRADO** |
| W-03 | `d739f13` (orquestador): `package-lock.json` raíz commiteado | **CONFIRMADO CERRADO.** `git ls-files` en el `HEAD` actual incluye `package-lock.json`; en un clon `--no-local` real, `npm ci` (no solo `npm install`) instala limpio contra ese lockfile sin resolver de nuevo el árbol — exactamente el caso de uso que motivó el hallazgo original (reproducibilidad del build). | `git ls-files \| grep -x package-lock.json` → presente; `npm ci` en clon limpio → exit 0, "added 677 packages". | **CERRADO** |

---

## Hallazgos nuevos (W-21 a W-23)

| ID | Severidad | Rubro | Hallazgo (evidencia) | Reparación sugerida | Estado reparación |
|---|---|---|---|---|---|
| W-21 | **Alta** | 4 (Móvil), 3 (Accesibilidad, reflow) | El `ThemeSelector` (3 botones de radio "Tema claro"/"Seguir al sistema"/"Tema oscuro", en el header de `AppShell.tsx`) queda **fuera del viewport y completamente invisible/intocable** en todo ancho <466px CSS — cubre el 100% de los teléfonos en vertical (probado en 320, 375, 390, 412, 414, 430px; visible recién a partir de 466px). Causa raíz: `OrganizationSwitcher` (`src/components/layout/OrganizationSwitcher.tsx`) fija `w-[180px]` sin encogerse en móvil, dentro de un `<div className="flex items-center gap-3">` sin `flex-wrap`; el `ThemeSelector` que le sigue queda desplazado más allá del borde derecho. La prueba existente de "sin scroll horizontal a 390×844" (`recorrido.spec.ts`) no lo detecta porque `html { overflow-x: clip }` (`src/index.css`) recorta el desborde sin generar scrollbar, así que `scrollWidth === clientWidth` da verdadero aunque haya contenido invisible fuera de pantalla. El control sigue siendo alcanzable con `Tab` (foco invisible en un elemento fuera de vista), pero no hay forma visual ni táctil de usarlo en un teléfono real. | Dar a `OrganizationSwitcher` un ancho que se encoja en móvil (p. ej. `w-auto max-w-[140px]` con `truncate`, o colapsarlo a solo el ícono con un `Popover`/`Sheet` propio por debajo de `sm`), o mover `ThemeSelector` dentro del drawer móvil en vez del header en breakpoints angostos; añadir una prueba que mida `getBoundingClientRect()` de cada control del header contra el viewport (no solo `scrollWidth` del documento) a 320/390px. | **CERRADO** (ronda 3, commits `99d7095` "W-21 el ThemeSelector queda dentro del viewport en móvil" y `2963e30` "el drawer móvil sin overflow-y-auto empujaba el footer de tema fuera del viewport"). `ThemeSelector` se retiró del header en <md (vive en el drawer móvil, siempre con espacio de sobra) y solo se muestra en el header desde `md` (donde la sidebar fija libera ancho real); `OrganizationSwitcher` pasó de `w-[180px]` fijo a fluido (`min-w-0 flex-1` con `truncate`, techo `max-w-[9.5rem]` en móvil). Se encontró y corrigió un SEGUNDO bug relacionado durante la propia verificación: el `<SidebarNav/>` del drawer no tenía `overflow-y-auto` (sí lo tiene la sidebar de escritorio), así que la lista de navegación —ahora más larga, con los 5 items nuevos de back office de esta ronda— empujaba el footer de tema fuera del viewport en el eje Y (un `x` dentro de rango podía coexistir con un `y` fuera de rango; la prueba original de W-21 solo medía `x`). Prueba real nueva (`e2e/touch-targets.spec.ts`, describe "Controles del header dentro del viewport (W-21)"): mide `boundingBox()` de cada control del header/drawer contra el viewport real (x **e y**) a 320×568 y 390×844, y hace click real en el radio "Tema oscuro" del drawer para confirmar que es clicable de verdad, no solo visible. Verificado en verde en `docs/logs/web-ronda3.log` (`test:e2e:full` contra apps/api real). |
| W-22 | Baja | 4 (Móvil) | Dos controles interactivos del header/drawer miden menos de 44×44px y no fueron cubiertos por W-10 (enlaces + hamburguesa) ni W-19 (botones de acordeón de grupo): el disparador de `OrganizationSwitcher` mide **180×36px** de alto, y el botón "Cerrar menú" del drawer (`SheetPrimitive.Close` en `src/components/ui/sheet.tsx`, ícono `X` de 16px + `p-1.5`) mide **28×28px**. Medido en ambos viewports pedidos (320×568 y 390×844), mismo resultado. | Aumentar `h-9`→`h-11` en `OrganizationSwitcher` (o envolver en un contenedor de 44px con el control centrado); aumentar el padding del botón de cierre del `Sheet` (de `p-1.5` a `p-2.5`, o `min-h-11 min-w-11`) igual que W-10/W-19 hicieron con el resto de la superficie táctil del drawer. | **CERRADO** (ronda 3). `OrganizationSwitcher`: `h-9`→`h-11` (commit `0f29474`, incluido en la reescritura del selector con datos reales de memberships). `Sheet` "Cerrar menú": tamaño fijo `h-11 w-11` (no solo padding, para garantizar 44×44px sin importar el ícono interior) — commit `3e7b129` "W-22 objetivos táctiles de OrganizationSwitcher y Cerrar menú". Prueba real ampliada (`e2e/touch-targets.spec.ts`, describe "W-22: OrganizationSwitcher y 'Cerrar menú' del drawer..."): mide ambos controles a 320×568 **y** 390×844 (la ronda de corrección original solo había verificado uno). Verde en `docs/logs/web-ronda3.log`. |
| W-23 | Baja (infraestructura de pruebas) | 1 (metodológico) | `playwright.config.ts` fija `PORT = 4173` con `reuseExistingServer: !process.env.CI`; en un entorno con varios agentes/worktrees corriendo en paralelo en la misma máquina (como el de esta auditoría), un segundo proceso ajeno ocupando ese mismo puerto por defecto de `vite preview` hace que Playwright reutilice ese servidor sin verificar que sirva esta build — se reprodujo en vivo: el primer intento de `test:e2e` en esta reverificación dio 65/71 fallidas navegando a una URL (`/calendario`) que no existe en este código, coincidiendo con la ventana en que otro worktree de reverificación (`reverify2-exp`, mismo `playwright.config.ts`, mismo puerto) pudo estar activo; una repetición con el puerto verificado libre dio 71/71 en verde, dos veces. No afecta a CI (`reuseExistingServer` es `false` ahí) ni cambia ningún veredicto de esta ronda. | Usar un puerto derivado de `process.pid` o de una variable de entorno inyectada por CI/dev-runner, o forzar `reuseExistingServer: false` fuera de CI también (a costa de un arranque más lento por corrida), para que una colisión de puerto falle rápido y explícito en vez de servir contenido de otro proceso en silencio. | **CERRADO** (ronda 3, commit `7069a23` "W-23 puerto E2E configurable, sin reutilizar un servidor ajeno"). El puerto por defecto ya no es 4173: se deriva de `PID % 300 + 4200` (o de `PLAYWRIGHT_PORT` si se fija explícitamente), distinto en cada corrida concurrente sin coordinación manual; `reuseExistingServer` pasó a `false` incondicional (no solo fuera de CI) — Playwright arranca siempre su propio `vite preview --strictPort`, así que una colisión de puerto falla rápido y explícito en vez de servir en silencio el contenido de otro proceso. Nota honesta: esta ronda además introdujo `npm run test:e2e:full` (arranca `apps/api` real), lo que multiplicó los procesos reales corriendo en la máquina durante el desarrollo — el propio `E2E_API_PORT`/`PLAYWRIGHT_PORT` de `scripts/e2e-full.mjs` reciben el mismo tratamiento (aleatorizados, ver ese archivo). |

---

## Regresiones encontradas

**Ninguna regresión de comportamiento en `apps/web`.** El único "fallo" masivo observado (65/71 en
el primer intento de `test:e2e`) fue una colisión de puerto con un proceso externo al código bajo
prueba (ver W-23) — no una regresión del código de W-17/W-18/W-19: la repetición con el entorno
verificado (puerto libre antes de arrancar) dio 71/71 en verde de forma reproducible, dos veces
más, incluida la corrida en el clon `--no-local` completamente aislado.

## Comprobado correcto (adicional a lo confirmado en `web.md` y `web-reverificacion.md`)

- 49/49 pruebas unitarias y 71/71 E2E idénticas en `git worktree` (tras descartar la colisión de
  puerto) y en `git clone --no-local` verdaderamente independiente.
- Los 5 estados de fuente ("OK", "Caída", "CAPTCHA", "Cambio de interfaz", "Permisos faltantes")
  siguen presentes y verificados por Playwright real en `/convocatorias/fuentes-frescura`
  (`e2e/contraste.spec.ts`).
- `PaqueteDescargablePage` sigue derivando `ESTADO_ACTUAL` de `derivarEstadoPaquete({
  checklistCompleto: false, firmasCompletas: false, anexosVigentes: false })` → `"Borrador"` por
  defecto (nunca un literal hardcodeado), y sigue mostrando la tarjeta "La presentación y firma las
  realiza el usuario" con el texto completo del aviso.
- Sin datos ficticios (`grep` de patrones "lorem ipsum"/"acme corp"/"empresa de prueba"/etc. sin
  resultados) ni secretos (`grep` de `supabase.co`/`vercel.app`/patrones de API key sin resultados
  fuera de comentarios/documentación ya conocidos) en el código tocado por esta ronda ni en el
  resto de `apps/web/src`.
- `git ls-files | grep -x package-lock.json` confirma el lockfile versionado en el `HEAD` actual
  (post-avance concurrente del repo), y `npm ci` en clon limpio lo consume sin re-resolver el
  árbol (W-03 genuinamente cerrado, no solo "commiteado").

## Comandos ejecutados

Salida real completa en `docs/logs/reverify2-web.log`: ancestría (`git merge-base
--is-ancestor`), `git show --stat` de los 4 commits, `npm install`/`playwright install` en el
worktree, typecheck/lint/test/build, el primer intento de `test:e2e` (65 fallidas, con la traza de
`/calendario`), la repetición en verde (71/71) con monitoreo de `lsof -iTCP:4173` cada 2s, `npm
audit --workspace apps/web`, `npm ls vitest`, el grep de `vitest-axe/dist`, y todo el ciclo del
clon `--no-local` (`npm ci`, typecheck/lint/test/build/test:e2e, `npm audit`). El script de ataque
de accesibilidad/táctil (`attack-reverify2.mjs`) y su salida completa
(`reverify2-attack-results.json`) están en `docs/auditoria-1/capturas-reverificacion-2/`.
