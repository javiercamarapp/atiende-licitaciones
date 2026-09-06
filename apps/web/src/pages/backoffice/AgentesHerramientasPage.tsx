import { Bot } from "lucide-react";
import { createModulePage } from "@/pages/createModulePage";

const Page = createModulePage({
  icon: Bot,
  title: "Agentes y herramientas",
  description: "Configuración de agentes de IA y herramientas conectadas.",
  emptyTitle: "Aún no hay agentes configurados",
  emptyDescription: "Los agentes y herramientas que actives aparecerán aquí.",
});

export default Page;
