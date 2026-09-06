import { IdCard } from "lucide-react";
import { createModulePage } from "@/pages/createModulePage";

const Page = createModulePage({
  icon: IdCard,
  title: "Perfil y capacidades",
  description: "Perfil real de la empresa: experiencia verificable, productos, servicios y ubicaciones.",
  emptyTitle: "Aún no hay perfil configurado",
  emptyDescription: "Completa el perfil y las capacidades de tu empresa para habilitar el matching y la preparación de propuestas.",
});

export default Page;
