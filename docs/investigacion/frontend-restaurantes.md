# Inventario frontend — atiende-restaurantes (para portar a atiende-licitaciones)

Fuente: `/Users/javiercamaraportepetit/Documents/Codex/atiende-restaurantes` (solo lectura).
No se copiaron `.env`, `.git`, `.vercel/`, `bun.lockb`/`package-lock.json` reales, ni ningún ID de
despliegue (Vercel/Supabase). Este documento es la base para reconstruir el mismo sistema de
diseño y arquitectura de frontend en el proyecto de licitaciones.

## 1. Stack exacto

- **Framework**: Vite 8.2.2 + React 18.3.1 + TypeScript 5.8.3. SPA pura (no Next.js): rutas con
  `react-router-dom` v7 (`BrowserRouter`, `basename` = `import.meta.env.BASE_URL`), sin app router
  de servidor.
- **Compilador React**: `@vitejs/plugin-react-swc` (SWC, no Babel). Plugin de dev extra:
  `lovable-tagger` (`componentTagger()`, solo en modo `development`; herencia de la plataforma
  Lovable, no imprescindible).
- **Gestor de paquetes**: el repo trae tanto `bun.lockb` como `package-lock.json` y `deno.lock`
  (Deno solo para las Edge Functions/tests, no para el frontend). El README documenta el flujo
  oficial con **npm**: `npm ci --ignore-scripts --no-audit --no-fund`.
- **TypeScript**: `strict: false`, `noImplicitAny: false`, `noUnusedLocals/Parameters: false` (repo
  permisivo a propósito). Alias `@/*` → `./src/*` (vía `tsconfig.json` + `vite.config.ts` +
  `components.json`). `tsconfig.app.json` con `target: ES2020`, `jsx: react-jsx`,
  `moduleResolution: bundler`.
- **Tailwind/CSS**: Tailwind CSS 3.4.17 + `tailwindcss-animate` + `@tailwindcss/typography`.
  PostCSS con `tailwindcss` + `autoprefixer`. CSS-in-file en `src/index.css` usando variables HSL
  (`hsl(var(--token))`) al estilo shadcn.
- **UI lib**: **shadcn/ui** (`components.json`, `style: default`, `baseColor: slate`,
  `cssVariables: true`, sin prefijo de clases) sobre primitivas **Radix UI** (accordion,
  alert-dialog, avatar, checkbox, dialog, dropdown-menu, popover, select, switch, tabs, toast,
  tooltip, etc. — ~28 paquetes `@radix-ui/react-*`).
- **Iconos**: `lucide-react` (`strokeWidth={1.75}` como convención del proyecto, íconos ~4-5 unidades
  de Tailwind).
- **Fuentes**: Google Fonts vía `@import` en `src/index.css` — **Inter** (400/500/600/700),
  **Inter Tight** (500/600/700), **IBM Plex Mono** (400/500). `index.html` hace
  `<link rel="preconnect">` a `fonts.googleapis.com`/`fonts.gstatic.com`. Mapeadas en
  `tailwind.config.ts` como `font-display` (Inter Tight), `font-body`/`font-menu` (Inter),
  `font-mono` (IBM Plex Mono). Comentario explícito: "mismo trío tipográfico que la consola de
  Likida — solo cambiaron los tokens de color, no el sistema tipográfico".
- **Testing**: sin Vitest/Jest para el frontend. Tests reales son de backend: Deno
  (`deno test --allow-env supabase/functions/_shared/*.test.ts`) y SQL/pgTAP
  (`supabase/tests/run-local.sh`, corrido con `npm run test:db`). **No hay Storybook ni
  Playwright** en el repo.
- **Lint**: ESLint 9 flat config (`eslint.config.js`) con `typescript-eslint`,
  `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`. `no-unused-vars` apagado,
  `no-explicit-any` en `warn` (deuda visible, no bloqueante).
- **Scripts clave** (`package.json`):
  - `dev`, `build`, `build:dev` (modo development), `preview`
  - `build:budget` → build + `scripts/check-bundle-budget.mjs` (presupuesto de tamaño de chunks)
  - `lint`, `typecheck` (`tsc --noEmit`)
  - `test` = `test:edge` (Deno), `check:edge` (`deno check` de las Edge Functions), `test:db`
  - `quality` = lint + typecheck + test:edge + check:edge + build:budget (mismo flujo que
    `.github/workflows/quality.yml`)
  - `qa:voice-widget` (script de consola ad hoc para el widget de voz)
- **Otras libs relevantes**: `@tanstack/react-query` v5, `react-hook-form` + `@hookform/resolvers`
  + `zod`, `date-fns` (+ locale `es`), `recharts` (gráficas), `leaflet` (mapas), `framer-motion`,
  `sonner` (toasts), `jspdf` + `jspdf-autotable` (export PDF), `xlsx` (SheetJS, export Excel),
  `embla-carousel-react`, `cmdk`, `next-themes` (declarado pero el tema real lo maneja
  `ThemeSelector.tsx` a mano, ver §3), `@supabase/supabase-js`, `@elevenlabs/client` (voz, no
  aplica a licitaciones).
