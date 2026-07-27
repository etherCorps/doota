<!-- SPDX-License-Identifier: Apache-2.0 -->
<!--
	Social share card — 1200×630, rendered to og.png by /og.png/+server.ts (takumi).
	Takumi is Satori-style: NO Tailwind / external CSS, so every style is inline.
	Only the fonts loaded in +server.ts exist here (Bricolage Grotesque 800 for display,
	Inter 400/600 for body + labels). Containers with >1 child use explicit display:flex.
	Avoid blur(), mask-image, and raw &/</> entities; all unreliable in this renderer.
-->
<div
	style="position:relative;display:flex;flex-direction:column;justify-content:space-between;width:100%;height:100%;overflow:hidden;background:#0f1218;color:#e9ecf1;font-family:'Inter'"
>
	<!-- backdrop: faint grid + soft color fields (no blur/mask) -->
	<div
		style="position:absolute;inset:0;display:flex;background-image:linear-gradient(to right,#20252f 1px,transparent 1px),linear-gradient(to bottom,#20252f 1px,transparent 1px);background-size:56px 56px;opacity:.35"
	></div>
	<div
		style="position:absolute;top:-220px;right:-180px;display:flex;height:680px;width:680px;background:radial-gradient(circle,#3b93f04d,transparent 62%)"
	></div>
	<div
		style="position:absolute;bottom:-240px;right:120px;display:flex;height:560px;width:560px;background:radial-gradient(circle,#8b5cf63d,transparent 62%)"
	></div>

	<!-- top row: brand + coming soon -->
	<div
		style="position:relative;display:flex;align-items:center;justify-content:space-between;padding:64px 72px 0"
	>
		<div style="display:flex;align-items:center;gap:16px">
			<!-- Doota brand tile. Embedded as a data-URI PNG because takumi rasterises
			     inline <svg> transforms unreliably. -->
			<img
				width="56"
				height="56"
				alt="Doota"
				src="data:image/png;base64,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"
			/>
			<span style="font-family:'Bricolage Grotesque';font-size:40px;font-weight:800;letter-spacing:-0.02em">Doota</span>
		</div>
		<div
			style="display:flex;align-items:center;gap:10px;border:1px solid #2b313c;background:#171b22;color:#9aa1ad;border-radius:9999px;padding:8px 16px;font-size:18px;font-weight:600"
		>
			<div style="display:flex;height:8px;width:8px;border-radius:9999px;background:#3b93f0"></div>
			Coming soon
		</div>
	</div>

	<!-- headline -->
	<div style="position:relative;display:flex;flex-direction:column;padding:0 72px">
		<div style="display:flex;flex-direction:column;font-family:'Bricolage Grotesque';font-size:92px;font-weight:800;letter-spacing:-0.03em;line-height:1.02">
			<span style="display:flex">Your email,</span>
			<span
				style="display:flex;background:linear-gradient(90deg,#3b93f0,#8b5cf6,#06b6d4);background-clip:text;-webkit-background-clip:text;color:transparent"
				>finally yours.</span
			>
		</div>
		<div style="display:flex;margin-top:24px;max-width:820px;font-size:30px;line-height:1.3;color:#9aa1ad">
			Email as a conversation.
		</div>
	</div>

	<!-- bottom row: repo + open source -->
	<div
		style="position:relative;display:flex;align-items:center;justify-content:space-between;padding:0 72px 64px;font-size:22px"
	>
		<div style="display:flex;align-items:center;gap:12px;color:#c6ccd6;font-family:'Inter'">
			<svg width="26" height="26" viewBox="0 0 16 16" fill="#c6ccd6">
				<path
					d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
				/>
			</svg>
			ethercorps/doota
		</div>
		<div
			style="display:flex;align-items:center;gap:10px;border:1px solid #2b313c;background:#171b22;color:#e9ecf1;border-radius:9999px;padding:10px 20px;font-weight:600"
		>
			<svg width="22" height="22" viewBox="0 0 24 24" fill="#f5b301">
				<path
					d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
				/>
			</svg>
			Free and open source
		</div>
	</div>
</div>
