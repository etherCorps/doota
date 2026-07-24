// SPDX-License-Identifier: Apache-2.0
import { dev } from '$app/env';
import { defineEnvVars } from '@sveltejs/kit/hooks';
import { z } from 'zod';

// Contract: a var WITHOUT a schema must be a non-empty string at boot, so
// every optional var needs an explicit .optional() schema. Validated when the
// app starts; `description` shows on hover at the import site.
const optional = z.string().optional();

export const variables = defineEnvVars({
	DATABASE_URL: {
		public: false,
		description: 'Local D1 database file for drizzle-kit (dev/studio only).',
		schema: dev ? z.string().min(1) : optional
	},
	BETTER_AUTH_SECRET: {
		public: false,
		description: 'better-auth signing secret — 32+ chars, high entropy, in production.',
		// ponytail: length enforced only in prod so throwaway dev secrets keep working.
		schema: dev ? z.string().min(1) : z.string().min(32)
	},
	ORIGIN: {
		public: true,
		description: "The app's URL. Must match the dev port, or auth routes 404.",
		schema: z.url()
	},
	// One-time gate for the /setup wizard. Genesis only works when the user
	// count is zero AND this token is presented — deploy access is the trust root.
	SETUP_TOKEN: {
		public: false,
		description: 'One-time token gating the /setup genesis wizard. Unset = wizard disabled.',
		schema: optional
	},
	// Cloudflare credential: a SCOPED API Token (Bearer), never the Global API
	// Key. Store as a Worker secret. No account email / global key.
	APP_CLOUDFLARE_ACCOUNT_ID: {
		public: false,
		description: 'Cloudflare account id for the DNS/Email Routing API.',
		schema: optional
	},
	APP_CLOUDFLARE_API_TOKEN: {
		public: false,
		description: 'SCOPED Cloudflare API token (never the Global API Key). Worker secret in prod.',
		schema: optional
	},
	MAIL_IN_WORKER_NAME: {
		public: false,
		description: 'Name of the deployed mail-in Worker the catch-all routing rule targets.',
		schema: optional
	},
	CRON_SECRET: {
		public: false,
		description: 'Bearer secret the cron trigger presents to POST /api/cron.',
		schema: optional
	},
	LOG_LEVEL: {
		public: false,
		description: 'Minimum mail-pipeline log level (@doota/mail-core/log). Default: info.',
		schema: z.enum(['debug', 'info', 'warn', 'error']).optional().default('info')
	}
});