- **Build**: `vite.config.ts` fija `base: "/restaurantes/"` (subruta de despliegue) y usa
  `manualChunks` para separar `spreadsheet` (xlsx), `charts` (recharts/d3), `maps` (leaflet),
  chunks de voz LiveKit/ElevenLabs, `motion` (framer-motion), y `app-platform`
  (`@supabase` + `@radix-ui`). Para licitaciones, replicar el patrón pero sin las libs de voz y
  con `base` propio (p.ej. `/licitaciones/`).

## 2. Sistema de diseño

### 2.1 Paleta (tokens HSL, `src/index.css`, formato shadcn `--variable: H S% L%`)

Comentario explícito en el CSS: *"Color system: white / blue / sky-blue. Adapted from Likida's
(proyect-x-) documented design discipline [...] repointed from their black/white/gray console
palette to this product's blue/sky-blue."* Es decir: la disciplina de diseño (un solo acento
"con gotero", cada estado lleva etiqueta y no solo color, separadores punteados) viene de un
sistema de diseño hermano ("Likida"/"proyect-x-"), y solo cambia el hue.

Modo claro (`:root`):
| Token | HSL | Hex aprox. | Uso |
|---|---|---|---|
| `--background` | `210 40% 98%` | `#f7f9fc` | fondo de app |
| `--foreground` | `216 50% 12%` | `#0f1b2d` | texto principal |
| `--card` / `--popover` | `0 0% 100%` | `#ffffff` | superficies |
| `--primary` / `--secondary` / `--accent` | `224 76% 48%` | `#1d4ed8` (azul) | acento único |
| `--muted` | `210 30% 95%` | ~`#eef2f7` | fondos secundarios |
| `--muted-foreground` | `215 18% 43%` | `#5b6b82` | texto secundario |
| `--destructive` | `352 83% 41%` | `#c0122a` | errores/peligro |
| `--border` / `--input` | `214 32% 91%` | `#e2e8f0` | líneas |
| `--ring` | `224 76% 48%` | `#1d4ed8` | focus ring |
| `--gold` (alias legado) | `199 89% 48%` | `#0ea5e9` (celeste) | acento secundario |
| `--terracotta` / `--terracotta-light` | `224 76% 48%` / `199 89% 48%` | azul/celeste | alias legado (viene de una paleta terracota/oro original) |
| `--sand` / `--cream` | `210 30% 95%` / `210 40% 98%` | grises muy claros | alias legado |
| `--olive` | `224 76% 48%` | azul | alias legado |
| `--radius` | `0.75rem` | — | radio base |

Modo oscuro (`.dark`): fondo `216 45% 9%` (~`#0c1420`), card `216 40% 13%`, primary
`213 82% 62%` (azul más claro), accent/secondary `199 89% 55%` (celeste), destructive
`352 75% 55%`, border `216 30% 20%`. **No define** overrides de `--gold/--terracotta/--sand/...`
en `.dark` (quedan con el valor de `:root`).

Sidebar tiene su propio set de tokens (`--sidebar-background`, `--sidebar-foreground`,
`--sidebar-primary`, `--sidebar-accent`, `--sidebar-border`, `--sidebar-ring`) — todos derivados
de los mismos valores base en modo claro; **no hay overrides de sidebar para `.dark`** (bug/gap
existente a evitar al portar: definir también los tokens `--sidebar-*` en `.dark`).

Gradientes: `--gradient-hero`, `--gradient-gold`, `--gradient-warm` (azul→celeste). Sombras:
`--shadow-card` (`0 4px 24px -4px hsl(216 50% 12% / 0.08)`), `--shadow-elevated`,
`--shadow-glow` (glow azul `hsl(224 76% 48% / 0.2)`).

Mapeo Tailwind (`tailwind.config.ts`): todos los colores están declarados como
`hsl(var(--token))` (permite cambiar tema sin recompilar Tailwind), `borderRadius.lg/md/sm`
derivan de `--radius`, `boxShadow.card/elevated/glow` mapean a los tokens de sombra.

### 2.2 Tipografía

- Familias: `Inter Tight` (display/headings vía `font-display`), `Inter` (body/menu), `IBM Plex
  Mono` (cifras, etiquetas mayúsculas de sección, timestamps de tooltips).
- Carga: `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Inter+Tight:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap')`
  al tope de `src/index.css`, más `<link rel="preconnect">` en `index.html`.
- Convención visual: mayúsculas + `tracking-[0.08em]` + `font-mono text-[10px]` para encabezados
  de sección del sidebar (p. ej. "ANÁLISIS", "INICIO"); cifras grandes con `tabular-nums` y
  `font-display`.

### 2.3 Radios, sombras, espaciado, dark mode

- Radio base `0.75rem` (12px); botones son **pill** (`rounded-full`, ver §4 Button).
- Sombras con tokens semánticos (`shadow-card`, `shadow-elevated`, `shadow-glow`), no solo
  utilidades genéricas de Tailwind.
