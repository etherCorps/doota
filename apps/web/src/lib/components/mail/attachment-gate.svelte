<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- The single confirm dialog behind the attachment open/download gate. Rendered
     once per page; every tile routes its non-clean opens through the shared
     `confirm` state. Fail-open: the file matched / couldn't be checked, but the
     user may still download after this explicit confirm. -->
<script lang="ts">
	import * as AlertDialog from '$lib/components/ui/alert-dialog/index.js';
	import { confirm, confirmMessage } from '$lib/client/attachment-gate.svelte';

	function proceed() {
		confirm.proceed();
		confirm.open = false;
	}
</script>

<AlertDialog.Root bind:open={confirm.open}>
	<AlertDialog.Content>
		<AlertDialog.Header>
			<AlertDialog.Title>Download {confirm.filename}?</AlertDialog.Title>
			<AlertDialog.Description>
				{confirmMessage(confirm.verdict)}
			</AlertDialog.Description>
		</AlertDialog.Header>
		<AlertDialog.Footer>
			<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
			<AlertDialog.Action onclick={proceed}>Download anyway</AlertDialog.Action>
		</AlertDialog.Footer>
	</AlertDialog.Content>
</AlertDialog.Root>
