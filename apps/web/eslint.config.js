import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import jsxA11y from "eslint-plugin-jsx-a11y";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // public/mockServiceWorker.js: generado por `npx msw init` (ver
  // package.json "msw.workerDirectory") -- código de terceros que este
  // repo no edita a mano, con su propio estilo/comentarios (incluye un
  // `eslint-disable` que este eslint.config.js no necesita, de ahí la
  // advertencia "unused eslint-disable directive" si se lintea).
  { ignores: ["dist", "coverage", "eslint.config.js", "public/mockServiceWorker.js"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    // e2e/ se excluye de este bloque (ver el bloque dedicado abajo): las
    // reglas de react-hooks/jsx-a11y no aplican a specs de Playwright, y
    // react-hooks/rules-of-hooks confunde el `use` de los fixtures de
    // Playwright (e2e/fixtures.ts) con un Hook de React por el nombre.
    files: ["**/*.{ts,tsx}"],
    ignores: ["e2e/**"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
      "jsx-a11y": jsxA11y,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["e2e/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2020,
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
