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
  }
});
