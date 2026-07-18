// Test stub for SvelteKit's `$app/server`. Boundary functions read
// getRequestEvent().locals; tests inject a fake event via setRequestEvent().
type FakeEvent = { locals: Record<string, unknown> } & Record<string, unknown>;

let current: FakeEvent | undefined;

export function setRequestEvent(event: FakeEvent | undefined): void {
  current = event;
}

export function getRequestEvent(): FakeEvent {
  if (!current) throw new Error("test: no request event set (call setRequestEvent first)");
  return current;
}
