<script lang="ts">
	import { resolve } from '$app/paths';
	import MailboxManager from '$lib/components/admin/mailbox-manager.svelte';

	let { data } = $props();
	const backHref = resolve('/app');
</script>

<div class="mx-auto w-full max-w-4xl p-6 md:p-8">
	<MailboxManager
		mailbox={data.mailbox}
		members={data.members}
		grants={data.grants}
		activity={data.activity}
		{backHref}
	/>
</div>
