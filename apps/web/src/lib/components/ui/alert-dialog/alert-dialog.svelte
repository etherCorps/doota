<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { AlertDialog as AlertDialogPrimitive } from "bits-ui";

	let { open = $bindable(false), ...restProps }: AlertDialogPrimitive.RootProps = $props();
</script>

<AlertDialogPrimitive.Root bind:open {...restProps} />
