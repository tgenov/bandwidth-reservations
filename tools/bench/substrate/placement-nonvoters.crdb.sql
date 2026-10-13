-- Substrate bench: the non-voting replicas of RFC-006 §3.2 on CockroachDB. Optional.
-- Apply after placement.crdb.sql, only on a cluster with two nodes in each of r1a, r1b, r2a, r2b and two R3 zones
-- (10 nodes or more): a range has at most one replica on a node. Non-voters do not vote, so they do not change the
-- commit latency, but they add replication work to the cost per transaction. Run the matrix with and without them.

-- Account tables: five voters, one non-voter per Kenyan facility (status reads), one standing non-voter in R3.
ALTER TABLE account_log CONFIGURE ZONE USING
  num_replicas      = 10,
  num_voters        = 5,
  constraints       = '{"+zone=r1a": 2, "+zone=r1b": 2, "+zone=r2a": 2, "+zone=r2b": 2, "+region=r3": 2}',
  voter_constraints = '{"+zone=r1a": 1, "+zone=r1b": 1, "+zone=r2a": 1, "+zone=r2b": 1, "+region=r3": 1}',
  lease_preferences = '[[+region=r1], [+region=r2]]';

ALTER TABLE account_head CONFIGURE ZONE USING
  num_replicas      = 10,
  num_voters        = 5,
  constraints       = '{"+zone=r1a": 2, "+zone=r1b": 2, "+zone=r2a": 2, "+zone=r2b": 2, "+region=r3": 2}',
  voter_constraints = '{"+zone=r1a": 1, "+zone=r1b": 1, "+zone=r2a": 1, "+zone=r2b": 1, "+region=r3": 1}',
  lease_preferences = '[[+region=r1], [+region=r2]]';

ALTER TABLE account_outbox CONFIGURE ZONE USING
  num_replicas      = 10,
  num_voters        = 5,
  constraints       = '{"+zone=r1a": 2, "+zone=r1b": 2, "+zone=r2a": 2, "+zone=r2b": 2, "+region=r3": 2}',
  voter_constraints = '{"+zone=r1a": 1, "+zone=r1b": 1, "+zone=r2a": 1, "+zone=r2b": 1, "+region=r3": 1}',
  lease_preferences = '[[+region=r1], [+region=r2]]';

ALTER TABLE account_requests CONFIGURE ZONE USING
  num_replicas      = 10,
  num_voters        = 5,
  constraints       = '{"+zone=r1a": 2, "+zone=r1b": 2, "+zone=r2a": 2, "+zone=r2b": 2, "+region=r3": 2}',
  voter_constraints = '{"+zone=r1a": 1, "+zone=r1b": 1, "+zone=r2a": 1, "+zone=r2b": 1, "+region=r3": 1}',
  lease_preferences = '[[+region=r1], [+region=r2]]';

-- Admission control tables (slot and timing): five voters and the standing R3 non-voter.
ALTER TABLE owner_slot CONFIGURE ZONE USING
  num_replicas      = 6,
  num_voters        = 5,
  constraints       = '{"+region=r3": 2}',
  voter_constraints = '{"+zone=r1a": 1, "+zone=r1b": 1, "+zone=r2a": 1, "+zone=r2b": 1, "+region=r3": 1}',
  lease_preferences = '[[+region=r1], [+region=r2]]';

ALTER TABLE platform_timing CONFIGURE ZONE USING
  num_replicas      = 6,
  num_voters        = 5,
  constraints       = '{"+region=r3": 2}',
  voter_constraints = '{"+zone=r1a": 1, "+zone=r1b": 1, "+zone=r2a": 1, "+zone=r2b": 1, "+region=r3": 1}',
  lease_preferences = '[[+region=r1], [+region=r2]]';
