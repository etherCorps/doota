// SPDX-License-Identifier: Apache-2.0
// Shared realtime-event bus. <RealtimeSync/> (mounted once in the app layout) is
// the SOLE subscriber to the mailEvents live stream; it publishes each event
// here, and every consumer (mail page, bell, failure notifier) reacts to this
// store instead of opening its own subscription. `seq` bumps on every event so
// two identical back-to-back events (e.g. two replies in the same thread) still
// retrigger effects that read it.

import type { MailEvent } from "@doota/mail-core/events-hub";

export const realtime = $state<{ event: MailEvent | null; seq: number }>({ event: null, seq: 0 });

export function publishMailEvent(event: MailEvent): void {
	realtime.event = event;
	realtime.seq++;
}
