// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi } from 'vitest';
import { optimistic } from './optimistic';

describe('optimistic', () => {
	it('applies, commits, and does NOT roll back on success', async () => {
		const state = { starred: false };
		const rollback = vi.fn();
		const ok = await optimistic({
			snapshot: () => state.starred,
			apply: () => (state.starred = true),
			commit: () => Promise.resolve(),
			rollback
		});
		expect(ok).toBe(true);
		expect(state.starred).toBe(true);
		expect(rollback).not.toHaveBeenCalled();
	});

	it('restores the snapshot exactly and reports failure on a server error', async () => {
		const list = ['a', 'b', 'c'];
		const snap = { idx: 1, row: 'b' };
		const onError = vi.fn();
		const ok = await optimistic({
			snapshot: () => snap,
			apply: () => list.splice(1, 1), // remove 'b'
			commit: () => Promise.reject(new Error('boom')),
			rollback: (s) => list.splice(s.idx, 0, s.row), // put it back in place
			onError
		});
		expect(ok).toBe(false);
		expect(list).toEqual(['a', 'b', 'c']); // restored exactly, not refetched
		expect(onError).toHaveBeenCalledOnce();
	});
});
