import { createAuthClient } from 'better-auth/svelte';
import { adminClient, lastLoginMethodClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
	plugins: [adminClient(), lastLoginMethodClient()]
});
