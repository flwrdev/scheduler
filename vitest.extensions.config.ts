import { defineConfig } from "vitest/config";

// Extension render-level tests (@shopify/ui-extensions-tester) — separate config
// from the root vitest.config.ts so the fast plain-node unit suite stays
// untouched. The tester needs a mock DOM (jsdom) and per-file isolation (vitest
// default). getExtension() discovers each extension's shopify.extension.toml by
// walking UP from the test file's own directory, so these tests live inside
// extensions/<name>/tests/ and still run fine from the repo root.
export default defineConfig({
  esbuild: {
    jsx: "automatic",
    // LOAD-BEARING, not a convenience. The tester is inlined (see below), so it
    // dynamic-imports each extension module through Vite — which means the three
    // preact extensions (delivery-thank-you, order-delivery-block,
    // delivery-reschedule-action) have THEIR OWN sources transformed by this
    // esbuild config. Drop jsxImportSource and their JSX compiles against React's
    // runtime instead, failing at render with "Cannot add property __, object is
    // not extensible".
    jsxImportSource: "preact",
  },
  test: {
    environment: "jsdom",
    // Windows fix: the tester dynamic-imports the extension module by absolute
    // path (`c:\...`), which Node's default ESM loader rejects (needs file://).
    // Inlining the tester routes that import through Vite's resolver instead.
    server: {
      deps: {
        inline: ["@shopify/ui-extensions-tester"],
      },
    },
    include: ["extensions/*/tests/**/*.test.{ts,tsx}"],
    exclude: ["**/node_modules/**"],
  },
});
