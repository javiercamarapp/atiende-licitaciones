// Barrel de conveniencia: re-exporta todo el cliente API tipado hacia
// apps/api. Los hooks (src/hooks/*) importan de aquí; los módulos concretos
// también pueden importarse directamente (p. ej. "@/lib/api/company") si se
// prefiere no traer el resto del árbol.
export * from "./http";
export * from "./session";
export * from "./client";
export * from "./schemas";
export * from "./auth";
export * from "./google";
export * from "./organizations";
export * from "./company";
export * from "./tenders";
export * from "./matching";
export * from "./go-no-go";
export * from "./agents";
export * from "./admin";
export * from "./audit";
export * from "./expediente";