- Layout admin: panel flotante con `md:gap-3 md:p-3`, sidebar y contenido en tarjetas separadas
  con `rounded-2xl border border-border`, no un layout de ancho completo sin bordes.
- Dark mode: clase `.dark` en `<html>` (estrategia `darkMode: ["class"]` en Tailwind), gestionada
  a mano por `ThemeSelector.tsx` (no usa la librería `next-themes` que está en dependencies pero
  no se usa realmente) — guarda preferencia `claro/sistema/oscuro` en `localStorage` bajo la
  clave `atiende-tema`, escucha `prefers-color-scheme` solo si el usuario eligió "sistema".
- Movimiento: `prefers-reduced-motion` respetado explícitamente (ej. `.atiende-respira`,
  `.atiende-glifo-animado`, feedback de press en botones) — todas las animaciones "decorativas"
  están gateadas con `@media (prefers-reduced-motion: no-preference)` o tienen fallback en
  `reduce`.

## 3. Logo Atiende

No existe un archivo `.svg`/`.png` de logo "maestro" en `public/` más allá del favicon; el logo
vive como **componente React** que genera el SVG inline.

- **Favicon**: `public/favicon.svg` (referenciado en `index.html` como
  `<link rel="icon" href="/favicon.svg" type="image/svg+xml" />`). Contenido completo:

```svg
<svg viewBox="0 0 40 32" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="4" width="13" height="4" rx="2" fill="#7DD3FC" />
  <rect x="4" y="12" width="13" height="4" rx="2" fill="#7DD3FC" />
  <rect x="0" y="20" width="13" height="4" rx="2" fill="#7DD3FC" />
  <circle cx="26" cy="6" r="5" fill="#38BDF8" />
  <path
    d="M14 32 L20 20 Q22 16 27 16 L31 16 Q34 16 36 13 L38 10"
    stroke="#1D4ED8"
    stroke-width="7"
    stroke-linecap="round"
    stroke-linejoin="round"
    fill="none"
  />
</svg>
```

- **Componente del logo/wordmark**: `src/components/AtiendeLogo.tsx` (mismo glifo que el
  favicon, más una versión "animada" y el wordmark con texto "atiende"). El propio comentario en
  el código dice: *"Recreación vectorial del logo real [...] No tengo el archivo original — esto
  es una reconstrucción fiel al mismo mark, no el asset."* — es decir, en el propio proyecto
  fuente el logo ya es una reconstrucción, no un asset oficial.

```tsx
export function AtiendeMark({ className = "h-7 w-auto", animado = false }: { className?: string; animado?: boolean }) {
  return (
    <svg viewBox="0 0 40 32" className={`${className} ${animado ? "atiende-glifo-animado" : ""}`} fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect className="atiende-linea atiende-linea-1" x="0" y="4" width="13" height="4" rx="2" fill="#7DD3FC" />
      <rect className="atiende-linea atiende-linea-2" x="4" y="12" width="13" height="4" rx="2" fill="#7DD3FC" />
      <rect className="atiende-linea atiende-linea-3" x="0" y="20" width="13" height="4" rx="2" fill="#7DD3FC" />
      <circle cx="26" cy="6" r="5" fill="#38BDF8" />
      <path
        d="M14 32 L20 20 Q22 16 27 16 L31 16 Q34 16 36 13 L38 10"
        stroke="#1D4ED8"
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

export function AtiendeWordmark({ className = "", markClassName = "", animado = false }: { className?: string; markClassName?: string; animado?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <AtiendeMark className={markClassName || "h-7 w-auto"} animado={animado} />
      <span className="font-display text-2xl font-bold tracking-tight" style={{ color: "#1D4ED8" }}>
        atiende
      </span>
    </span>
  );
}
```

Anatomía: 3 barras redondeadas ("líneas de movimiento", celeste `#7DD3FC`) + un círculo
("cabeza", azul cielo `#38BDF8`) + un trazo grueso en forma de figura corriendo (azul fuerte
`#1D4ED8`, `stroke-width 7`, `viewBox 0 0 40 32`). Animación opcional `atiende-glifo-animado`
(cada `rect.atiende-linea-N` corre con `animation-delay` escalonado, definida en `src/index.css`
como `@keyframes atiende-linea-correr`). Efecto de "loading que respira" (`.atiende-respira`)
también en `src/index.css`, usado en pantallas de carga junto con `<AtiendeMark>`.

**Recomendación para licitaciones**: reusar el mismo componente (mismo mark = misma marca
"atiende") pero puede valer la pena introducir un color de acento propio de licitaciones para
diferenciarlo visualmente del vertical de restaurantes en el `AdminSidebar`, sin tocar el glifo.

- **Otros assets visuales en `public/`** (no logo, no se copian binarios pero se documenta su
  existencia para saber qué reemplazar): `public/images/login-hero.png` (imagen de fondo del
  login), `public/media/orbe-agente.mp4` (video del "orbe" del agente de voz, no aplica a
  licitaciones), `public/placeholder.svg` (placeholder shadcn genérico), `public/robots.txt`
  (con `noindex` porque es panel privado, no landing pública — mismo criterio aplicaría a
  licitaciones).

