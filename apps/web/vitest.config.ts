import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Unit tests run in plain node. SvelteKit virtual modules ($app/*) don't exist
// outside the build, so they're aliased to test stubs — `$app/server` exposes a
// settable getRequestEvent so boundary functions can be driven with fake locals.
export default defineConfig({
  resolve: {
    alias: [
      { find: "$app/server", replacement: r("./src/test/stubs/app-server.ts") },
      { find: "$app/env/private", replacement: r("./src/test/stubs/app-env-private.ts") },
      { find: "$app/env/public", replacement: r("./src/test/stubs/app-env-public.ts") },
      { find: /^\$lib\/(.*)$/, replacement: r("./src/lib/$1") },
      // Workspace packages resolved to source so the node test env transforms
      // their .ts directly (mirrors the package exports maps).
      { find: /^@doota\/db\/(.*)$/, replacement: r("../../packages/db/src/$1") },
      { find: "@doota/db", replacement: r("../../packages/db/src/index.ts") },
      { find: /^@doota\/mail-core\/(.*)$/, replacement: r("../../packages/mail-core/src/$1") },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
