import { Tag } from "lucide-react";
import { createModulePage } from "@/pages/createModulePage";

const Page = createModulePage({
  icon: Tag,
  title: "Tarifas aprobadas",
  description: "Precios y tarifas reales aprobados por la empresa, usados en propuestas económicas.",
  emptyTitle: "Aún no hay tarifas aprobadas",
  emptyDescription: "Registra las tarifas aprobadas de tu empresa; nunca se usan precios inventados en una propuesta.",
});

export default Page;
