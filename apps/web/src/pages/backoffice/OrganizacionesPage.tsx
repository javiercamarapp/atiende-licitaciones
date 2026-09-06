import { Building2 } from "lucide-react";
import { createModulePage } from "@/pages/createModulePage";

const Page = createModulePage({
  icon: Building2,
  title: "Organizaciones",
  description: "Cuentas de licitante gestionadas en la plataforma.",
  emptyTitle: "Aún no hay organizaciones registradas",
  emptyDescription: "Crea la primera organización para empezar a operar en la plataforma.",
});

export default Page;
