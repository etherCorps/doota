<script lang="ts">
	import { resolve } from '$app/paths';
	import MailboxManager from '$lib/components/admin/mailbox-manager.svelte';

	let { data } = $props();
	const backHref = $derived(`${resolve('/admin/organizations')}/${data.org.id}/mailboxes`);
</script>

<MailboxManager
	mailbox={data.mailbox}
	members={data.members}
	grants={data.grants}
	activity={data.activity}
	{backHref}
/>
