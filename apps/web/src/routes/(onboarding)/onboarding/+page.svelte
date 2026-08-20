<script lang="ts">
	// SPDX-License-Identifier: Apache-2.0
    import CheckIcon from "@lucide/svelte/icons/check";
    import RecoveryEmailCard from "$lib/components/account/recovery-email-card.svelte";
    import TwoFactorCard from "$lib/components/account/two-factor-card.svelte";
    import ImportCard from "$lib/components/account/import-card.svelte";
    import PasskeyCard from "$lib/components/account/passkey-card.svelte";
    import EmailVerifyCard from "$lib/components/account/email-verify-card.svelte";
    import SetPasswordCard from "$lib/components/account/set-password-card.svelte";
    import OnboardDomainCard from "$lib/components/account/onboard-domain-card.svelte";

    let { data } = $props();

    const steps = $derived(data.onboarding.steps);
    const doneCount = $derived(steps.filter((step) => step.done).length);
    // Later steps stay locked until the email/recovery step is verified. The
    // super-admin has no such step (email-free genesis), nothing to gate on, so
    // treat the prerequisite as satisfied and unlock the remaining steps.
    const verifyStep = $derived(
        steps.find((step) => step.id === "verify-email" || step.id === "verify-recovery"),
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
        <div
            class="bg-muted mt-1 h-1.5 w-full overflow-hidden rounded-full"
            role="progressbar"
            aria-label="Onboarding progress"
            aria-valuemin={0}
            aria-valuemax={steps.length}
            aria-valuenow={doneCount}
        >
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
            class="flex items-center gap-3 rounded-xl border bg-card px-4 py-3 shadow-xs"
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
            class="text-brand flex items-center gap-2 text-xs font-medium"
        >
            <span
                class="bg-brand text-brand-foreground flex size-5 items-center justify-center rounded-full text-[11px]"
            >
                {index + 1}
            </span>
            Step {index + 1} of {length}
        </div>
    {/snippet}

    {#each steps as step, stepIndex (step.id)}
        {#if !isEmailVerified && step.id !== "verify-email" && step.id !== "verify-recovery"}
            <div
                class="flex items-center gap-3 rounded-xl border bg-card px-4 py-3 shadow-xs opacity-50"
            >
                <span
                    class="bg-muted flex size-6 items-center justify-center rounded-full text-[11px]"
                >
                    {stepIndex + 1}
                </span>
                <div class="flex flex-col">
                    <span class="text-sm font-medium">{step.title}</span>
                    <span class="text-muted-foreground text-xs"
                        >Locked — verify your email first</span
                    >
                </div>
            </div>
        {:else}
            {#if step.done}
                {@render stepDone({ title: step.title })}
            {:else}
                <div class="flex flex-col gap-2">
                    {@render stepsCounter({ index: stepIndex, length: steps.length })}
                    {#if step.id === "onboard-domain"}
                        <OnboardDomainCard />
                    {:else if step.id === "verify-email"}
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

    <!-- Deliberately OUTSIDE the {#each steps}: onboarding is a security gate
         (recovery email, 2FA, passkey) and nothing optional belongs inside it.
         An import runs for hours; making it a step would either block people who
         skip it or make the gate a lie. So it sits below, offered and skippable,
         and `status.complete` never depends on it. -->
    <section class="mt-2 flex flex-col gap-2 border-t pt-6">
        <div class="flex items-baseline justify-between gap-2">
            <h2 class="font-heading text-sm font-semibold">Bring your mail with you</h2>
            <span class="text-muted-foreground text-xs">Optional — you can skip this</span>
        </div>
        <p class="text-muted-foreground text-xs">
            Already have mail elsewhere? Import a <span class="font-mono">.mbox</span> export from
            Gmail, another Doota, or most other mail apps. It lands in Archive under a dated label,
            so it won't bury anything. You can also do this later from Settings → Mail.
        </p>
        <ImportCard />
    </section>
</div>
