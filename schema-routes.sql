-- Route sagas (D13-D17). Applied after schema.sql. Times are minutes on the
-- discrete domain; confirmed legs become facts in the reservations table.
CREATE TABLE sagas (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idem_key    text NOT NULL UNIQUE,              -- client retries map to the same saga
  ticket_ms   bigint NOT NULL,                   -- priority ticket (D17): start time, then id
  links       bigint[] NOT NULL,
  start_min   integer NOT NULL,
  end_min     integer,                           -- NULL = open-ended
  mbps        integer NOT NULL CHECK (mbps > 0),
  status      text NOT NULL CHECK (status IN ('holding', 'committing', 'confirmed', 'rejected', 'failed')),
  result      jsonb,
  restarts    integer NOT NULL DEFAULT 0
);

CREATE TABLE holds (
  key         text PRIMARY KEY,
  saga_id     bigint NOT NULL REFERENCES sagas,
  link_id     bigint NOT NULL REFERENCES links,
  start_min   integer NOT NULL,
  end_min     integer,
  mbps        integer NOT NULL,
  expires_at  bigint NOT NULL,                   -- epoch ms
  status      text NOT NULL CHECK (status IN ('held', 'confirmed', 'released'))
);

CREATE INDEX holds_saga ON holds (saga_id);
