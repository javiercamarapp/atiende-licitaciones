import { defineConfig } from 'vitest/config';

// La suite creció bastante en ronda 2 (más de una docena de archivos, cada
// uno levantando su propia app Fastify + instancia PGlite en memoria y
// aplicando las migraciones). Ejecutar TODOS los archivos en paralelo sin
// límite satura la CPU disponible en este entorno y produce timeouts
// espurios de 5s (el valor por defecto de vitest) que no reflejan ningún
// fallo real -- cada archivo, ejecutado solo, pasa establemente en menos de
// 2s por caso. Se sube el timeout y se acota la concurrencia de procesos en
// vez de bajar la cobertura de pruebas.
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        minForks: 1,
        maxForks: 4,
      },
    },
  },
});
