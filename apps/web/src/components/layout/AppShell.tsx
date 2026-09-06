import { useState } from "react";
import { Outlet } from "react-router-dom";
import { Menu } from "lucide-react";

import { AtiendeWordmark } from "@/components/AtiendeLogo";
import { SkipLink } from "@/components/SkipLink";
import { ThemeSelector } from "@/components/ThemeSelector";
import { SidebarNav } from "@/components/layout/SidebarNav";
import { OrganizationSwitcher } from "@/components/layout/OrganizationSwitcher";
import { UserMenu } from "@/components/layout/UserMenu";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

/**
 * Layout raíz del back office. Responsive real (no desktop-only como el
 * origen, ver informe §4.1/§10.3): en md+ la sidebar es un panel fijo; por
 * debajo de md se convierte en un drawer (Sheet) accesible con botón
 * hamburguesa con foco gestionado por Radix Dialog.
 */
export function AppShell() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  return (
    <div className="flex min-h-screen flex-col bg-background md:flex-row md:gap-3 md:p-3">
      <SkipLink targetId="main-content">Saltar al contenido principal</SkipLink>

      <aside
        aria-label="Barra lateral"
        className="hidden w-60 shrink-0 flex-col rounded-2xl border border-border bg-card py-4 shadow-card md:flex"
      >
        <div className="px-4 pb-4">
          <AtiendeWordmark />
        </div>
        <SidebarNav className="flex-1 overflow-y-auto" />
      </aside>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        <SheetContent side="left" className="flex w-72 flex-col p-0">
          <SheetHeader className="px-4 pb-2 pt-5">
            <SheetTitle>
              <AtiendeWordmark markClassName="h-6 w-auto" />
              <span className="sr-only">Menú de navegación</span>
            </SheetTitle>
          </SheetHeader>
          {/* `overflow-y-auto` (como en la sidebar de escritorio, arriba): sin
              esto, un flex item con `flex-1` no se recorta por contenido —
              crece más allá de su caja (el drawer es `h-full`, altura fija)
              y empuja el footer de tema (debajo) fuera del viewport visible.
              Verificado con Playwright real: el radio "Tema oscuro" quedaba
              con `boundingBox().y` más allá de la altura de pantalla —
              "outside of the viewport" al intentar hacer click, aunque su
              `x` (lo único que medía la prueba anterior) sí estuviera
              dentro de rango. */}
          <SidebarNav onNavigate={() => setMobileNavOpen(false)} className="flex-1 overflow-y-auto pb-2" />
          {/*
           * W-21 (docs/auditoria-1/web-reverificacion-2.md): en el header,
           * `ThemeSelector` quedaba fuera del viewport e intocable en todo
           * ancho <466px porque `OrganizationSwitcher` no se encogía. En vez
           * de competir por el mismo espacio angosto del header en TODO el
           * rango <768px (md, el mismo rango en que este drawer reemplaza a
           * la sidebar), el selector de tema vive aquí, en el drawer —
           * siempre visible y con espacio de sobra, sin depender de que el
           * resto de controles del header se encojan lo suficiente.
           */}
          <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
            <span className="text-xs font-medium text-muted-foreground">Tema de la interfaz</span>
            <ThemeSelector />
          </div>
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <header
          role="banner"
          className="flex h-14 shrink-0 items-center justify-between gap-2 rounded-2xl border border-border bg-card px-3 shadow-card sm:px-4 md:h-12"
        >
          <div className="flex min-w-0 shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Abrir menú de navegación"
              aria-haspopup="dialog"
              // El tamaño "icon" por defecto es 40×40px, por debajo del
              // objetivo de ≥44×44px para targets táctiles (W-10).
              className="h-11 w-11 shrink-0 md:hidden"
              onClick={() => setMobileNavOpen(true)}
            >
              <Menu className="h-5 w-5" aria-hidden="true" />
            </Button>
            <span className="min-w-0 md:hidden">
              <AtiendeWordmark markClassName="h-6 w-auto" />
            </span>
          </div>
          {/* W-21: `min-w-0` es lo que permite que `OrganizationSwitcher`
              (ahora `flex-1` con `truncate` interno) pueda encogerse por
              debajo de su ancho de contenido en vez de forzar overflow del
              header — sin esto, el mínimo implícito de un hijo flex es el
              de su contenido, que es exactamente el bug que causó W-21. */}
          <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5 sm:gap-2">
            <OrganizationSwitcher />
            {/* ThemeSelector vive en el drawer para <md (ver arriba);
                aquí solo se muestra desde md en adelante, donde sí hay
                espacio real (sidebar fija, header sin hamburguesa/wordmark
                móvil compitiendo por el mismo ancho). */}
            <ThemeSelector className="hidden md:inline-flex" />
            <UserMenu />
          </div>
        </header>

        <main
          id="main-content"
          tabIndex={-1}
          // W-18: `focus:outline-none` sin ningún reemplazo dejaba el foco
          // (que sí llega aquí, W-09) sin ningún indicador visual — mismo
          // patrón de anillo de foco que ya usan las primitivas shadcn
          // (ver src/components/ui/button.tsx): outline nativo suprimido,
          // reemplazado por un `ring` (box-shadow) sí visible.
          className="flex-1 rounded-2xl border border-border bg-card p-4 shadow-card ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:p-6"
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