## 4. Estructura de carpetas y patrón de layout

```
src/
  App.tsx                  # Router raíz, lazy routes, error boundary, loading screen
  main.tsx                 # entry point
  index.css                # tokens de diseño, fuentes, keyframes globales
  components/
    AtiendeLogo.tsx         # mark + wordmark (§3)
    CampoPixeles.tsx         # canvas animado de fondo ("Pregunta a tus datos")
    Modal*.tsx                # modales de dominio (Categoria, ClonarVoz, Cuenta, Producto, Repartidor, FormularioElegante/Lateral)
    ThemeSelector.tsx         # selector claro/sistema/oscuro
    WidgetWhatsApp.tsx        # widget flotante de chat
    admin/
      AdminSidebar.tsx        # sidebar principal (ver detalle abajo)
      *Section.tsx             # una sección por pestaña del panel (Clientes, Historial, Notificaciones, PedidoDetalle, Pedidos, Sucursales, WhatsAppAgenteConfig)
      SelectorIdiomasAgente.tsx
      ui/StatCard.tsx          # tarjetas KPI (2 variantes, ver §5)
    repartidor/RepartidorSidebar.tsx
    ui/                       # ~45 primitivas shadcn/ui (button, card, table, dialog, sidebar, sheet, toast, sonner, tabs, form, calendar, chart, command, breadcrumb, pagination, etc.)
  hooks/
    use-mobile.tsx            # useIsMobile() (breakpoint 768px)
    use-toast.ts / useIsAdmin.ts / useUserRole.ts
  integrations/supabase/
    client.ts                 # createClient() con storage propio, flujo implícito
    previewAuthStorage.ts      # storage "brokered" para preview envs
    types.ts                   # tipos generados de la DB
  lib/utils.ts                # cn() (clsx + tailwind-merge)
  pages/
    AdminDashboard.tsx         # panel admin (archivo grande, orquesta todas las *Section)
    AdminLogin.tsx / login.css
    SuperAdminDashboard.tsx
    RepartidorDashboard.tsx / RepartidorAdminPanel.tsx
    NotFound.tsx
    Terminos.tsx / Privacidad.tsx / legal/LegalPage.tsx
```

No hay carpetas `app/` ni `pages/` de framework (no es Next.js) — es un router declarativo en
`App.tsx` con `React.lazy` por página y un `Suspense` + `LoadingScreen` global, más un
`RouteErrorBoundary` de clase que atrapa fallos de import dinámico (con recuperación
"reintenta una vez recargando, si persiste ofrece limpiar caché").

### 4.1 Sidebar (`AdminSidebar.tsx`)

