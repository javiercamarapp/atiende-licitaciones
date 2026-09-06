import { useState } from "react";
import { Outlet } from "react-router-dom";
import { Menu } from "lucide-react";

import { AtiendeWordmark } from "@/components/AtiendeLogo";
import { SkipLink } from "@/components/SkipLink";
import { ThemeSelector } from "@/components/ThemeSelector";
import { SidebarNav } from "@/components/layout/SidebarNav";
import { OrganizationSwitcher } from "@/components/layout/OrganizationSwitcher";
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
        <SheetContent side="left" className="w-72 p-0">
          <SheetHeader className="px-4 pb-2 pt-5">
            <SheetTitle>
              <AtiendeWordmark markClassName="h-6 w-auto" />
              <span className="sr-only">Menú de navegación</span>
            </SheetTitle>
          </SheetHeader>
          <SidebarNav onNavigate={() => setMobileNavOpen(false)} className="pb-4" />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <header
          role="banner"
          className="flex h-14 shrink-0 items-center justify-between gap-2 rounded-2xl border border-border bg-card px-4 shadow-card md:h-12"
        >
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Abrir menú de navegación"
              aria-haspopup="dialog"
              className="md:hidden"
              onClick={() => setMobileNavOpen(true)}
            >
              <Menu className="h-5 w-5" aria-hidden="true" />
            </Button>
            <span className="md:hidden">
              <AtiendeWordmark markClassName="h-6 w-auto" />
            </span>
          </div>
          <div className="flex items-center gap-3">
            <OrganizationSwitcher />
            <ThemeSelector />
          </div>
        </header>

        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 rounded-2xl border border-border bg-card p-4 shadow-card focus:outline-none sm:p-6"
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
