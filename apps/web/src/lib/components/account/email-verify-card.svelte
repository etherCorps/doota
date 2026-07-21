<script lang="ts">
	import MailIcon from '@lucide/svelte/icons/mail';
	import { authClient } from '$lib/client/auth-client';
	import { toast } from 'svelte-sonner';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';

	let { email }: { email: string } = $props();
	let sending = $state(false);

	async function resend() {
		sending = true;
		const { error } = await authClient.sendVerificationEmail({
			email,
			callbackURL: '/onboarding?verified=1'
		});
		sending = false;
		if (error) {
			toast.error(error.message ?? 'Could not send verification email.');
			return;
		}
		toast.success('Verification email sent.');
	}
</script>

<Card.Card>
	<Card.CardHeader>
		<Card.CardTitle class="flex items-center gap-2">
			<MailIcon class="size-4" /> Verify your email
		</Card.CardTitle>
		<Card.CardDescription>
			We sent a confirmation link to <span class="font-mono">{email}</span>. Click it to finish, or
			resend below.
		</Card.CardDescription>
	</Card.CardHeader>
	<Card.CardContent>
		<Button variant="outline" onclick={resend} disabled={sending}>
			{#if sending}<Spinner class="mr-1" />{/if}
			Resend verification email
		</Button>
	</Card.CardContent>
</Card.Card>
