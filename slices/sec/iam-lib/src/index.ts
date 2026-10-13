/** @share/iam-lib — the C1/C2 library of S-SEC (C08 v1.2 §A types, `decide`, context, certificates, chain). */
export * from './types.ts';
export { b64url, fromB64url, frame, jcs, jcsText, without } from './jcs.ts';
export {
  DOMAINS, generateKeyPair, keyPairFromSeed, publicKeyObject, signingInput, signObject, verifyObject,
  type Domain, type Ed25519KeyPair,
} from './sign.ts';
export { CertStore, CERT_STALENESS_MAX_MICROS, type CertRequirement, type CertVerdict } from './certs.ts';
export { OPS, decide, matrixDigest, policyV1, sameTenant, type UnsignedPolicyBundle } from './policy.ts';
export {
  CONTEXT_METADATA_KEY, CONTEXT_TTL_MICROS, auditFromContext, checkContext, contextText, decodeContext, encodeContext,
  internalAudit, keyRecordValid, type AppliedKey, type ContextVerdict, type ReceiverEnv,
} from './context.ts';
export { mintKey, parseKey, secretMatches, verifierOf, type ParsedKey } from './credential.ts';
export { genesis, link, verifyChains, type ChainBreak, type ChainInput, type ChainedRow } from './chain.ts';
export { tenantFromText, tenantText, toRuntimeAudit } from './runtime-audit.ts';
export { hlcToMicros, tenantPartition } from './util.ts';
