/**
 * Ordered, append-only schema migrations. Never edit a migration that has shipped;
 * add a new one instead. Each runs once inside a transaction.
 */
export const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '001_initial',
    sql: /* sql */ `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  is_gm INTEGER NOT NULL DEFAULT 0 CHECK (is_gm IN (0, 1)),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at INTEGER NOT NULL
);

-- Exactly one inventory per role (UNIQUE role_id); deleted with its role.
CREATE TABLE inventories (
  id TEXT PRIMARY KEY,
  role_id TEXT NOT NULL UNIQUE REFERENCES roles(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

-- user_id is the primary key, so a player can hold at most one role at a time.
CREATE TABLE role_assignments (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  assigned_at INTEGER NOT NULL
);
CREATE INDEX role_assignments_role ON role_assignments(role_id);

CREATE TABLE images (
  id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE item_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image_id TEXT REFERENCES images(id) ON DELETE SET NULL,
  stackable INTEGER NOT NULL CHECK (stackable IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One row per stack (kind='stack') or per unique item instance (kind='unique').
-- For unique items the row id IS the item's instance id.
-- position holds the role's saved custom ordering.
CREATE TABLE inventory_entries (
  id TEXT PRIMARY KEY,
  inventory_id TEXT NOT NULL REFERENCES inventories(id) ON DELETE CASCADE,
  item_def_id TEXT NOT NULL REFERENCES item_definitions(id),
  kind TEXT NOT NULL CHECK (kind IN ('stack', 'unique')),
  quantity INTEGER NOT NULL CHECK (quantity > 0 AND (kind = 'stack' OR quantity = 1)),
  custom_name TEXT,
  custom_description TEXT,
  acquired_at INTEGER NOT NULL,
  position INTEGER NOT NULL
);
-- Identical stackable definitions always combine into one stack per inventory.
CREATE UNIQUE INDEX entries_one_stack_per_def ON inventory_entries(inventory_id, item_def_id) WHERE kind = 'stack';
CREATE INDEX entries_by_inventory ON inventory_entries(inventory_id, position);
CREATE INDEX entries_by_def ON inventory_entries(item_def_id);

CREATE TABLE currencies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  icon_image_id TEXT REFERENCES images(id) ON DELETE SET NULL,
  precision INTEGER NOT NULL CHECK (precision BETWEEN 0 AND 6),
  min_units INTEGER,
  max_units INTEGER,
  gauge TEXT NOT NULL DEFAULT 'none' CHECK (gauge IN ('none', 'bar', 'dial')),
  color TEXT NOT NULL DEFAULT '#b07d2b',
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (min_units IS NULL OR max_units IS NULL OR min_units <= max_units)
);

-- Balances in integer minor units (amount * 10^precision): exact, no floating point.
CREATE TABLE currency_balances (
  inventory_id TEXT NOT NULL REFERENCES inventories(id) ON DELETE CASCADE,
  currency_id TEXT NOT NULL REFERENCES currencies(id) ON DELETE CASCADE,
  units INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (inventory_id, currency_id)
);

-- Role/user columns deliberately have no foreign keys so history survives deletions.
CREATE TABLE donations (
  id TEXT PRIMARY KEY,
  sender_role_id TEXT NOT NULL,
  sender_role_name TEXT NOT NULL,
  recipient_role_id TEXT NOT NULL,
  recipient_role_name TEXT NOT NULL,
  created_by_user_id TEXT,
  created_by_username TEXT NOT NULL,
  request_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('countdown', 'pending', 'completed', 'cancelled', 'rejected', 'failed')),
  created_at INTEGER NOT NULL,
  cancel_deadline INTEGER NOT NULL,
  approval_deadline INTEGER,
  resolved_at INTEGER,
  resolved_by_user_id TEXT,
  resolved_by_username TEXT,
  resolution_note TEXT,
  CHECK (sender_role_id <> recipient_role_id)
);
CREATE UNIQUE INDEX donations_idempotency ON donations(created_by_user_id, request_id) WHERE request_id IS NOT NULL;
CREATE INDEX donations_by_status ON donations(status, cancel_deadline);
CREATE INDEX donations_by_sender ON donations(sender_role_id, status);
CREATE INDEX donations_by_recipient ON donations(recipient_role_id, status);
CREATE INDEX donations_by_created ON donations(created_at);

CREATE TABLE donation_lines (
  id TEXT PRIMARY KEY,
  donation_id TEXT NOT NULL REFERENCES donations(id),
  line_no INTEGER NOT NULL,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('stack', 'unique', 'currency')),
  item_def_id TEXT,
  entry_id TEXT,
  currency_id TEXT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  precision INTEGER,
  name_snapshot TEXT NOT NULL,
  image_id TEXT
);
CREATE INDEX donation_lines_by_donation ON donation_lines(donation_id, line_no);

-- Active holds on assets while a donation is in its countdown or pending state.
-- Rows are deleted when the donation resolves. Reserved assets remain owned by the sender.
CREATE TABLE asset_reservations (
  id TEXT PRIMARY KEY,
  donation_id TEXT NOT NULL REFERENCES donations(id),
  line_id TEXT NOT NULL REFERENCES donation_lines(id),
  inventory_id TEXT NOT NULL REFERENCES inventories(id) ON DELETE CASCADE,
  asset_type TEXT NOT NULL CHECK (asset_type IN ('stack', 'unique', 'currency')),
  entry_id TEXT REFERENCES inventory_entries(id),
  currency_id TEXT REFERENCES currencies(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  created_at INTEGER NOT NULL,
  CHECK ((entry_id IS NULL) <> (currency_id IS NULL))
);
-- A unique item can never be held by two donations at once.
CREATE UNIQUE INDEX reservations_one_per_unique ON asset_reservations(entry_id) WHERE asset_type = 'unique';
CREATE INDEX reservations_by_entry ON asset_reservations(entry_id);
CREATE INDEX reservations_by_currency ON asset_reservations(inventory_id, currency_id);
CREATE INDEX reservations_by_donation ON asset_reservations(donation_id);

-- Permanent audit log. No foreign keys: names are snapshotted so records survive deletions.
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('donation', 'gm', 'inventory', 'auth', 'system')),
  action TEXT NOT NULL,
  actor_user_id TEXT,
  actor_username TEXT,
  actor_is_gm INTEGER NOT NULL DEFAULT 0,
  role_id TEXT,
  role_name TEXT,
  counterparty_role_id TEXT,
  counterparty_role_name TEXT,
  donation_id TEXT,
  summary TEXT NOT NULL,
  details TEXT
);
CREATE INDEX audit_by_time ON audit_events(at);
CREATE INDEX audit_by_actor ON audit_events(actor_user_id);
CREATE INDEX audit_by_role ON audit_events(role_id);
CREATE INDEX audit_by_counterparty ON audit_events(counterparty_role_id);
CREATE INDEX audit_by_donation ON audit_events(donation_id);
CREATE INDEX audit_by_action ON audit_events(action);

CREATE TABLE audit_event_assets (
  event_id INTEGER NOT NULL REFERENCES audit_events(id),
  asset_type TEXT NOT NULL CHECK (asset_type IN ('item', 'currency')),
  asset_id TEXT NOT NULL,
  asset_name TEXT NOT NULL,
  instance_id TEXT,
  quantity TEXT
);
CREATE INDEX audit_assets_by_asset ON audit_event_assets(asset_type, asset_id);
CREATE INDEX audit_assets_by_event ON audit_event_assets(event_id);

-- Audit records are append-only, enforced by the database itself.
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'Audit records are immutable'); END;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'Audit records are immutable'); END;
CREATE TRIGGER audit_assets_no_update BEFORE UPDATE ON audit_event_assets
BEGIN SELECT RAISE(ABORT, 'Audit records are immutable'); END;
CREATE TRIGGER audit_assets_no_delete BEFORE DELETE ON audit_event_assets
BEGIN SELECT RAISE(ABORT, 'Audit records are immutable'); END;

-- Donation records are history too: they can change state but never be deleted.
CREATE TRIGGER donations_no_delete BEFORE DELETE ON donations
BEGIN SELECT RAISE(ABORT, 'Donation records cannot be deleted'); END;
CREATE TRIGGER donation_lines_no_delete BEFORE DELETE ON donation_lines
BEGIN SELECT RAISE(ABORT, 'Donation records cannot be deleted'); END;

INSERT INTO settings (key, value) VALUES ('approval_required', 'false');
`,
  },
];
