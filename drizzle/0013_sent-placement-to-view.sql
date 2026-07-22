-- Sent becomes a VIEW (threads with a role-'from' delivery for the mailbox),
-- not a placement. Existing 'sent' placements map to 'archived' — Gmail's
-- "no Inbox label" state; the Sent folder still lists them via the delivery.
UPDATE thread_state SET placement = 'archived' WHERE placement = 'sent';
