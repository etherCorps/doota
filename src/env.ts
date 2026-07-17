import { dev } from '$app/env';
import { defineEnvVars } from '@sveltejs/kit/hooks';

export const variables = defineEnvVars({
  DATABASE_URL: {
    public: false,
    required: dev,
    type: 'string',
  },
  BETTER_AUTH_SECRET: {
    public: false,
    required: true,
    type: 'string'
  },
	ORIGIN: {
    public: true,
    required: true,
    type: 'string'
  },
  // One-time gate for the /setup wizard. Genesis only works when the user
  // count is zero AND this token is presented — deploy access is the trust root.
  SETUP_TOKEN: {
    public: false,
    required: false,
    type: 'string'
  },
  // Cloudflare credential: a SCOPED API Token (Bearer), never the Global API
  // Key. Store as a Worker secret. No account email / global key.
  CF_ACCOUNT_ID: {
    public: false,
    required: false,
    type: 'string'
  },
  CF_API_TOKEN: {
    public: false,
    required: false,
    type: 'string'
  },
  // Name of the deployed mail-in Worker the catch-all routing rule targets.
  MAIL_IN_WORKER_NAME: {
    public: false,
    required: false,
    type: 'string'
  }
});
