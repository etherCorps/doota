<script lang="ts">
	import * as Card from '$lib/components/ui/card/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Label } from '$lib/components/ui/label/index.js';
	import { Separator } from '$lib/components/ui/separator/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import { toast } from 'svelte-sonner';
	import { requestSuperadminEmailVerification } from '$lib/rpc/recovery-email.remote.js';

	let { data } = $props();

	let verifying = $state(false);

	async function verifyEmail() {
		verifying = true;
		try {
			const res = await requestSuperadminEmailVerification();
			if (res.success) toast.success(res.message);
			else toast.error(res.message);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not send verification email.');
		} finally {
			verifying = false;
		}
	}
</script>

<div class="mx-auto flex w-full max-w-2xl flex-col gap-6 p-6 md:p-8">
	<div class="flex flex-col gap-1">
		<h1 class="font-heading text-2xl font-semibold tracking-tight">Settings</h1>
		<p class="text-muted-foreground text-sm">Organization-wide preferences.</p>
	</div>

	{#if data.isSuperadmin && !data.emailVerified}
		<Card.Card>
			<Card.CardHeader>
				<Card.CardTitle class="font-heading">Verify your email</Card.CardTitle>
				<Card.CardDescription>
					Your login email <span class="font-mono">{data.email}</span> is unverified. Verifying it
					enables email-based password recovery. This is only available once a domain is active
					(a working sending path).
				</Card.CardDescription>
			</Card.CardHeader>
			<Card.CardContent>
				{#if data.hasActiveDomain}
					<Button onclick={verifyEmail} disabled={verifying}>
						{#if verifying}<Spinner class="mr-1" />{/if}
						Send verification email
					</Button>
				{:else}
					<p class="text-muted-foreground text-sm">
						Onboard a domain first — until then, recover with the
						<code>reset-admin</code> CLI.
					</p>
				{/if}
			</Card.CardContent>
		</Card.Card>
	{/if}

	<Card.Card>
		<Card.CardHeader>
			<Card.CardTitle class="font-heading">Organization</Card.CardTitle>
			<Card.CardDescription>Display name shown to members.</Card.CardDescription>
		</Card.CardHeader>
		<Card.CardContent class="space-y-3">
			<div class="space-y-1.5">
				<Label for="org-name">Name</Label>
				<Input id="org-name" value="Acme" />
			</div>
			<Separator />
			<div class="space-y-1.5">
				<Label for="org-reply">Default reply-to</Label>
				<Input id="org-reply" class="font-mono" value="support@acme.com" />
			</div>
		</Card.CardContent>
	</Card.Card>

	<div class="flex justify-end">
		<Button onclick={() => console.log('TODO: save settings')}>Save changes</Button>
	</div>
</div>
