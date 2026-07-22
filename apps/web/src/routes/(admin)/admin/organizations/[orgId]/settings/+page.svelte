<script lang="ts">
	import { untrack, onMount } from 'svelte';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import * as Card from '$lib/components/ui/card/index.js';
	import * as Field from '$lib/components/ui/field/index.js';
	import { Button } from '$lib/components/ui/button/index.js';
	import { Input } from '$lib/components/ui/input/index.js';
	import { Spinner } from '$lib/components/ui/spinner/index.js';
	import { Skeleton } from '$lib/components/ui/skeleton/index.js';
	import BadgeCheckIcon from '@lucide/svelte/icons/badge-check';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import PageHeader from '$lib/components/admin/page-header.svelte';
	import { updateOrgProfile, bimiStatus, publishBimi } from '$lib/rpc/domains.remote.js';

	let { data } = $props();
	const org = $derived(data.org);

	// Editable copies seeded from the load once; the form owns them thereafter.
	let name = $state(untrack(() => data.org.name));
	let logo = $state(untrack(() => data.org.logo ?? ''));
	let saving = $state(false);

	async function save() {
		saving = true;
		try {
			await updateOrgProfile({ orgId: org.id, name: name.trim(), logo: logo.trim() });
			toast.success('Organization updated.');
			await invalidateAll();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not save.');
		} finally {
			saving = false;
		}
	}

	// BIMI — DNS state is superadmin-only; org admins see the profile card but
	// not the publish controls (the status call 403s for them).
	type Bimi = Awaited<ReturnType<typeof bimiStatus>>;
	let bimi = $state<Bimi | null>(null);
	let bimiLoading = $state(true);
	let bimiDenied = $state(false);
	let bimiLogo = $state('');
	let vmc = $state('');
	let publishing = $state(false);
	let uploading = $state(false);
	let svgInput = $state<HTMLInputElement>();

	// Upload → we validate (Tiny-PS + safety) and host the SVG from R2; the
	// returned stable URL drops straight into the l= field.
	async function uploadSvg(e: Event) {
		const input = e.target as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		uploading = true;
		try {
			const fd = new FormData();
			fd.append('file', file);
			const res = await fetch(`/api/bimi/${org.id}.svg`, { method: 'POST', body: fd });
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { message?: string } | null;
				toast.error(body?.message ?? 'Upload failed.');
				return;
			}
			const { url } = (await res.json()) as { url: string };
			bimiLogo = url;
			toast.success('Logo uploaded — publish the DNS record to go live.');
		} finally {
			uploading = false;
		}
	}

	onMount(async () => {
		try {
			bimi = await bimiStatus(org.id);
			// Prefill: the published record wins; else the org's profile logo.
			bimiLogo = bimi.logoUrl || untrack(() => logo);
			vmc = bimi.vmcUrl;
		} catch {
			bimiDenied = true;
		} finally {
			bimiLoading = false;
		}
	});

	async function publish() {
		publishing = true;
		try {
			const res = await publishBimi({ orgId: org.id, logoUrl: bimiLogo.trim(), vmcUrl: vmc.trim() });
			if (!res.success) {
				toast.error(res.message);
				return;
			}
			toast.success('BIMI record published.');
			bimi = await bimiStatus(org.id);
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not publish the record.');
		} finally {
			publishing = false;
		}
	}
</script>

