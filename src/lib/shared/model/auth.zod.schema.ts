import { z } from 'zod';
import { Email, Password } from './utils.zod.schema';

export const loginSchema = z.object({
	email: Email,
	password: Password
});

// Bootstrap: the first user is the EXTERNAL super-admin. Their login email is
// their external address, so there is no separate recovery email to collect.
export const registerSchema = z.object({
	email: Email,
	password: Password,
	name: z
		.string()
		.min(2, 'Name must be at least 2 characters long')
		.max(30, 'Name must be at most 30 characters long')
});

export const recoveryEmailSchema = z.object({
	recoveryEmail: Email
});

export type LoginData = z.infer<typeof loginSchema>;
export type RegisterData = z.infer<typeof registerSchema>;
