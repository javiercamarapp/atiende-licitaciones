import { useState } from "react";
import { LogOut, User as UserIcon } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Menú de cuenta del header: identidad real (email de `GET /me`) y logout
 * real (revoca el refresh token en el servidor, ver `POST /auth/logout`).
 * Se oculta por completo mientras no hay usuario autenticado (p. ej. en
 * pruebas de componente que montan `<AppShell/>` fuera de `<RequireAuth/>`)
 * en vez de mostrar un estado inventado.
 */
export function UserMenu() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);

  if (!user) return null;

  const handleLogout = async () => {
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      setLoggingOut(false);
      navigate("/login", { replace: true });
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label={`Cuenta: ${user.email}`} className="h-11 w-11 shrink-0">
          <UserIcon className="h-4 w-4" aria-hidden="true" strokeWidth={1.75} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="truncate font-normal text-muted-foreground">{user.email}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={(event) => { event.preventDefault(); void handleLogout(); }} disabled={loggingOut}>
          <LogOut className="mr-2 h-4 w-4" aria-hidden="true" />
          {loggingOut ? "Cerrando sesión…" : "Cerrar sesión"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
