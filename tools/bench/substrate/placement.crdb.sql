-- Substrate bench: the 2 + 2 + 1 voter placement of RFC-006 §3.2 and §3.3 (RFC-000 §5.1, §5.5) on CockroachDB.
-- Apply by hand after SUBSTRATE_MODE=setup, as an admin user, to the database of the bench:
--   cockroach sql --url "$SUBSTRATE_URL" -f tools/bench/substrate/placement.crdb.sql
-- Each node must start with a locality of two tiers, region and zone. A zone is one facility:
--   R1: --locality=region=r1,zone=r1a  and  region=r1,zone=r1b
--   R2: --locality=region=r2,zone=r2a  and  region=r2,zone=r2b
--   R3: --locality=region=r3,zone=r3a  (r3b, r3c for the optional non-voters)
-- This file needs at least one node in each of r1a, r1b, r2a, r2b and r3 (5 nodes). It places the five voters
-- only. placement-nonvoters.crdb.sql adds the non-voters of §3.2; it needs two nodes in each zone.
-- Check the result with: SHOW ZONE CONFIGURATIONS; and
--   SELECT range_id, lease_holder_locality, replica_localities FROM [SHOW RANGES FROM TABLE account_head WITH DETAILS];

-- Cluster settings of RFC-006 §3.4. Start every node with --max-offset=100ms (§3.6); that is a flag, not a setting.
SET CLUSTER SETTING kv.closed_timestamp.target_duration = '1s';
SET CLUSTER SETTING kv.closed_timestamp.side_transport_interval = '200ms';
SET CLUSTER SETTING kv.rangefeed.enabled = true;

-- Every range: five voters, one per Kenyan facility and one in R3; leases in R1, then R2 (§3.2, §3.3).
ALTER RANGE default CONFIGURE ZONE USING
  num_replicas      = 5,
  num_voters        = 5,
  voter_constraints = '{"+zone=r1a": 1, "+zone=r1b": 1, "+zone=r2a": 1, "+zone=r2b": 1, "+region=r3": 1}',
  lease_preferences = '[[+region=r1], [+region=r2]]',
  gc.ttlseconds     = 14400;

-- The database's own metadata is placed like the data (§3.2).
ALTER RANGE meta CONFIGURE ZONE USING
  num_replicas      = 5,
  num_voters        = 5,
  voter_constraints = '{"+zone=r1a": 1, "+zone=r1b": 1, "+zone=r2a": 1, "+zone=r2b": 1, "+region=r3": 1}',
  lease_preferences = '[[+region=r1], [+region=r2]]';

ALTER RANGE liveness CONFIGURE ZONE USING
  num_replicas      = 5,
  num_voters        = 5,
  voter_constraints = '{"+zone=r1a": 1, "+zone=r1b": 1, "+zone=r2a": 1, "+zone=r2b": 1, "+region=r3": 1}',
  lease_preferences = '[[+region=r1], [+region=r2]]';

ALTER RANGE system CONFIGURE ZONE USING
  num_replicas      = 5,
  num_voters        = 5,
  voter_constraints = '{"+zone=r1a": 1, "+zone=r1b": 1, "+zone=r2a": 1, "+zone=r2b": 1, "+region=r3": 1}',
  lease_preferences = '[[+region=r1], [+region=r2]]';

ALTER RANGE timeseries CONFIGURE ZONE USING
  num_replicas      = 5,
  num_voters        = 5,
  voter_constraints = '{"+zone=r1a": 1, "+zone=r1b": 1, "+zone=r2a": 1, "+zone=r2b": 1, "+region=r3": 1}',
  lease_preferences = '[[+region=r1], [+region=r2]]';

ALTER DATABASE system CONFIGURE ZONE USING
  num_replicas      = 5,
  num_voters        = 5,
  voter_constraints = '{"+zone=r1a": 1, "+zone=r1b": 1, "+zone=r2a": 1, "+zone=r2b": 1, "+region=r3": 1}',
  lease_preferences = '[[+region=r1], [+region=r2]]';
