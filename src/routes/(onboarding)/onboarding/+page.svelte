<script lang="ts">
    import CheckIcon from "@lucide/svelte/icons/check";
    import RecoveryEmailCard from "$lib/components/account/recovery-email-card.svelte";
    import TwoFactorCard from "$lib/components/account/two-factor-card.svelte";
    import PasskeyCard from "$lib/components/account/passkey-card.svelte";
    import EmailVerifyCard from "$lib/components/account/email-verify-card.svelte";
    import SetPasswordCard from "$lib/components/account/set-password-card.svelte";

    let { data } = $props();

    const steps = $derived(data.onboarding.steps);
    const doneCount = $derived(steps.filter((s) => s.done).length);
    // Later steps stay locked until the email/recovery step is verified. The
    // super-admin has NO such step (email-free genesis) — nothing to gate on, so
    // treat the prerequisite as satisfied and unlock the remaining steps.
    const verifyStep = $derived(
        steps.find((s) => s.id === "verify-email" || s.id === "verify-recovery"),
    );
    const isEmailVerified = $derived(verifyStep ? verifyStep.done : true);
</script>

<div class="flex flex-col gap-6">
    <div class="flex flex-col gap-2">
        <h1 class="font-heading text-2xl font-semibold tracking-tight">
            Finish setting up
        </h1>
        <p class="text-muted-foreground text-sm">
            A few steps before you can access Doota. {doneCount} of {steps.length}
            done.
        </p>
        <div class="bg-muted mt-1 h-1.5 w-full overflow-hidden rounded-full">
            <div
                class="bg-ok h-full rounded-full transition-all"
                style="width:{steps.length
                    ? (doneCount / steps.length) * 100
                    : 0}%"
            ></div>
        </div>
    </div>

    {#snippet stepDone({ title }: { title: string })}
        <div
            class="flex items-center gap-3 rounded-lg border bg-card px-4 py-3"
        >
            <span
                class="bg-ok/10 text-ok flex size-6 items-center justify-center rounded-full"
            >
                <CheckIcon class="size-4" />
            </span>
            <div class="flex flex-col">
                <span class="text-sm font-medium">{title}</span>
                <span class="text-muted-foreground text-xs">Done</span>
            </div>
        </div>
    {/snippet}

    {#snippet stepsCounter({ index, length }: { index: number; length: number })}
        <div
            class="text-muted-foreground flex items-center gap-2 text-xs font-medium"
        >
            <span
                class="bg-muted flex size-5 items-center justify-center rounded-full text-[11px]"
            >
                {index + 1}
            </span>
            Step {index + 1} of {length}
        </div>
    {/snippet}

    {#each steps as step, i (step.id)}
        {#if !isEmailVerified && step.id !== "verify-email" && step.id !== "verify-recovery"}
            <div
                class="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 opacity-50"
            >
                <span
                    class="bg-muted flex size-6 items-center justify-center rounded-full text-[11px]"
                >
                    {i + 1}
                </span>
                <div class="flex flex-col">
                    <span class="text-sm font-medium">{step.title}</span>
                    <span class="text-muted-foreground text-xs">Locked</span>
                </div>
            </div>
        {:else}
            {#if step.done}
                {@render stepDone({ title: step.title })}
            {:else}
                <div class="flex flex-col gap-2">
                    {@render stepsCounter({ index: i, length: steps.length })}
                    {#if step.id === "verify-email"}
                        <EmailVerifyCard email={data.account.email} />
                    {:else if step.id === "verify-recovery"}
                        <RecoveryEmailCard
                            recoveryEmail={data.account.recoveryEmail}
                            recoveryEmailVerified={data.account
                                .recoveryEmailVerified}
                        />
                    {:else if step.id === "set-password"}
                        <SetPasswordCard />
                    {:else if step.id === "secure-account" && isEmailVerified}
                        <TwoFactorCard
                            enabled={data.account.twoFactorEnabled}
                            email={data.account.email}
                        />
                        <PasskeyCard passkeys={data.passkeys} />
                    {/if}
                </div>
            {/if}
        {/if}
    {/each}
</div>
