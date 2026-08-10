// ponytail: shim so bare `$lib/client/localdb` resolves; real module is
//           index.svelte.ts (needs .svelte.ts to compile $state runes).
export * from "./index.svelte.js";