<div class="flex flex-col gap-4">
	<PageHeader
		title="Settings"
		description="Organization profile — the display name and logo. A verified logo improves mail branding (BIMI) in inboxes."
	/>
	<!-- Stacked on small screens; profile + BIMI sit side by side from xl up
	     (each card is a self-contained form, so row order carries no meaning). -->
	<div class="grid items-start gap-4 xl:grid-cols-2">
	<Card.Card class="max-w-2xl xl:max-w-none">
		<Card.CardContent class="space-y-4 pt-6">
		<Field.Field>
			<Field.Label>Domain</Field.Label>
			<Input value={org.domain} readonly class="font-mono" />
			<Field.Description>The domain is fixed — it identifies the organization.</Field.Description>
		</Field.Field>
		<Field.Field>
			<Field.Label>Name</Field.Label>
			<Input bind:value={name} placeholder="Acme Inc" />
		</Field.Field>
		<Field.Field>
			<Field.Label>Logo URL</Field.Label>
			<Input bind:value={logo} placeholder="https://acme.com/logo.svg" type="url" />
			<Field.Description>
				Public HTTPS URL. BIMI requires a square SVG Tiny-PS for the verified-logo badge.
			</Field.Description>
		</Field.Field>
		<div class="flex justify-end">
			<Button disabled={saving || !name.trim()} onclick={save}>
				{#if saving}<Spinner class="mr-1" />{/if}
				Save
			</Button>
		</div>
	</Card.CardContent>
	</Card.Card>

	<!-- BIMI — publishes the default._bimi TXT record so inboxes show the logo. -->
	{#if !bimiDenied}
		<Card.Card class="max-w-2xl xl:max-w-none">
			<Card.CardHeader>
				<Card.CardTitle class="flex items-center gap-2">
					<BadgeCheckIcon class="text-brand size-4" /> BIMI verified logo
				</Card.CardTitle>
				<Card.CardDescription>
					Publishes a TXT record at <code class="font-mono">default._bimi.{org.domain}</code> so
					Gmail, Yahoo and others can show your logo next to messages.
				</Card.CardDescription>
			</Card.CardHeader>
			<Card.CardContent class="space-y-4">
				{#if bimiLoading}
					<div class="space-y-3">
						<Skeleton class="h-9 w-full rounded-lg" />
						<Skeleton class="h-9 w-full rounded-lg" />
						<Skeleton class="ml-auto h-8 w-32 rounded-lg" />
					</div>
				{:else if bimi}
					{#if !bimi.dmarcOk}
						<div class="border-warn/40 bg-warn/10 text-warn flex items-start gap-2 rounded-xl border px-3 py-2 text-sm">
							<TriangleAlertIcon class="mt-0.5 size-4 shrink-0" />
							<span>
								DMARC is {bimi.dmarcPolicy ? `at p=${bimi.dmarcPolicy}` : 'not published'} for
								{org.domain}. Providers only show BIMI logos when DMARC enforces
								<code class="font-mono">p=quarantine</code> or <code class="font-mono">p=reject</code>.
							</span>
						</div>
					{/if}
					<Field.Field>
						<Field.Label>Logo URL (SVG Tiny-PS)</Field.Label>
						<div class="flex gap-2">
							{#if bimiLogo.trim().startsWith('https://')}
								<!-- <img> is script-inert — safe preview even for an unvalidated
								     external URL (scripts/handlers never run in an image context). -->
								<img
									src={bimiLogo.trim()}
									alt="BIMI logo preview"
									class="size-9 shrink-0 rounded-lg border bg-white object-contain p-1"
								/>
							{/if}
							<Input bind:value={bimiLogo} placeholder="https://acme.com/bimi-logo.svg" type="url" class="min-w-0 flex-1" />
							<Button variant="outline" disabled={uploading} onclick={() => svgInput?.click()}>
								{#if uploading}<Spinner class="mr-1" />{/if}
								Upload SVG
							</Button>
							<input bind:this={svgInput} type="file" accept="image/svg+xml,.svg" class="hidden" onchange={uploadSvg} />
						</div>
						<Field.Description>
							Upload a square SVG Tiny-PS (≤ 32 KB) and we host it at a stable public URL — or paste
							a public HTTPS URL you host yourself.
						</Field.Description>
					</Field.Field>
					<Field.Field>
						<Field.Label>VMC certificate URL (optional)</Field.Label>
						<Input bind:value={vmc} placeholder="https://acme.com/vmc.pem" type="url" />
						<Field.Description>
							Verified Mark Certificate for the blue check. Leave empty to publish without one.
						</Field.Description>
					</Field.Field>
					<!-- ponytail: native details/summary — no accordion component needed. -->
					<details class="bg-muted/40 rounded-xl border px-3 py-2 text-sm">
						<summary class="text-muted-foreground hover:text-foreground cursor-pointer text-xs font-medium select-none">
							How do I create a BIMI SVG?
						</summary>
						<div class="text-muted-foreground mt-2 space-y-2 text-xs leading-relaxed">
							<p class="text-foreground font-medium">Requirements (the upload checks all of these):</p>
							<ul class="list-disc space-y-1 pl-4">
								<li>SVG Tiny-PS profile: <code class="font-mono">version="1.2" baseProfile="tiny-ps"</code> on the root element.</li>
								<li>A <code class="font-mono">&lt;title&gt;</code> element containing your brand name.</li>
								<li>Square canvas (<code class="font-mono">viewBox</code>) with a <span class="text-foreground font-medium">solid background color</span> — inboxes crop the tile into a circle, so transparency renders unpredictably.</li>
								<li>No scripts, event handlers, embedded images, external references, or <code class="font-mono">@import</code>. 32&nbsp;KB max.</li>
							</ul>
							<p class="text-foreground font-medium">Converting an existing logo:</p>
							<ol class="list-decimal space-y-1 pl-4">
								<li>Export your vector logo as SVG (Figma, Illustrator, Inkscape).</li>
								<li>Set the two root attributes above, add the <code class="font-mono">&lt;title&gt;</code>, and put a full-size <code class="font-mono">&lt;rect&gt;</code> in your brand color behind the mark.</li>
								<li>Keep the mark bold and centered with ~10–15% padding — it renders at 16–96px in a circle, so fine strokes and small text disappear.</li>
								<li>Minify with <code class="font-mono">npx svgo logo.svg</code> if it's large, then check it with the
									<a href="https://bimigroup.org/svg-conversion-tools-released/" target="_blank" rel="noreferrer" class="text-brand underline underline-offset-2">BIMI Group validator</a>
									— the upload here also tells you exactly what's wrong.</li>
							</ol>
						</div>
					</details>
					<details class="bg-muted/40 rounded-xl border px-3 py-2 text-sm">
						<summary class="text-muted-foreground hover:text-foreground cursor-pointer text-xs font-medium select-none">
							How do I get a VMC certificate?
						</summary>
						<ol class="text-muted-foreground mt-2 list-decimal space-y-1.5 pl-4 text-xs leading-relaxed">
							<li>
								<span class="text-foreground font-medium">Trademark the logo.</span>
								A VMC requires the logo to be a registered trademark (USPTO, EUIPO, UKIPO, and
								others are accepted). No trademark? A
								<span class="text-foreground font-medium">Common Mark Certificate (CMC)</span>
								works if the exact logo has been in use for 12+ months — it shows your logo in
								Gmail, just without the blue checkmark.
							</li>
							<li>
								<span class="text-foreground font-medium">Buy from an issuing CA.</span>
								Only two exist:
								<a href="https://www.digicert.com/tls-ssl/verified-mark-certificates" target="_blank" rel="noreferrer" class="text-brand underline underline-offset-2">DigiCert</a>
								or
								<a href="https://www.entrust.com/products/digital-signing-certificates/verified-mark-certificates" target="_blank" rel="noreferrer" class="text-brand underline underline-offset-2">Entrust</a>
								(roughly $1,000–1,500/year). You'll submit this exact SVG Tiny-PS file plus your
								organization and trademark details for validation.
							</li>
							<li>
								<span class="text-foreground font-medium">Host the PEM they issue.</span>
								The CA returns a certificate chain (<code class="font-mono">.pem</code>). Put it on
								a public HTTPS URL, paste that URL above, and republish the record.
							</li>
							<li>
								<span class="text-foreground font-medium">Don't change the logo afterwards.</span>
								The certificate binds to the exact SVG bytes — any edit to the logo needs a
								reissued certificate.
							</li>
						</ol>
					</details>
					{#if bimi.published && bimi.record}
						<div class="space-y-1">
							<p class="text-ok inline-flex items-center gap-1.5 text-xs font-medium">
								<BadgeCheckIcon class="size-3.5" /> Published
							</p>
							<pre class="bg-muted/60 scrollbar-thin overflow-x-auto rounded-lg border px-3 py-2 font-mono text-xs">{bimi.host}  TXT  {bimi.record}</pre>
						</div>
					{/if}
					<div class="flex justify-end">
						<Button variant="brand" disabled={publishing || !bimiLogo.trim()} onclick={publish}>
							{#if publishing}<Spinner class="mr-1" />{/if}
							{bimi.published ? 'Update DNS record' : 'Publish DNS record'}
						</Button>
					</div>
				{/if}
			</Card.CardContent>
		</Card.Card>
	{/if}
	</div>
</div>
