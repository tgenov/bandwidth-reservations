/** C08 P-01 (I1 part): the published golden vectors, and the S-PLAT runtime chain checked against them. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chainGenesis, chainNext } from '@share/owner-runtime';
import { DOMAINS, fromB64url, keyPairFromSeed, verifyObject, without, type SigningKeyCert } from '../src/index.ts';
import { GOLDEN_FILE, goldenVectors } from '../src/golden.ts';

/** A chain row as the golden file writes it: bytes in hex, 64-bit integers as decimal strings. */
interface ChainRowJson {
  kindName: string; partition: string; seq: string; slot: number; generation: number; epoch: string; entryKind: number;
  schemaV: number; identity: string; emits: string; retention: number; keyId: string; audit: string; payload: string;
}
/** The parts of the published golden file that these tests read (the first test checks the whole file). */
interface GoldenFile {
  jcs: Array<{ text: string }>;
  certificate: { cert: SigningKeyCert };
  chain: { genesis: { kindName: string; partition: string; chain: string }; links: Array<{ row: ChainRowJson; chain: string }> };
}

const published = JSON.parse(readFileSync(GOLDEN_FILE, 'utf8')) as GoldenFile;
const fromHex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, 'hex'));

test('C08 P-01: the vectors re-compute to the published file', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(goldenVectors())), published);
});

test('C08 P-01: JCS bytes follow RFC 8785 (key order, numbers, escapes)', () => {
  const [a, b, c] = published.jcs;
  assert.equal(a?.text, '{"1":1e+21,"a":{"c":0,"d":[true,null,"x"]},"b":1,"é":"é"}');
  assert.equal(b?.text, '{"committed_at":"1700000000000000","sig":"AP8QIA"}');
  assert.equal(c?.text, '{"n":[1.5,0.000001,123456789012345680000,-7],"s":"line\\nquote\\"\\u0001\u2028"}');
});

test('C08 P-01: the certificate signature verifies under the certification root', () => {
  const root = keyPairFromSeed(new Uint8Array(32).fill(1));
  const cert = published.certificate.cert;
  assert.ok(verifyObject(DOMAINS.keyCert, without(cert, 'key_service_sig'), fromB64url(cert.key_service_sig), root.publicKey));
  const tampered = { ...without(cert, 'key_service_sig'), slot: 8 };
  assert.ok(!verifyObject(DOMAINS.keyCert, tampered, fromB64url(cert.key_service_sig), root.publicKey));
});

test('C08 P-01: S-PLAT runtime chainGenesis/chainNext equal the reference chain (genesis, links, after a move)', () => {
  const ch = published.chain;
  let prev = chainGenesis(ch.genesis.kindName, fromHex(ch.genesis.partition));
  assert.equal(Buffer.from(prev).toString('hex'), ch.genesis.chain);
  for (const l of ch.links) {
    const r = l.row;
    prev = chainNext(prev, {
      kindName: r.kindName, partition: fromHex(r.partition), seq: BigInt(r.seq), slot: r.slot,
      generation: r.generation, epoch: BigInt(r.epoch), entryKind: r.entryKind, schemaV: r.schemaV,
      identity: fromHex(r.identity), emits: fromHex(r.emits), retention: r.retention, keyId: fromHex(r.keyId),
      audit: fromHex(r.audit), payload: fromHex(r.payload),
    });
    assert.equal(Buffer.from(prev).toString('hex'), l.chain, `link seq ${r.seq}`);
  }
});
