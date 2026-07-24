import tailwindcss from '@tailwindcss/vite';
import devtoolsJson from 'vite-plugin-devtools-json';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit(), devtoolsJson()],
	// harper.js resolves its WASM via `new URL('...wasm', import.meta.url)`. Dep
	// pre-bundling rewrites that to `.vite/deps/` where the binary isn't copied,
	// so it 404s in dev. Excluding it serves the package from node_modules with
	// its wasm alongside. (It's dynamically imported, so exclusion costs nothing.)
	optimizeDeps: { exclude: ['harper.js', 'harper.js/binary'] }
});
