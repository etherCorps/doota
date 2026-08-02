<script lang="ts">
    // SPDX-License-Identifier: Apache-2.0
    import { onMount } from "svelte";
    import { page } from "$app/state";
    import { goto } from "$app/navigation";
    import { resolve } from "$app/paths";
    import * as DropdownMenu from "$lib/components/ui/dropdown-menu/index.js";
    import * as Sidebar from "$lib/components/ui/sidebar/index.js";
    import { useSidebar } from "$lib/components/ui/sidebar/index.js";
    import { myMailboxes } from "$lib/rpc/mailbox.remote";
    import { activeMailbox } from "$lib/client/active-mailbox.svelte.js";
    import CheckIcon from "@lucide/svelte/icons/check";
    import ChevronsUpDownIcon from "@lucide/svelte/icons/chevrons-up-down";

    type Mailbox = {
        id: string;
        address: string;
        displayName: string | null;
        isPersonal: boolean;
        isService: boolean;
    };
    type Kind = "service" | "personal" | "shared";
    // Service beats personal beats shared — same precedence as the admin mailbox list.
    const kindOf = (mailbox: Mailbox | undefined): Kind =>
        mailbox?.isService
            ? "service"
            : (mailbox?.isPersonal ?? true)
              ? "personal"
              : "shared";

    // Ring-bordered chip per kind — full class strings so Tailwind's JIT scanner sees them.
    const tileClass: Record<Kind, string> = {
        personal:
            "bg-sky-500/10 text-sky-600 ring-sky-500/20 dark:bg-sky-400/10 dark:text-sky-400 dark:ring-sky-400/25",
        shared: "bg-emerald-500/10 text-emerald-600 ring-emerald-500/20 dark:bg-emerald-400/10 dark:text-emerald-400 dark:ring-emerald-400/25",
        service:
            "bg-violet-500/10 text-violet-600 ring-violet-500/20 dark:bg-violet-400/10 dark:text-violet-400 dark:ring-violet-400/25",
    };
    let mailboxes = $state<Mailbox[]>([]);
    onMount(async () => {
        mailboxes = await myMailboxes();
    });

    // Same fallback order as the mail page: URL → last explicit pick → first.
    const activeId = $derived(
        page.url.searchParams.get("mailbox") ??
            mailboxes.find((mailbox) => mailbox.id === activeMailbox.current)?.id ??
            mailboxes[0]?.id ??
            null,
    );
    const active = $derived(
        mailboxes.find((mailbox) => mailbox.id === activeId) ?? mailboxes[0],
    );

    const sidebar = useSidebar();
    function pick(id: string) {
        // Switch mailbox on the mail route; reset the open thread. On mobile the
        // sidebar is a sheet — close it so the list is visible. Remember the choice
        // so a later folder nav / reload stays on it instead of the first mailbox.
        activeMailbox.current = id;
        sidebar.setOpenMobile(false);
        goto(`${resolve("/app")}?mailbox=${id}`, { keepFocus: true });
    }

    function displayName(mailbox: Mailbox) {
      if(mailbox?.isPersonal) return "Personal";
      return mailbox?.displayName ?? mailbox?.address?.split("@")?.at(0) ?? "Mailbox"

    }
</script>

<!-- Account-type chip instead of a sender face: a mailbox is a personal, shared, or
     service box, not a person — so it reads by type/colour, not by a dicebear avatar.
     Custom-drawn mail-native set — envelope (personal) · inbox tray (shared inbox) ·
     bolt (automated/API service) — one viewBox + stroke so they read as a family;
     ring-bordered tint keeps them apart at a glance, light + dark. -->
{#snippet typeTile(kind: Kind)}
    <div
        class="flex size-8 shrink-0 items-center justify-center rounded-xl ring-1 ring-inset {tileClass[
            kind
        ]}"
    >
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.75"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="size-[18px]"
            aria-hidden="true"
        >
            {#if kind === "service"}
                <!-- bolt: automated / API sends -->
                <path d="M13.5 2.5 6 13h5l-1 8.5L18 10h-5l.5-7.5Z" />
            {:else if kind === "shared"}
                <!-- inbox tray with mail slot: a shared inbox -->
                <path
                    d="M4 12.5 6 6.5A2 2 0 0 1 7.9 5h8.2a2 2 0 0 1 1.9 1.5l2 6V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z"
                />
                <path d="M4 12.5h4l1.5 2.5h5l1.5-2.5h4" />
            {:else}
                <!-- envelope: your own mail -->
                <rect x="4" y="6" width="16" height="12" rx="2.5" />
                <path d="M5.2 9 11 13.2a2 2 0 0 0 2 0L18.8 9" />
            {/if}
        </svg>
    </div>
{/snippet}

<DropdownMenu.Root>
    <DropdownMenu.Trigger>
        {#snippet child({ props })}
            <Sidebar.MenuButton
                size="lg"
                class="data-[state=open]:bg-sidebar-accent"
                {...props}
            >
                {@render typeTile(kindOf(active))}
                <div class="grid flex-1 text-left leading-tight">
                    <span class="truncate text-sm font-medium capitalize"
                        >{displayName(active)}</span
                    >
                    <span
                        class="text-muted-foreground truncate font-mono text-xs"
                        >{active?.address ?? "…"}</span
                    >
                </div>
                <ChevronsUpDownIcon
                    class="text-muted-foreground ml-auto size-4"
                />
            </Sidebar.MenuButton>
        {/snippet}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content class="w-64" align="start" sideOffset={8}>
        <DropdownMenu.Label class="text-muted-foreground text-xs"
            >Mailboxes</DropdownMenu.Label
        >
        {#each mailboxes as mailbox (mailbox.id)}
            <DropdownMenu.Item onSelect={() => pick(mailbox.id)}>
                {@render typeTile(kindOf(mailbox))}
                <div class="grid flex-1 leading-tight">
                    <span class="text-sm capitalize"
                        >{displayName(mailbox)}</span
                    >
                    <span class="text-muted-foreground font-mono text-xs"
                        >{mailbox.address}</span
                    >
                </div>
                {#if activeId === mailbox.id}<CheckIcon class="size-4" />{/if}
            </DropdownMenu.Item>
        {/each}
    </DropdownMenu.Content>
</DropdownMenu.Root>
