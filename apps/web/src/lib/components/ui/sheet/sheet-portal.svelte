<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
	import { Dialog as SheetPrimitive } from "bits-ui";

	let { ...restProps }: SheetPrimitive.PortalProps = $props();
</script>

<SheetPrimitive.Portal {...restProps} />
