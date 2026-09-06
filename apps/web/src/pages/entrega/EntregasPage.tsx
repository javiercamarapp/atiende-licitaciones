import { Send } from "lucide-react";
import { createModulePage } from "@/pages/createModulePage";

const Page = createModulePage({
  icon: Send,
  title: "Entregas",
  description: "Registro de envíos de propuestas a las plataformas de licitación.",
  emptyTitle: "Aún no hay entregas registradas",
  emptyDescription: "Cuando envíes una propuesta, su registro de entrega aparecerá aquí.",
});

export default Page;
