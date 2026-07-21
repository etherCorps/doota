import { form, getRequestEvent } from '$app/server';
import { error } from '@sveltejs/kit';
import { z } from 'zod';
import { Password } from '$lib/shared/model/utils.zod.schema.js';
import { setUserAuthFlags } from '$lib/server/auth/escape-hatches.js';
import { tryCatch } from '$lib/utils/try-catch.js';

const changePasswordSchema = z.object({
	currentPassword: z.string().min(1, 'Enter your current password'),
	newPassword: Password
});

// Changes the password AND clears the temp-password onboarding gate. Goes
// through better-auth so the current password is actually verified — we don't
// clear the flag on an unproven request.
export const changeInitialPassword = form(
	changePasswordSchema,
	async ({ currentPassword, newPassword }) => {
		const { locals, request } = getRequestEvent();
		if (!locals.user) error(401, 'Not authenticated');

		const { error: changeError } = await tryCatch(
			locals.auth.api.changePassword({
				body: { currentPassword, newPassword, revokeOtherSessions: false },
				headers: request.headers
			})
		);
		if (changeError) {
			return {
				success: false,
				message: 'Could not change password. Check your current password and try again.'
			};
		}

		await setUserAuthFlags(locals.user.id, { mustChangePassword: false });

		return { success: true, message: 'Password updated.' };
	}
);
