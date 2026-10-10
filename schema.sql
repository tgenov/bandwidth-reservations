-- Facts only: a row exists for every ACCEPTED reservation. Requests and
-- rejections belong in a separate log; they must never consume capacity.
DROP TABLE IF EXISTS reservations;
DROP TABLE IF EXISTS links;

CREATE TABLE links (
  id             bigint PRIMARY KEY,
  capacity_mbps  integer NOT NULL CHECK (capacity_mbps > 0)
);

CREATE TABLE reservations (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  link_id        bigint NOT NULL REFERENCES links,
  start_time     timestamptz NOT NULL,
  end_time       timestamptz,                       -- NULL = open-ended
  reserved_mbps  integer NOT NULL CHECK (reserved_mbps > 0),
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (end_time IS NULL OR end_time > start_time) -- half-open [start, end)
);

CREATE INDEX reservations_link_start ON reservations (link_id, start_time);
