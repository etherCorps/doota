// SPDX-License-Identifier: Apache-2.0
import { dev } from '$app/env';
import { defineEnvVars } from '@sveltejs/kit/hooks';
import { z } from 'zod';

// Contract: a var WITHOUT a schema must be a non-empty string at boot, so
// every optional var needs an explicit .optional() schema. Validated when the
// app starts; `description` shows on hover at the import site.
//
// Every var here is DYNAMIC (`static` defaults to false): values are read
// from the Worker's environment at boot — which is what lets the infra
// deploy bind them after the bundle is built. Never set `static: true` on
// these; it would inline the BUILD machine's values into the bundle.
//
// Provisioning contract (infra/.env.example is the canonical list):
// required-from-deployer = ORIGINS, SETUP_TOKEN, APP_CLOUDFLARE_*;
// minted-by-deploy = BETTER_AUTH_SECRET (+ mail keys on the Workers);
// injected-by-deploy = MAIL_IN_WORKER_NAME; the rest optional.
const optional = z.string().optional();

export const variables = defineEnvVars({
	DATABASE_URL: {
		public: false,
		description: 'Local D1 database file for drizzle-kit (dev/studio only).',
		schema: dev ? z.string().min(1) : optional
	},
	BETTER_AUTH_SECRET: {
		public: false,
		description: 'better-auth signing secret — 32+ chars in production. Minted into stack state by the infra deploy when not provided.',
		schema: dev ? z.string().min(1) : optional
	},
	ORIGINS: {
		public: true,
		description:
			'Comma-separated full origins WITH protocol (e.g. "https://mail.acme.com"). First entry is the canonical app URL (absolute links, auth fallback); every entry is a better-auth allowed host. Must include the dev origin locally, or auth routes 404.',
		schema: z
			.string()
			.min(1)
			.transform((origins) => origins.split(',').map((origin) => origin.trim()).filter(Boolean))
			.pipe(z.array(z.url()).min(1))
	},
	// One-time gate for the /setup wizard. Genesis only works when the user
	// count is zero AND this token is presented — deploy access is the trust root.
	SETUP_TOKEN: {
		public: false,
		description: 'Required from the deployer: one-time token gating the /setup genesis wizard. Unset = wizard disabled — no first admin.',
		// Required in dev so the local loop always has a working /setup; optional
		// in prod so a deploy without it boots with the wizard off, not a crash.
		schema: dev ? z.string().min(1) : z.string().min(8)
	},
	// Cloudflare credential: a SCOPED API Token (Bearer), never the Global API
	// Key. Store as a Worker secret. No account email / global key.
	APP_CLOUDFLARE_ACCOUNT_ID: {
		public: false,
		description: 'Required from the deployer: Cloudflare account id for the DNS/Email Routing API. Unset = domain onboarding disabled.',
		schema: dev ? z.string().min(1) : optional
	},
	APP_CLOUDFLARE_API_TOKEN: {
		public: false,
		description: 'Required from the deployer: SCOPED runtime API token for domain onboarding (never the Global API Key, not the deploy token). Unset = domain onboarding disabled.',
		schema: dev ? z.string().min(1) : optional
	},
	MAIL_IN_WORKER_NAME: {
		public: false,
		description: 'Injected by the infra deploy from the deployed mail-in Worker — never set manually. The catch-all routing rule targets it.',
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
		schema: z.enum(['debug', 'info', 'warn', 'error']).optional()
	}
});
