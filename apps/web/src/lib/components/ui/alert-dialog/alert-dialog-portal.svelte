<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { AlertDialog as AlertDialogPrimitive } from "bits-ui";

	let { ...restProps }: AlertDialogPrimitive.PortalProps = $props();
</script>

<AlertDialogPrimitive.Portal {...restProps} />
