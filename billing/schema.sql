-- Billing: metering facts, effective-dated rates and a double-entry ledger.
-- Money is integer micros (1e-6 of the currency unit). No floats anywhere.
-- Decision log: D18 (facts), D19 (append-only corrections, exposure), D20 (split).

DROP TABLE IF EXISTS suspensions, payment_events, entries, journals, minute_charges,
  flow_records, rate_splits, rates, reservations CASCADE;
DROP FUNCTION IF EXISTS check_journal_balanced, forbid_mutation CASCADE;

-- What a customer reserved: the rate cap that bounds exposure (D19).
CREATE TABLE reservations (
  id             text PRIMARY KEY,
  customer_id    text NOT NULL,
  route_id       text NOT NULL,
  reserved_mbps  integer NOT NULL CHECK (reserved_mbps > 0)
);

-- Effective-dated prices. A later effective_from is a price change; a higher
-- version at the same effective_from corrects a mistaken price (D20).
CREATE TABLE rates (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  route_id             text NOT NULL,
  effective_from       timestamptz NOT NULL,
  version              integer NOT NULL DEFAULT 1,
  price_micros_per_gb  bigint NOT NULL CHECK (price_micros_per_gb >= 0),
  UNIQUE (route_id, effective_from, version)
);

-- How each charge is shared: every supplier on the route, plus Share's commission.
CREATE TABLE rate_splits (
  rate_id  bigint NOT NULL REFERENCES rates,
  account  text NOT NULL,
  weight   integer NOT NULL CHECK (weight > 0),
  PRIMARY KEY (rate_id, account)
);

-- Raw metering facts (D18). Immutable; the unique id is exporter + sequence.
CREATE TABLE flow_records (
  exporter_id     text NOT NULL,
  sequence        bigint NOT NULL,
  reservation_id  text NOT NULL REFERENCES reservations,
  bytes           bigint NOT NULL CHECK (bytes >= 0),
  event_time      timestamptz NOT NULL,     -- router's flow end time
  received_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (exporter_id, sequence)
);
CREATE INDEX ON flow_records (reservation_id, event_time);

-- One row per (reservation, minute) once that minute has been charged.
-- It is a lock target and a "rated" marker; amounts live only in the ledger.
CREATE TABLE minute_charges (
  reservation_id  text NOT NULL REFERENCES reservations,
  minute          timestamptz NOT NULL,
  rated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reservation_id, minute)
);

CREATE TABLE journals (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind            text NOT NULL CHECK (kind IN ('charge', 'correction', 'topup', 'payout')),
  reservation_id  text,
  minute          timestamptz,
  reference       text,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ON journals (reservation_id, minute);

-- Signed amounts: every journal sums to zero, an account's balance is the sum
-- of its entries. Wallets and supplier payables are positive when Share holds
-- or owes money; 'clearing' is the outside world (payment provider, bank).
CREATE TABLE entries (
  journal_id  bigint NOT NULL REFERENCES journals,
  account     text NOT NULL,
  amount      bigint NOT NULL CHECK (amount <> 0),
  PRIMARY KEY (journal_id, account)
);
CREATE INDEX ON entries (account);

-- Balance is enforced at COMMIT, not per row: a journal's entries are inserted
-- one by one and only the finished set has to sum to zero.
CREATE FUNCTION check_journal_balanced() RETURNS trigger AS $$
BEGIN
  IF (SELECT COALESCE(SUM(amount), 0) FROM entries WHERE journal_id = NEW.journal_id) <> 0 THEN
    RAISE EXCEPTION 'journal % does not balance', NEW.journal_id;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journal_balanced
  AFTER INSERT ON entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_journal_balanced();

-- Facts and ledger entries are append-only (D19): corrections are new rows.
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER entries_append_only BEFORE UPDATE OR DELETE ON entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER journals_append_only BEFORE UPDATE OR DELETE ON journals
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER flow_records_append_only BEFORE UPDATE OR DELETE ON flow_records
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Payment-provider webhook events, idempotent by provider transaction id + type.
CREATE TABLE payment_events (
  provider_txn_id  text NOT NULL,
  type             text NOT NULL CHECK (type IN ('completed', 'reversed')),
  customer_id      text NOT NULL,
  amount_micros    bigint NOT NULL CHECK (amount_micros > 0),
  occurred_at      timestamptz NOT NULL,
  PRIMARY KEY (provider_txn_id, type)
);

-- At most one active suspension per customer, so the suspend event is emitted once.
CREATE TABLE suspensions (
  customer_id   text PRIMARY KEY,
  reason        text NOT NULL,
  suspended_at  timestamptz NOT NULL DEFAULT now()
);
