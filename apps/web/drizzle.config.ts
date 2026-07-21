import { defineConfig } from 'drizzle-kit';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

export default defineConfig({
	schema: './src/lib/server/db/schema.ts',
	// Migrations live at the workspace root (shared with the mail Workers).
	out: '../../drizzle',
	dialect: 'sqlite',
	// dbCredentials: { url: process.env.DATABASE_URL },
	dbCredentials: { url: ".wrangler/state/v3/d1/miniflare-D1DatabaseObject/c682baacc0bed09931816991d6783917586c62ff5a70429077fa6be99136d526.sqlite" },
	verbose: true,
	strict: true
});
