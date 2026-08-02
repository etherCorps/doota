// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect } from 'vitest';
import { swipeCommit } from '$lib/utils/swipe';

// Guards the trash-folder regression: a right-committed swipe dragged back past
// zero must not animate or fire in the (unhandled) left direction.
describe('swipeCommit direction lock', () => {
	const T = 72;
	it('follows + fires in the committed direction past threshold', () => {
		expect(swipeCommit(80, 1, T)).toEqual({ eff: 80, fire: true });
		expect(swipeCommit(-80, -1, T)).toEqual({ eff: -80, fire: true });
	});
	it('below threshold moves but does not fire', () => {
		expect(swipeCommit(40, 1, T)).toEqual({ eff: 40, fire: false });
	});
	it('reversing past zero into the other direction is ignored (no move, no fire)', () => {
		expect(swipeCommit(-90, 1, T)).toEqual({ eff: 0, fire: false }); // committed right, dragged left
		expect(swipeCommit(90, -1, T)).toEqual({ eff: 0, fire: false }); // committed left, dragged right
	});
});
