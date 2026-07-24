<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { Dialog as SheetPrimitive } from "bits-ui";

	let { open = $bindable(false), ...restProps }: SheetPrimitive.RootProps = $props();
</script>

<SheetPrimitive.Root bind:open {...restProps} />
