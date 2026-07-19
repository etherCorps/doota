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
			<svg width="52" height="52" viewBox="0 0 32 32" fill="none">
				<path
					d="M9 4h14a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5h-9l-6 4v-4H9a5 5 0 0 1-5-5V9a5 5 0 0 1 5-5Z"
					fill="#3b93f0"
				/>
				<path
					d="M9.5 11 16 15.5 22.5 11"
					stroke="#fff"
					stroke-width="2.2"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
			</svg>
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
			github.com/ethercorps/doota
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