- Estructura por **secciones agrupadas** (`menuSections`: título + `items[]`), cada item con
  `id`, `label`, `icon` (componente lucide) y opcionalmente `disabled: true` (se muestra con
  etiqueta "Pronto" en vez de ocultarse — comentario explícito: *"items sin página real detrás
  van disabled con etiqueta 'Pronto', no fingen funcionar"*). Comentario del propio código dice
  que la anatomía está calcada del panel de restaurantes de Rappi
  (INICIO/MARKETING/ADMINISTRAR/SOPORTE).
- Grupos actuales: **ANÁLISIS** (siempre abierto: Estadísticas, Pregunta a tus datos),
  **INICIO** (Notificaciones, Pedidos, Historial de Órdenes, Pagos [disabled]), **AGENTES**
  (Agente de voz, Agente de WhatsApp), **MARKETING** (Promociones), **ADMINISTRAR** (Productos,
  Categorías, Clientes, Repartidores, Sucursales, Cuentas & Accesos).
- Comportamiento: acordeón de un solo grupo abierto a la vez (excepto ANÁLISIS, siempre visible),
  persistido en `localStorage` (`atiende-sidebar-grupo-abierto`); colapsable a solo-íconos
  (`w-16` vs `w-60`) con botón `PanelLeftClose/Open`; bloque de cuenta al fondo (Centro de ayuda,
  Mi perfil, Plan y facturación, Configuración, selector de tema) y chip de usuario con avatar
  (inicial del email) + botón de logout.
- **Móvil**: la sidebar de escritorio es `hidden md:flex` — en móvil **no hay drawer de
  navegación**, solo un `<header className="md:hidden">` compacto (logo + botón de logout) en
  `AdminDashboard.tsx`; el contenido principal (`hidden md:flex ...`) tampoco se muestra en
  móvil en este panel — es decir, **el admin dashboard hoy está optimizado solo para
  desktop/tablet ancho ≥768px**, con un placeholder de header en móvil. Esto es un gap conocido a
  decidir explícitamente al portar (¿licitaciones necesita panel operable en móvil, o se acepta
  la misma limitación desktop-first?). `RepartidorDashboard`/`RepartidorAdminPanel` sí parecen
  tener vistas responsivas propias (repartidores trabajan desde el celular).
- `RepartidorSidebar.tsx` sigue el mismo patrón (grupos RESUMEN/ENTREGAS/CUENTA, colapsable,
  badges numéricos rojos en items con contador).
- Breakpoint móvil oficial: `MOBILE_BREAKPOINT = 768` en `src/hooks/use-mobile.tsx`
  (`useIsMobile()`), aunque en la práctica el layout usa clases Tailwind `md:` directamente más
  que ese hook.

### 4.2 Header / navegación de contenido

Dentro del panel principal (`hidden md:flex ... rounded-2xl border bg-card`), un header interno
de `h-12` muestra el título + ícono de la sección activa (switch por `activeSection`, no rutas
anidadas — la navegación es por estado local `activeSection`/`onSectionChange`, no por
subrutas de React Router). Sin breadcrumbs reales en el admin (el componente
`ui/breadcrumb.tsx` existe como primitiva shadcn pero no se usa en el dashboard). Cuando un
superadmin está "viendo como" un tenant, aparece una barra contextual propia con botón
"← Volver a superadmin".

## 5. Componentes reutilizables clave

| Componente | Ruta | Resumen de props/uso |
|---|---|---|
| `Button` | `src/components/ui/button.tsx` | CVA con variants `default/destructive/outline/secondary/ghost/link/hero/terracotta/gold`, sizes `default/sm/lg/xl/icon`. **Pill** (`rounded-full`) en todas las variantes/tamaños; `asChild` via Radix `Slot`. Feedback de press (`:active{scale(.97)}`) global en `index.css`, no en el componente. |
| `Card` / `CardHeader` / `CardTitle` / `CardDescription` / `CardContent` / `CardFooter` | `ui/card.tsx` | Composición estándar shadcn, `rounded-lg border bg-card shadow-sm`. |
| `Table`/`TableHeader`/`TableBody`/`TableRow`/`TableHead`/`TableCell`/`TableFooter` | `ui/table.tsx` | Wrapper `overflow-auto`, hover en filas, soporte `data-[state=selected]`. |
| `Dialog` (+ Overlay/Content/Header/Title/Trigger) | `ui/dialog.tsx` | Radix Dialog estándar, centrado, `hideDefaultClose` opcional. Modales de dominio (`ModalProducto`, `ModalCategoria`, `ModalRepartidor`, `ModalCuenta`, `ModalClonarVoz`) se construyen sobre esta primitiva o sobre `ModalFormularioElegante`/`ModalFormularioLateral` (panel lateral tipo drawer para formularios largos). |
| `Toast`/`Toaster` (Radix) | `ui/toast.tsx`, `ui/toaster.tsx`, `hooks/use-toast.ts` | Toast "de radix" con estilo custom (`rounded-2xl`, blur, swipe-to-dismiss) — **es el único punto compartido detrás de cada `toast()`**, según comentario del propio código. |
| `Sonner` (segundo sistema de toast) | `ui/sonner.tsx` | Wrapper de `sonner` con tema forzado oscuro y paleta `terracotta` (nombre legado); **conviven dos sistemas de toast** (Radix Toast + Sonner) — al portar, decidir uno solo o mantener ambos a propósito. |
| `Badge` | `ui/badge.tsx` | CVA `default/secondary/destructive/outline`, pill pequeño. |
| `Skeleton` | `ui/skeleton.tsx` | `animate-pulse rounded-md bg-muted`, un solo primitivo genérico (no hay skeletons "de dominio" prearmados, se componen ad hoc donde se usan). |
| `Alert`/`AlertTitle`/`AlertDescription` | `ui/alert.tsx` | variants `default/destructive`. |
| Estados vacíos | *(no hay componente dedicado)* | Patrón: `<p className="text-[13px] text-muted-foreground">No hay ...</p>` inline en cada sección (`PedidosSection`, `HistorialOrdenesSection`, `NotificacionesSection` usa prop `textoVacio` en un subcomponente compartido, `SucursalesSection`, `RepartidorDashboard`). Recomendación al portar: extraer un `<EmptyState icono label />` reutilizable ya que el patrón se repite ~15 veces. |
| `StatCard` / `TrendStatCard` | `src/components/admin/ui/StatCard.tsx` | `StatCard({icon, label, value, nota?, verMas?})`: KPI compacto con chip de ícono sólido y nota bajo hairline punteado. `TrendStatCard({icon, label, value, deltaPct?, deltaLabel?, onVerMas?})`: KPI con badge de variación verde/rojo vs. periodo anterior. Ambos explícitamente documentados como "anatomía exacta/segunda anatomía de Likida". |
| `Form`, `Input`, `Label`, `Textarea`, `Select`, `Checkbox`, `Switch`, `RadioGroup` | `ui/*.tsx` | `react-hook-form` + `zod` vía `@hookform/resolvers`; `Form` es el wrapper shadcn estándar (`FormField`/`FormItem`/`FormMessage`, etc. — no confirmado en detalle pero presente). |
| `Sidebar` (primitiva genérica shadcn) | `ui/sidebar.tsx` | Existe la primitiva shadcn "sidebar" completa (context, provider, trigger) pero **no se usa**: `AdminSidebar`/`RepartidorSidebar` son implementaciones a mano, más simples, con su propio `useState` de colapso. |
| `ThemeSelector` | `src/components/ThemeSelector.tsx` | `role="radiogroup"` con 3 botones `role="radio"` (claro/sistema/oscuro), accesible con `aria-checked`/`aria-label`. |
| `Breadcrumb` (primitiva) | `ui/breadcrumb.tsx` | Disponible (`nav aria-label="breadcrumb"`), sin uso activo en el dashboard actual. |
| `AnimatedTabs`, `Chart` (recharts wrapper), `Command`/`cmdk`, `Carousel`, `Calendar` (react-day-picker), `Drawer` (vaul), `Resizable` (react-resizable-panels) | `ui/*.tsx` | Disponibles como parte del set shadcn instalado; usados selectivamente (p. ej. `Calendar`+`Popover` para rango de fechas en `AdminDashboard`, `recharts` para gráficas de ventas). |

## 6. Auth / cliente de datos (patrón, sin secretos)

- **Backend**: Supabase (Postgres + RLS + Edge Functions Deno). Cliente en
  `src/integrations/supabase/client.ts`:
  ```ts
  export const supabase = createClient<Database>(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: {
      storage: brokeredPreviewStorage(),
      persistSession: true,
      autoRefreshToken: true,
      flowType: 'implicit', // decisión explícita, no PKCE — ver comentario en el archivo
    }
  });
  ```
  `SUPABASE_URL`/`SUPABASE_PUBLISHABLE_KEY` vienen de `import.meta.env.VITE_SUPABASE_URL` /
  `VITE_SUPABASE_PUBLISHABLE_KEY` (no se leyó ni copió el `.env` real). `types.ts` son tipos
  generados de la base (`Database` type) — patrón a replicar generando tipos propios para el
  esquema de licitaciones.
- **`previewAuthStorage.ts`**: storage de sesión "brokered" para entornos preview (Vercel preview
  deployments comparten dominio pero no deberían compartir sesión) — patrón interesante a portar
  si licitaciones también usa preview deployments por PR.
- **Roles**: tabla `user_roles` (`admin`/`user`/`repartidor`/`superadmin`) consultada directo con
  `supabase.from('user_roles').select('role').eq('user_id', ...)`. Dos hooks redundantes:
  `useIsAdmin()` (booleano simple, suscrito a `onAuthStateChange`) y `useUserRole(user)` (devuelve
  array de roles + flags `isAdmin/isRepartidor/isUser`). Al portar a licitaciones, conviene
  unificar en un solo hook de roles (p. ej. `admin`/`analista`/`revisor`/`superadmin`).
- **Login**: `AdminLogin.tsx` usa **magic link** de Supabase (email, sin password) con flujo
  implícito (`#access_token=` en el hash, consumido a mano) — sin OAuth de terceros visible en
  este archivo. Maneja explícitamente el caso de "enlace ya no sirve" (link escaneado/caducado)
  leyendo `error_description` del hash.
- **Fetch de datos en componentes**: patrón directo `supabase.from(tabla).select(...)` +
  `useState`/`useEffect` dentro de cada `*Section.tsx` (no se usa `react-query` de forma
  consistente pese a estar instalado — es una oportunidad de mejora a considerar en
  licitaciones: estandarizar en `@tanstack/react-query` desde el inicio en vez de fetch manual).

## 7. Cómo se ejecuta y se testea

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run dev          # vite dev server, puerto 8080, host "::"
npm run build         # vite build (usa manualChunks de vite.config.ts)
npm run quality        # lint + typecheck + test:edge + check:edge + build:budget
supabase start
supabase db reset --local --no-seed
npm run test:db
```

- CI: `.github/workflows/quality.yml` corre dos jobs — `application` (npm ci, `npm audit
  --omit=dev --audit-level=high`, `npm run quality`) y `database` (Supabase CLI local +
  `supabase db reset` + `supabase/tests/run-local.sh`).
- **No hay Storybook ni Playwright** en este repo — sin catálogo visual de componentes ni tests
  E2E de UI. Si licitaciones los necesita, habría que introducirlos de cero (no hay nada que
  portar de aquí).
- `scripts/check-bundle-budget.mjs` impone un presupuesto de tamaño de bundle tras el build
  (relevante si licitaciones también carga librerías pesadas como mapas/gráficas/export).

## 8. Accesibilidad y móvil

- `aria-*` usado de forma puntual (49 ocurrencias en 18 archivos), no sistemático: `role="alert"`
  en el error boundary, `role="status"`/`aria-label="Cargando"` en pantallas de carga,
  `role="radiogroup"`/`role="radio"`/`aria-checked` en `ThemeSelector`, `aria-label="breadcrumb"`
  en la primitiva de breadcrumb (no usada), atributos en `form.tsx`, `navigation-menu.tsx`,
  `pagination.tsx`, `carousel.tsx`, `calendar.tsx` (heredados de Radix/shadcn, no custom).
- `prefers-reduced-motion` respetado de forma consistente en toda animación decorativa
  (`index.css`), incluyendo el glifo del logo animado.
- Foco: se apoya en los `focus-visible:ring-2 focus-visible:ring-ring` que trae shadcn/Radix por
  defecto en `button`/`badge`; no se detectó gestión de foco custom (trampas de foco) más allá de
  lo que Radix Dialog/Popover ya maneja internamente.
- Móvil: breakpoint 768px (`md:`). El **panel admin de escritorio no tiene versión móvil
  funcional** (ver §4.1) — solo un header reducido; en cambio **login**, **repartidor** y las
  páginas legales sí parecen responsivas. Es una decisión explícita a tomar para licitaciones:
  ¿el "back office" también será desktop-only, o se necesita que analistas revisen desde
  tablet/móvil?

## 9. Otros documentos relevantes en el repo fuente

- `README.md` — visión de producto, stack, flujo de desarrollo/QA (resumido arriba).
- `docs/agente-voz/system-prompt.md`, `docs/agente-voz/whatsapp-setup.md` — no aplican a
  licitaciones (dominio de voz/WhatsApp de restaurantes).
- `docs/runbooks/operacion.md` — runbook de incidentes/integraciones (patrón de documentación a
  imitar para licitaciones: un runbook de operación propio).
- `docs/audits/*.md` — auditorías de "enterprise remediation"/"demo readiness" (formato de
  auditoría reproducible a imitar si licitaciones también documenta auditorías).
- **No existe `CLAUDE.md`** en el repo fuente.
- `components.json` (config de shadcn) y `tailwind.config.ts` son, en sí mismos, la
  documentación operativa del sistema de diseño — no hay un doc de diseño narrativo aparte del
  copy en comentarios de `index.css`/`AdminSidebar.tsx`/`StatCard.tsx`.

## 10. Plan de adaptación a licitaciones

### 10.1 Mapa de sidebar: Restaurantes → Licitaciones

Mismo mecanismo (`menuSections`: título + items con `id/label/icon`, acordeón de un grupo
abierto, colapsable, `disabled` con "Pronto" para lo que aún no exista):

| Grupo original (restaurantes) | Grupo propuesto (licitaciones) | Items propuestos | Ícono lucide sugerido |
|---|---|---|---|
| ANÁLISIS (Estadísticas, Pregunta a tus datos) | **ANÁLISIS** | Estadísticas, Pregunta a tus datos | `BarChart3`, `MessageCircle` |
| INICIO (Notificaciones, Pedidos, Historial, Pagos) | **CONVOCATORIAS** | Convocatorias (bandeja de nuevas licitaciones), Matching (relevancia auto), Notificaciones | `LayoutDashboard` / `Radar`, `Sparkles`/`Target`, `Bell` |
| — (nuevo) | **EVALUACIÓN** | Go/No-Go, Análisis de bases (checklist de requisitos) | `Scale`/`GitBranch`, `FileSearch` |
| — (nuevo) | **PREPARACIÓN** | Documentación (acopio de anexos/certificados), Redacción (propuesta técnica/económica), Revisión (control de calidad antes de entrega) | `FolderOpen`, `PenLine`, `ClipboardCheck` |
| — (nuevo) | **ENTREGA Y SEGUIMIENTO** | Entregas (registro de envíos/plataformas), Seguimiento (estado post-entrega, adjudicación, recursos) | `Send`, `Clock`/`Timer` |
| ADMINISTRAR (Productos, Categorías, Clientes, Repartidores, Sucursales, Cuentas & Accesos) | **BACK OFFICE** | Clientes/Cuentas de licitante, Plantillas, Catálogo de servicios/capacidades propias, Cuentas & Accesos | `Contact`, `FileStack`, `Package`, `Lock` |
| — (nuevo) | **CONFIGURACIÓN** | Fuentes de convocatorias, Reglas de matching, Notificaciones, Integraciones | `Settings`, `Plug` |
| AGENTES (Agente de voz, Agente de WhatsApp) | *(fuera de alcance salvo que licitaciones también use agentes conversacionales — omitir o adaptar solo si aplica)* | — | — |
| MARKETING (Promociones) | *(no aplica a licitaciones — omitir grupo)* | — | — |

Nota: los 10 conceptos pedidos (Convocatorias, Matching, Go/No-Go, Análisis de bases,
Documentación, Redacción, Revisión, Entregas, Seguimiento, Back office, Configuración) se
agrupan arriba en 5 grupos siguiendo el mismo criterio de agrupamiento por etapa del flujo que
usa el original (en vez de una lista plana de 11 items sueltos), pero cada uno puede also
implementarse como grupo propio de 1 item si se prefiere una jerarquía más plana — la mecánica
de `AdminSidebar.tsx` soporta ambas formas sin cambios estructurales.

### 10.2 Archivos a reproducir (origen → destino propuesto)

Base del destino propuesta: `src/` en la raíz del nuevo repo Vite (mismo layout que el origen).

| Origen (`atiende-restaurantes`) | Destino propuesto (`atiende-licitaciones-staging`) | Notas |
|---|---|---|
| `package.json` (scripts, deps de UI/tooling — sin las libs de voz/WhatsApp/leaflet si no aplican) | `package.json` | Quitar `@elevenlabs/client`, `leaflet`, `@types/leaflet`; mantener el resto del set shadcn/Radix/react-query/react-hook-form/zod/recharts/jspdf/xlsx si licitaciones también exporta reportes. |
| `tailwind.config.ts` | `tailwind.config.ts` | Mismo esquema de tokens; cambiar solo los valores de color si se define un acento propio para licitaciones. |
| `postcss.config.js`, `eslint.config.js`, `tsconfig*.json`, `components.json`, `vite.config.ts` | mismos nombres | Ajustar `base` en `vite.config.ts` (p. ej. `/licitaciones/`) y `manualChunks` según libs realmente usadas. |
| `src/index.css` | `src/index.css` | Portar tokens HSL, imports de fuentes, keyframes de logo/loading; decidir si se mantiene el mismo azul o un acento distintivo para licitaciones. |
| `public/favicon.svg` | `public/favicon.svg` | Mismo glifo (mark de marca "atiende"); opcionalmente recolorear el acento si licitaciones usa un tono distinto. |
| `src/components/AtiendeLogo.tsx` | `src/components/AtiendeLogo.tsx` | Copiar tal cual (mismo mark/wordmark); es una reconstrucción, no un asset con licencia especial. |
| `src/components/ui/*.tsx` (todo el set shadcn instalado) | `src/components/ui/*.tsx` | Copiar el set completo vía `npx shadcn add` o copia directa de los ~45 archivos; son genéricos, no específicos de restaurantes. |
| `src/components/admin/AdminSidebar.tsx` | `src/components/admin/AdminSidebar.tsx` | Reescribir `menuSections` con el mapa de §10.1; conservar mecánica de acordeón/colapso/localStorage. |
| `src/components/admin/ui/StatCard.tsx` | `src/components/admin/ui/StatCard.tsx` | Copiar tal cual (genérico). |
| `src/hooks/use-mobile.tsx`, `use-toast.ts` | mismos | Genéricos, copiar tal cual. |
| `src/hooks/useIsAdmin.ts`, `useUserRole.ts` | `src/hooks/useUserRole.ts` (unificar en uno) | Adaptar roles a los de licitaciones (p. ej. `admin`/`analista`/`revisor`/`superadmin`). |
| `src/integrations/supabase/client.ts`, `previewAuthStorage.ts`, `types.ts` | mismos | Mismo patrón de cliente; `types.ts` se regenera del esquema propio de licitaciones (nunca copiar el de restaurantes). |
| `src/lib/utils.ts` | `src/lib/utils.ts` | Copiar tal cual (`cn()`). |
| `src/App.tsx` | `src/App.tsx` | Mismo patrón de lazy routes + error boundary + loading screen; reemplazar rutas por las de licitaciones (`/admin`, `/admin/login`, secciones del sidebar si se usan subrutas en vez de estado local). |
| `src/pages/AdminLogin.tsx`, `login.css` | mismos | Mismo flujo de magic link; cambiar copy/branding de producto. |
| `src/pages/NotFound.tsx`, `Terminos.tsx`, `Privacidad.tsx`, `legal/LegalPage.tsx` | mismos | Genéricos, adaptar copy legal. |
| `src/pages/AdminDashboard.tsx` (patrón de layout, no el contenido de negocio de restaurantes) | `src/pages/AdminDashboard.tsx` | Reproducir la **estructura** (sidebar + header interno + tarjetas KPI + panel único redondeado), no las `*Section.tsx` de dominio (pedidos/productos no aplican). |
| — (sin equivalente directo) | `src/components/admin/*Section.tsx` nuevas | Crear secciones nuevas por cada item del sidebar de §10.1 (ConvocatoriasSection, MatchingSection, GoNoGoSection, AnalisisBasesSection, DocumentacionSection, RedaccionSection, RevisionSection, EntregasSection, SeguimientoSection), siguiendo el mismo patrón de un componente por pestaña que recibe/gestiona su propio fetch a Supabase. |
| Patrón de estados vacíos disperso | `src/components/ui/empty-state.tsx` (nuevo) | Extraer el patrón repetido "`<Icono/> No hay ...`" en un componente reutilizable desde el día uno, en vez de replicarlo disperso como en el origen. |

### 10.3 Decisiones abiertas a resolver antes de portar

1. **Responsive del back office**: el original es desktop-only en el admin — decidir si
   licitaciones necesita uso real en tablet/móvil (analistas revisando bases fuera de oficina) y,
   de ser así, diseñar el drawer móvil que el original no tiene.
2. **Dos sistemas de toast** (Radix Toast + Sonner): elegir uno solo para licitaciones o
   mantener ambos con un criterio explícito (el original no documenta por qué coexisten).
3. **`react-query` vs. fetch manual**: el original tiene `@tanstack/react-query` instalado pero
   casi no lo usa; para licitaciones conviene adoptarlo desde el inicio para cache/reintentos de
   las listas de convocatorias.
4. **Paleta**: decidir si licitaciones hereda el azul/celeste tal cual (consistencia de marca
   "atiende") o adopta un acento propio para diferenciar verticales a simple vista en la barra
   de pestañas del navegador/favicon.
