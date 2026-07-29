import tailwindcss from '@tailwindcss/vite';
import devtoolsJson from 'vite-plugin-devtools-json';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit(), devtoolsJson()],
	// harper.js + mrml resolve their WASM relative to their own files. Dep
	// pre-bundling rewrites those paths to `.vite/deps/` where the binary isn't
	// copied, so it 404s in dev. Excluding them serves the packages from
	// node_modules with their wasm alongside. (Both are dynamically imported, so
	// exclusion costs nothing.)
	optimizeDeps: { exclude: ['harper.js', 'harper.js/binary', 'mrml', 'mrml/web/mrml_wasm.js'] }
});
