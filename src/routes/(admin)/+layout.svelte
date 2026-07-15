<script lang="ts">
	import * as Sidebar from '$lib/components/ui/sidebar/index.js';
	import { PersistedState } from 'runed';
	import AdminSidebar from '$lib/components/admin/admin-sidebar.svelte';
	import TopBar from '$lib/components/app/top-bar.svelte';

	let { data, children } = $props();

	const sidebarOpen = new PersistedState('doota:sidebar-open', true);
</script>

<Sidebar.Provider bind:open={sidebarOpen.current}>
	<AdminSidebar user={data.user} />
	<Sidebar.Inset class="flex h-svh flex-col overflow-hidden">
		<TopBar />
		<div class="min-h-0 flex-1 overflow-auto">
			{@render children()}
		</div>
	</Sidebar.Inset>
</Sidebar.Provider>
