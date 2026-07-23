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
	<!-- min-w-0: without it this flex child sizes to its widest table and the
	     whole admin viewport scrolls sideways on phones. -->
	<Sidebar.Inset class="flex h-svh min-w-0 flex-col overflow-hidden">
		<TopBar />
		<div class="min-h-0 flex-1 overflow-auto">
			{@render children()}
		</div>
	</Sidebar.Inset>
</Sidebar.Provider>
