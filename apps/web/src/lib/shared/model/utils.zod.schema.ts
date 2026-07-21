import { z } from 'zod';

export const Email = z.email('Invalid email address');
// better-auth enforces min 8 / max 128 server-side; keep client in sync.
export const Password = z
	.string()
	.min(8, 'Password must be at least 8 characters long')
	.max(128, 'Password must be at most 128 characters long');

export const DecimalNumber = z.number().refine((val) => val.toFixed(2))
