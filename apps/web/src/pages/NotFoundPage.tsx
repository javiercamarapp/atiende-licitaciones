import { Link } from "react-router-dom";
import { Compass } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function NotFoundPage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Compass className="h-7 w-7" aria-hidden="true" strokeWidth={1.75} />
      </div>
      <div>
        <h1 className="font-display text-2xl font-semibold text-foreground">Página no encontrada</h1>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          La página que buscas no existe o fue movida. Vuelve al panel principal.
        </p>
      </div>
      <Button asChild>
        <Link to="/panel">Volver al panel</Link>
      </Button>
    </div>
  );
}
