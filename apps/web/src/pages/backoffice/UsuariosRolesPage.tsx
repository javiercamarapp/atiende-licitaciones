import { Users } from "lucide-react";
import { createModulePage } from "@/pages/createModulePage";

const Page = createModulePage({
  icon: Users,
  title: "Usuarios y roles",
  description: "Cuentas de acceso y roles asignados dentro de la organización.",
  emptyTitle: "Aún no hay usuarios invitados",
  emptyDescription: "Invita a los primeros miembros de tu equipo para asignarles roles.",
});

export default Page;
