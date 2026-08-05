-- Custom SQL migration file, put your code below! --

-- Labels move from ORG scope to MAILBOX scope (privacy fix: a folder created
-- in one mailbox must not be visible — even by name — in any other mailbox).
-- Each existing label is assigned to the first mailbox that references it
-- (thread_label rows or rule actions); every OTHER referencing mailbox gets a
-- COPY with the deterministic id `orig_id || '_' || mailbox_id`, and its
-- thread_label / rule-action references are remapped to the copy. Unreferenced
-- labels are fanned out to every mailbox in their org (no data loss; users can
-- delete the clutter).

-- Drop the org-fan-out label triggers FIRST so the backfill below doesn't spam
-- org-wide change_log rows. Recreated single-mailbox at the end.
DROP TRIGGER IF EXISTS change_log_label_ins;
--> statement-breakpoint
DROP TRIGGER IF EXISTS change_log_label_upd;
--> statement-breakpoint
DROP TRIGGER IF EXISTS change_log_label_del;
--> statement-breakpoint

ALTER TABLE label ADD COLUMN mailbox_id text REFERENCES mailbox(id) ON DELETE CASCADE;
--> statement-breakpoint

-- The org-wide name uniqueness must go BEFORE the copy inserts (copies share
-- the original's org_id + name); the per-mailbox index lands after backfill.
DROP INDEX IF EXISTS label_org_name_uidx;
--> statement-breakpoint

-- Assign each REFERENCED label's original row to its first (MIN) referencing
-- mailbox. Rule references are detected by the quoted label id inside the
-- actions JSON — the same shape the remap below rewrites.
UPDATE label SET mailbox_id = (
  SELECT MIN(ref_mailbox) FROM (
    SELECT tl.mailbox_id AS ref_mailbox FROM thread_label tl WHERE tl.label_id = label.id
    UNION
    SELECT r.mailbox_id FROM rule r
    WHERE r.org_id = label.org_id AND r.actions LIKE '%"' || label.id || '"%'
  )
);
--> statement-breakpoint

-- Copies for every OTHER referencing mailbox (originals only exist so far, so
-- this reads a stable set; copies get mailbox_id at insert).
INSERT INTO label (id, org_id, mailbox_id, name, color, parent_id, notify_new_mail, created_at)
SELECT l.id || '_' || refs.ref_mailbox, l.org_id, refs.ref_mailbox, l.name, l.color, l.parent_id, l.notify_new_mail, l.created_at
FROM label l JOIN (
  SELECT tl.label_id AS ref_label, tl.mailbox_id AS ref_mailbox FROM thread_label tl
  UNION
  SELECT lbl.id, r.mailbox_id FROM rule r JOIN label lbl
    ON r.org_id = lbl.org_id AND r.actions LIKE '%"' || lbl.id || '"%'
) refs ON refs.ref_label = l.id AND refs.ref_mailbox != l.mailbox_id;
--> statement-breakpoint

-- Unreferenced labels (mailbox_id still NULL): copy to every org mailbox but
-- the MIN one…
INSERT INTO label (id, org_id, mailbox_id, name, color, parent_id, notify_new_mail, created_at)
SELECT l.id || '_' || m.id, l.org_id, m.id, l.name, l.color, l.parent_id, l.notify_new_mail, l.created_at
FROM label l JOIN mailbox m ON m.org_id = l.org_id
WHERE l.mailbox_id IS NULL
  AND m.id != (SELECT MIN(m2.id) FROM mailbox m2 WHERE m2.org_id = l.org_id);
--> statement-breakpoint

-- …and the original takes the MIN mailbox.
UPDATE label SET mailbox_id = (SELECT MIN(m.id) FROM mailbox m WHERE m.org_id = label.org_id)
WHERE mailbox_id IS NULL;
--> statement-breakpoint

-- Remap thread_label rows in non-original mailboxes to their mailbox's copy
-- (a copy exists exactly for those (label, mailbox) pairs).
UPDATE thread_label SET label_id = label_id || '_' || mailbox_id
WHERE EXISTS (
  SELECT 1 FROM label copy WHERE copy.id = thread_label.label_id || '_' || thread_label.mailbox_id
);
--> statement-breakpoint

-- Remap rule actions to the rule's mailbox's copy. One pass rewrites ONE
-- foreign label id per rule (REPLACE handles all its occurrences); rules hold
-- at most 10 actions, so 10 passes cover every rule. Quoted needles: a
-- rewritten '"id_mb"' no longer matches '"id"'.
UPDATE rule SET actions = REPLACE(actions,
  '"' || (SELECT l.id FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id) ORDER BY l.id LIMIT 1) || '"',
  '"' || (SELECT l.id FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id) ORDER BY l.id LIMIT 1) || '_' || rule.mailbox_id || '"')
WHERE EXISTS (SELECT 1 FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id));
--> statement-breakpoint
UPDATE rule SET actions = REPLACE(actions,
  '"' || (SELECT l.id FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id) ORDER BY l.id LIMIT 1) || '"',
  '"' || (SELECT l.id FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id) ORDER BY l.id LIMIT 1) || '_' || rule.mailbox_id || '"')
