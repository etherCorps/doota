<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	// DEV-ONLY. Preview the three role surfaces without wiring real auth.
	// Real routes are still server-gated by the logged-in user's role; this just
	// jumps between the /app and /admin shells so all three are reachable in dev.
	// TODO: remove once role-aware nav is driven entirely by the session.
	import { PersistedState } from 'runed';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';

	type Role = 'member' | 'admin' | 'superadmin';
	const roles: Role[] = ['member', 'admin', 'superadmin'];
	const preview = new PersistedState<Role>('doota:preview-role', 'admin');

	function pick(role: Role) {
		preview.current = role;
		// superadmin has no mailbox → admin shell; everyone else → app shell.
		goto(role === 'superadmin' ? resolve('/admin') : resolve('/app'));
	}
</script>

{#if import.meta.env.DEV}
	<div class="px-2 pb-1">
		<p class="text-faint px-1 pb-1 text-[10px] font-medium tracking-wide uppercase">Preview role</p>
		<div class="bg-muted flex rounded-md p-0.5">
			{#each roles as role (role)}
				<button
					type="button"
					onclick={() => pick(role)}
					class="flex-1 rounded-[5px] px-1.5 py-1 text-[11px] font-medium capitalize transition-colors
						{preview.current === role
						? 'bg-card text-foreground shadow-sm'
						: 'text-muted-foreground hover:text-foreground'}"
				>
					{role === 'superadmin' ? 'super' : role}
				</button>
			{/each}
		</div>
	</div>
{/if}
