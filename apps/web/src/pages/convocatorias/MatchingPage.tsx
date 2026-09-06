import { Target } from "lucide-react";
import { createModulePage } from "@/pages/createModulePage";

const Page = createModulePage({
  icon: Target,
  title: "Matching",
  description: "Relevancia automática de convocatorias frente al perfil de tu organización.",
  emptyTitle: "Aún no hay coincidencias calculadas",
  emptyDescription: "El matching se generará en cuanto existan convocatorias descubiertas y un perfil configurado.",
});

export default Page;