WHERE EXISTS (SELECT 1 FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id));
--> statement-breakpoint
UPDATE rule SET actions = REPLACE(actions,
  '"' || (SELECT l.id FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id) ORDER BY l.id LIMIT 1) || '"',
  '"' || (SELECT l.id FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id) ORDER BY l.id LIMIT 1) || '_' || rule.mailbox_id || '"')
WHERE EXISTS (SELECT 1 FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id));
--> statement-breakpoint
UPDATE rule SET actions = REPLACE(actions,
  '"' || (SELECT l.id FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id) ORDER BY l.id LIMIT 1) || '"',
  '"' || (SELECT l.id FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id) ORDER BY l.id LIMIT 1) || '_' || rule.mailbox_id || '"')
WHERE EXISTS (SELECT 1 FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id));
--> statement-breakpoint
UPDATE rule SET actions = REPLACE(actions,
  '"' || (SELECT l.id FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id) ORDER BY l.id LIMIT 1) || '"',
  '"' || (SELECT l.id FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id) ORDER BY l.id LIMIT 1) || '_' || rule.mailbox_id || '"')
WHERE EXISTS (SELECT 1 FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id));
--> statement-breakpoint
UPDATE rule SET actions = REPLACE(actions,
  '"' || (SELECT l.id FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id) ORDER BY l.id LIMIT 1) || '"',
  '"' || (SELECT l.id FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id) ORDER BY l.id LIMIT 1) || '_' || rule.mailbox_id || '"')
WHERE EXISTS (SELECT 1 FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id));
--> statement-breakpoint
UPDATE rule SET actions = REPLACE(actions,
  '"' || (SELECT l.id FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id) ORDER BY l.id LIMIT 1) || '"',
  '"' || (SELECT l.id FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id) ORDER BY l.id LIMIT 1) || '_' || rule.mailbox_id || '"')
WHERE EXISTS (SELECT 1 FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id));
--> statement-breakpoint
UPDATE rule SET actions = REPLACE(actions,
  '"' || (SELECT l.id FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id) ORDER BY l.id LIMIT 1) || '"',
  '"' || (SELECT l.id FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id) ORDER BY l.id LIMIT 1) || '_' || rule.mailbox_id || '"')
WHERE EXISTS (SELECT 1 FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id));
--> statement-breakpoint
UPDATE rule SET actions = REPLACE(actions,
  '"' || (SELECT l.id FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id) ORDER BY l.id LIMIT 1) || '"',
  '"' || (SELECT l.id FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id) ORDER BY l.id LIMIT 1) || '_' || rule.mailbox_id || '"')
WHERE EXISTS (SELECT 1 FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id));
--> statement-breakpoint
UPDATE rule SET actions = REPLACE(actions,
  '"' || (SELECT l.id FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id) ORDER BY l.id LIMIT 1) || '"',
  '"' || (SELECT l.id FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id) ORDER BY l.id LIMIT 1) || '_' || rule.mailbox_id || '"')
WHERE EXISTS (SELECT 1 FROM label l WHERE l.mailbox_id != rule.mailbox_id AND rule.actions LIKE '%"' || l.id || '"%' AND EXISTS (SELECT 1 FROM label c WHERE c.id = l.id || '_' || rule.mailbox_id));
--> statement-breakpoint

-- Parent fix, copies AND originals alike: prefer the parent's copy in this
-- label's own mailbox…
UPDATE label SET parent_id = parent_id || '_' || mailbox_id
WHERE parent_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM label pc WHERE pc.id = label.parent_id || '_' || label.mailbox_id);
--> statement-breakpoint

-- …else, when the parent lives in a different mailbox, hop to root.
UPDATE label SET parent_id = NULL
WHERE parent_id IS NOT NULL
  AND (SELECT p.mailbox_id FROM label p WHERE p.id = label.parent_id) != label.mailbox_id;
--> statement-breakpoint

CREATE UNIQUE INDEX label_mailbox_name_uidx ON label(mailbox_id, name);
--> statement-breakpoint

-- Recreate the label change_log triggers, now single-mailbox (labels are
-- mailbox-scoped; no other mailbox may even learn the name).
CREATE TRIGGER IF NOT EXISTS change_log_label_ins AFTER INSERT ON label
BEGIN
  INSERT INTO change_log (mailbox_id, type, object_id, action, created_at)
  VALUES (NEW.mailbox_id, 'Mailbox', NEW.id, 'created', cast(unixepoch('subsecond') * 1000 as integer));
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS change_log_label_upd AFTER UPDATE OF name, color ON label
BEGIN
  INSERT INTO change_log (mailbox_id, type, object_id, action, created_at)
  VALUES (NEW.mailbox_id, 'Mailbox', NEW.id, 'updated', cast(unixepoch('subsecond') * 1000 as integer));
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS change_log_label_del AFTER DELETE ON label
BEGIN
  INSERT INTO change_log (mailbox_id, type, object_id, action, created_at)
  VALUES (OLD.mailbox_id, 'Mailbox', OLD.id, 'destroyed', cast(unixepoch('subsecond') * 1000 as integer));
END;
