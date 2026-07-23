// Unread-inbox count, shared between the mail page (writer: fetches + reacts
// to live inbound events) and the sidebar badge / title (readers).
export const unread = $state({ count: 0 });
