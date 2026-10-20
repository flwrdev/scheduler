import { defineConfig } from "vitest/config";

// Standalone Vitest config (does NOT load the react-router plugin) so unit tests
// for pure server helpers run fast in a plain Node environment. Component
// integration tests opt into jsdom per-file via `// @vitest-environment jsdom`.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
