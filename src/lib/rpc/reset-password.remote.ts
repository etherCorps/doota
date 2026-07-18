import { command, form, getRequestEvent } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { Password } from '$lib/shared/model/utils.zod.schema.js';
import { tryCatch } from '$lib/utils/try-catch.js';
import {
	sendPasswordResetCode,
	confirmPasswordResetCode
} from '$lib/server/password-reset.js';

// Step 1: mail a code to the user's reset target (recovery email / superadmin primary).
export const requestPasswordResetCode = command(async () => {
	const { locals } = getRequestEvent();
	if (!locals.user) error(401, 'Not authenticated');
	return sendPasswordResetCode(locals.db, locals.user);
});

const confirmSchema = z.object({
	code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
	currentPassword: z.string().min(1, 'Enter your current password'),
	newPassword: Password
});

// Step 2: require BOTH the emailed code AND the current password before changing it.
export const confirmPasswordReset = form(
	confirmSchema,
	async ({ code, currentPassword, newPassword }) => {
		const { locals, request } = getRequestEvent();
		if (!locals.user) error(401, 'Not authenticated');

		const ok = await confirmPasswordResetCode(locals.user.id, code);
		if (!ok) return { success: false, message: 'Invalid or expired code.' };

		const { error: changeError } = await tryCatch(
			locals.auth.api.changePassword({
				body: { currentPassword, newPassword, revokeOtherSessions: true },
				headers: request.headers
			})
		);
		if (changeError) {
			return {
				success: false,
				message: 'Could not change password. Check your current password and try again.'
			};
		}

		return { success: true, message: 'Password updated.' };
	}
);
