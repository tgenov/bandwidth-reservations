// Money is integer micros (1e-6 of the currency unit) held in bigint. No floats.

const BYTES_PER_GB = 1_000_000_000n;

/** Charge for `bytes` at `priceMicrosPerGb`, rounded half up to the nearest micro. */
export function chargeMicros(bytes: bigint, priceMicrosPerGb: bigint): bigint {
  return (bytes * priceMicrosPerGb + BYTES_PER_GB / 2n) / BYTES_PER_GB;
}

/** Bytes a reservation can carry in `seconds` at its full reserved rate. */
export function bytesAtRate(reservedMbps: number, seconds: number): bigint {
  return (BigInt(reservedMbps) * 1_000_000n * BigInt(seconds)) / 8n;
}
