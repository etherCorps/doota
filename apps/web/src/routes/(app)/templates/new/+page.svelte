<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import EmailEditor from '$lib/components/templates/email-editor.svelte';
	let { data } = $props();
</script>

<div class="h-full">
	<EmailEditor orgId={data.orgId} />
</div>
