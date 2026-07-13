<script lang="ts">
	import AtSignIcon from '@lucide/svelte/icons/at-sign';
	import Lock from '@lucide/svelte/icons/lock';
	import User from '@lucide/svelte/icons/user';
	import { Button } from '$lib/components/ui/button';
	import { DecorIcon } from '$lib/components/ui/decor-icon';
	import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupButton } from '$lib/components/ui/input-group';
	import { cn } from '$lib/utils/ui.js';
	import type { HTMLAttributes } from 'svelte/elements';
	import { createAdminRemoteFunction } from '$lib/rpc/create-admin.remote.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import { slide } from 'svelte/transition';
	import { sineInOut } from 'svelte/easing';
	import { toast } from 'svelte-sonner';
	import { registerSchema } from '$lib/shared/model/auth.zod.schema';
    import * as Tooltip from '$lib/components/ui/tooltip/index.js';
    import { InfoIcon } from '@lucide/svelte';

	type AuthTwoProps = HTMLAttributes<HTMLDivElement> & {
		class?: string;
	};

	let { class: className = '', ...restProps }: AuthTwoProps = $props();

	let formState = $state({
		isLoading: false
	});

	let { fields } = createAdminRemoteFunction;
	let { result } = $derived(createAdminRemoteFunction);

	async function enhancedFormLogin({
		form,
		data,
		submit
	}: Parameters<Parameters<typeof createAdminRemoteFunction.enhance>[0]>[0]) {
		formState.isLoading = true;
		try {
			await submit();
			switch (result?.success) {
				case true:
					form.reset();
					toast.success(result?.message as string);
					break;
				case false:
					toast.error(result?.message as string);
					break;
				default:
					toast.warning('Error while getting form result.');
					break;
			}
		} catch (error) {
			console.log(error);
		} finally {
			formState.isLoading = false;
		}
	}
</script>

<div
	class={cn(
		'relative flex h-screen w-full items-center justify-center overflow-hidden px-6 md:px-8',
		className
	)}
	{...restProps}
>
	<div
		class={cn(
			'relative flex w-full max-w-sm flex-col justify-between p-6 md:p-8',
			'dark:bg-[radial-gradient(50%_80%_at_20%_0%,--theme(--color-foreground/.1),transparent)]'
		)}
	>
		<div class="absolute -inset-y-6 -left-px w-px bg-border"></div>
		<div class="absolute -inset-y-6 -right-px w-px bg-border"></div>
		<div class="absolute -inset-x-6 -top-px h-px bg-border"></div>
		<div class="absolute -inset-x-6 -bottom-px h-px bg-border"></div>

		<DecorIcon position="top-left" />
		<DecorIcon position="bottom-right" />

		<div class="w-full max-w-sm animate-in space-y-8">
			<div class="flex flex-col space-y-1">
				<h1 class="text-2xl font-bold tracking-wide">Doota</h1>
				<p class="text-base text-muted-foreground">Create an admin account for the app.</p>
			</div>

			<div class="space-y-4">
				<form
					{...createAdminRemoteFunction.preflight(registerSchema).enhance(enhancedFormLogin)}
					class="space-y-2"
					onchange={() => createAdminRemoteFunction.validate()}
				>
					<Field.Group>
						<Field.Field>
							<Field.Label>Name</Field.Label>
							<InputGroup>
								<InputGroupInput placeholder="Shivam" {...fields.name.as('text')} type="text" />
								<InputGroupAddon align="inline-start">
									<User />
								</InputGroupAddon>
							</InputGroup>
							{#if fields.name.issues()?.length}
								{#each fields.name.issues() as error (error)}
									<Field.Error>{error.message}</Field.Error>
								{/each}
							{/if}
						</Field.Field>
						<Field.Field>
							<Field.Label>Email</Field.Label>
							<InputGroup>
								<InputGroupInput
									placeholder="hello@email.com"
									{...fields.email.as('email')}
									type="email"
								/>
								<InputGroupAddon align="inline-start">
									<AtSignIcon />
								</InputGroupAddon>
								<InputGroupAddon align="inline-end">
								    <Tooltip.Provider>
                                        <Tooltip.Root>
                                            <Tooltip.Trigger>
                                            {#snippet child({ props })}
                                                <InputGroupButton
                                                {...props}
                                                variant="ghost"
                                                aria-label="Info"
                                                size="icon-xs"
                                                >
                                                <InfoIcon />
                                                </InputGroupButton>
                                            {/snippet}
                                            </Tooltip.Trigger>
                                            <Tooltip.Content>
                                            <p>name@yourdomain.tld</p>
                                            </Tooltip.Content>
                                        </Tooltip.Root>
									</Tooltip.Provider>
                                </InputGroupAddon>
						    </InputGroup>
							<Field.Description>Email shoudl end with your domain.</Field.Description>
							{#if fields.email.issues()?.length}
								{#each fields.email.issues() as error (error)}
									<Field.Error>{error.message}</Field.Error>
								{/each}
							{/if}
						</Field.Field>
						<Field.Field>
							<Field.Label>Email</Field.Label>
							<InputGroup>
								<InputGroupInput
									placeholder="hello@email.com"
									{...fields.email.as('email')}
									type="email"
								/>
								<InputGroupAddon align="inline-start">
									<AtSignIcon />
								</InputGroupAddon>
								<InputGroupAddon align="inline-end">
								    <Tooltip.Provider>
                                        <Tooltip.Root>
                                            <Tooltip.Trigger>
                                            {#snippet child({ props })}
                                                <InputGroupButton
                                                {...props}
                                                variant="ghost"
                                                aria-label="Info"
                                                size="icon-xs"
                                                >
                                                <InfoIcon />
                                                </InputGroupButton>
                                            {/snippet}
                                            </Tooltip.Trigger>
                                            <Tooltip.Content>
                                            <p>youremail@gmail.com</p>
                                            </Tooltip.Content>
                                        </Tooltip.Root>
									</Tooltip.Provider>
                                </InputGroupAddon>
						    </InputGroup>
							<Field.Description>This email will be used to recover the account.</Field.Description>
							{#if fields.email.issues()?.length}
								{#each fields.email.issues() as error (error)}
									<Field.Error>{error.message}</Field.Error>
								{/each}
							{/if}
						</Field.Field>
						<Field.Field>
							<Field.Label>Password</Field.Label>
							<InputGroup>
								<InputGroupInput
									placeholder="Password"
									{...fields.password.as('password')}
									type="password"
									autocomplete="new-password"
								/>
								<InputGroupAddon align="inline-start">
									<Lock />
								</InputGroupAddon>
							</InputGroup>
							{#if fields.password.issues()?.length}
								{#each fields.password.issues() as error (error)}
									<Field.Error>{error.message}</Field.Error>
								{/each}
							{/if}
						</Field.Field>
						<Field.Field>
							<Button
								class="w-full"
								size="default"
								type="submit"
								disabled={formState.isLoading || !!fields.allIssues()}
							>
								{#if formState.isLoading}
									<div
										class="inline"
										transition:slide={{
											axis: 'x',
											easing: sineInOut
										}}
									>
										<Spinner class="mr-1" />
									</div>
								{/if}
								{#if formState.isLoading}
									Creating your account...
								{:else}
									Create Admin
								{/if}
							</Button>
						</Field.Field>
					</Field.Group>
				</form>
			</div>
		</div>
	</div>
</div>
