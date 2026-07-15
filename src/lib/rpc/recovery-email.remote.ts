import { form, getRequestEvent } from '$app/server';
import { error } from '@sveltejs/kit';
import { and, eq, gt } from 'drizzle-orm';
import { recoveryEmailSchema } from '$lib/shared/model/auth.zod.schema.js';
import { isServedDomain } from '$lib/server/org-domains.js';
import { sendRecoveryEmailVerification } from '$lib/server/recovery-email.js';
import * as schema from '$lib/server/db/schema.js';
import { tryCatch } from '$lib/utils/try-catch.js';

// One verification email per user per minute. This endpoint sends mail to an
// arbitrary external address, so without a throttle it could be used to bomb a
// third party. better-auth's rate limiter only covers its own routes, not this
// remote function, so the throttle lives here (reuses the verification table).
const THROTTLE_WINDOW_MS = 60_000;

export const setRecoveryEmail = form(recoveryEmailSchema, async ({ recoveryEmail }) => {
	const { locals } = getRequestEvent();
	if (!locals.user) error(401, 'Not authenticated');

	if (await isServedDomain(locals.db, recoveryEmail)) {
		return {
			success: false,
			message: 'Recovery email must be external — not on a domain this server hosts.'
		};
	}

	const throttleId = `recovery-email-throttle:${locals.user.id}`;
	const now = Date.now();
	const recent = await locals.db.query.verification.findFirst({
		where: and(
			eq(schema.verification.identifier, throttleId),
			gt(schema.verification.expiresAt, new Date(now))
		)
	});
	if (recent) {
		return {
			success: false,
			message: 'Please wait a minute before requesting another verification email.'
		};
	}

	const ctx = await locals.auth.$context;
	const { error: updateError } = await tryCatch(
		ctx.internalAdapter.updateUser(locals.user.id, {
			recoveryEmail,
			recoveryEmailVerified: false,
			recoveryEmailVerifiedAt: null
		})
	);
	if (updateError) {
		return { success: false, message: 'Unable to update recovery email.' };
	}

	await locals.db.insert(schema.verification).values({
		id: crypto.randomUUID(),
		identifier: throttleId,
		value: '1',
		expiresAt: new Date(now + THROTTLE_WINDOW_MS),
		createdAt: new Date(now),
		updatedAt: new Date(now)
	});

	await sendRecoveryEmailVerification(ctx, locals.user.id, recoveryEmail);
	return {
		success: true,
		message: 'Verification link sent. Check that inbox to confirm the address.'
	};
});
