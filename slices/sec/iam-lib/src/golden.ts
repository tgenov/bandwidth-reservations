/**
 * C08 P-01 golden vectors (I1 part): JCS bytes, certificate signature, key-record, edge-record and heartbeat
 * signatures, chain genesis and chain links (incl. a link after a move). Fixed inputs only.
 *
 * The seeds below are PUBLIC test-vector seeds. They are not secrets and no service uses them.
 * Regenerate the published file with:  node slices/sec/iam-lib/src/golden.ts --write
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { genesis, link, type ChainInput } from './chain.ts';
import { b64url, jcs, jcsText, without } from './jcs.ts';
import { DOMAINS, keyPairFromSeed, signingInput, signObject } from './sign.ts';
import type { CredentialRecord, Heartbeat, SignedKeyRecord, SigningKeyCert } from './types.ts';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const seed = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);
const utf8 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'utf8'));

export const VECTOR_SEEDS = { certificationRoot: '01'.repeat(32), identityRecordKey: '02'.repeat(32) };

export function goldenVectors(): Record<string, unknown> {
  const root = keyPairFromSeed(seed(1));
  const rec = keyPairFromSeed(seed(2));

  const jcsInputs: Array<{ name: string; value: unknown }> = [
    { name: 'key_order_and_nesting', value: { b: 1, a: { d: [true, null, 'x'], c: -0 }, 'é': 'é', '1': 1e21 } },
    { name: 'bigint_and_bytes', value: { committed_at: 1_700_000_000_000_000n, sig: new Uint8Array([0, 255, 16, 32]) } },
    { name: 'escapes_and_numbers', value: { s: 'line\nquote"\u0001 ', n: [1.5, 0.000001, 123456789012345680000, -7] } },
  ];

  const unsignedCert: Omit<SigningKeyCert, 'key_service_sig'> = {
    key_id: 'identity-7-epoch-3', purpose: 'identity_record', owner_kind: 'identity', slot: 7, epoch: '3',
    public_key: b64url(rec.publicKey), not_before: 1_700_000_000_000_000n, not_after: 1_700_086_400_000_000n,
  };
  const cert: SigningKeyCert = { ...unsignedCert, key_service_sig: b64url(signObject(DOMAINS.keyCert, unsignedCert, root.privateKey)) };

  const limits = { key_spend_limit_micro_usd: 5_000_000_000n, key_inflight_limit_mbps: null, key_rate_limit_per_s: 50 };
  const unsignedKeyRecord: Omit<SignedKeyRecord, 'signature'> = {
    key_id: '00112233445566778899aabbccddeeff', identity_slot: 7, epoch: '3',
    tenant: { kind: 'account', account: 'b1' }, status: 'active', limits, version: 1,
    committed_at: 1_700_000_001_000_000n, probe: false,
  };
  const keyRecordSig = signObject(DOMAINS.keyRecord, unsignedKeyRecord, rec.privateKey);

  const unsignedEdgeRecord: Omit<CredentialRecord, 'signature'> = {
    identity_slot: 7, epoch: '3', position: '1', committed_at: 1_700_000_001_000_000n, version: 1,
    body: { kind: 'agent_key', key_id: '00112233445566778899aabbccddeeff', verifier_sha256: b64url(new Uint8Array(32).fill(9)),
            tenant: { kind: 'account', account: 'b1' }, limits, status: 'active', probe: false },
  };
  const edgeRecordSig = signObject(DOMAINS.edgeRecord, unsignedEdgeRecord, rec.privateKey);

  const unsignedHeartbeat: Omit<Heartbeat, 'signature'> = { identity_slot: 7, epoch: '3', head: '1', sent_at: 1_700_000_002_000_000n };
  const heartbeatSig = signObject(DOMAINS.edgeHeartbeat, unsignedHeartbeat, rec.privateKey);

  const partition = utf8('account/b1');
  const g = genesis('iam', partition);
  const row1: ChainInput = {
    kindName: 'iam', partition, seq: 1n, slot: 7, generation: 0, epoch: 3n, entryKind: 1, schemaV: 1,
    identity: utf8('issue:00112233445566778899aabbccddeeff'), emits: utf8('[]'), retention: 0,
    keyId: utf8('dev:iam_log'), audit: new Uint8Array([1, 2, 3]), payload: new Uint8Array([4, 5, 6]),
  };
  const c1 = link(g, row1);
  const row2: ChainInput = { ...row1, seq: 2n, entryKind: 2, identity: utf8('revoke:00112233445566778899aabbccddeeff') };
  const c2 = link(c1, row2);
  // After a move: the partition is adopted in slot 12 with generation 1 and a new epoch.
  const row3: ChainInput = { ...row1, seq: 3n, slot: 12, generation: 1, epoch: 1n, entryKind: -1, identity: utf8('takeover') };
  const c3 = link(c2, row3);

  const rowJson = (r: ChainInput): Record<string, unknown> => ({
    kindName: r.kindName, partition: hex(r.partition), seq: r.seq.toString(), slot: r.slot, generation: r.generation,
    epoch: r.epoch.toString(), entryKind: r.entryKind, schemaV: r.schemaV, identity: hex(r.identity), emits: hex(r.emits),
    retention: r.retention, keyId: hex(r.keyId), audit: hex(r.audit), payload: hex(r.payload),
  });

  return {
    contract: 'C08 v1.2',
    test: 'P-01 (S-SEC I1 part)',
    encoding: {
      signed_bytes: 'UTF-8(domain) || E(JCS(object without its signature field)); E(x) = U32BE(len) || x',
      jcs: 'RFC 8785; bigint as decimal string; bytes as base64url without padding; undefined fields absent',
      chain_entry_kind: 'int16 written as two\'s-complement U16',
    },
    seeds: VECTOR_SEEDS,
    public_keys: { certificationRoot: hex(root.publicKey), identityRecordKey: hex(rec.publicKey) },
    jcs: jcsInputs.map(({ name, value }) => ({ name, text: jcsText(value), hex: hex(jcs(value)) })),
    certificate: {
      cert: JSON.parse(jcsText(cert)) as unknown,
      signing_input_hex: hex(signingInput(DOMAINS.keyCert, without(cert, 'key_service_sig'))),
      key_service_sig_hex: hex(Buffer.from(cert.key_service_sig, 'base64url')),
    },
    key_record: {
      unsigned: JSON.parse(jcsText(unsignedKeyRecord)) as unknown,
      signing_input_hex: hex(signingInput(DOMAINS.keyRecord, unsignedKeyRecord)),
      sig_hex: hex(keyRecordSig),
    },
    edge_record: {
      unsigned: JSON.parse(jcsText(unsignedEdgeRecord)) as unknown,
      signing_input_hex: hex(signingInput(DOMAINS.edgeRecord, unsignedEdgeRecord)),
      sig_hex: hex(edgeRecordSig),
    },
    heartbeat: {
      unsigned: JSON.parse(jcsText(unsignedHeartbeat)) as unknown,
      signing_input_hex: hex(signingInput(DOMAINS.edgeHeartbeat, unsignedHeartbeat)),
      sig_hex: hex(heartbeatSig),
    },
    chain: {
      genesis: { kindName: 'iam', partition: hex(partition), chain: hex(g) },
      links: [
        { row: rowJson(row1), chain: hex(c1) },
        { row: rowJson(row2), chain: hex(c2) },
        { row: rowJson(row3), chain: hex(c3), note: 'after a move: slot 12, generation 1, epoch 1' },
      ],
    },
  };
}

export const GOLDEN_FILE = fileURLToPath(new URL('../golden/c08-p01-i1.json', import.meta.url));

if (process.argv.includes('--write') && process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(GOLDEN_FILE, `${JSON.stringify(goldenVectors(), null, 2)}\n`);
  process.stdout.write(`wrote ${GOLDEN_FILE}\n`);
}
