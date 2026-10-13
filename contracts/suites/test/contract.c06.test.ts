/**
 * C06 settlement and ledger. The real provider of reservation batches (MONEY-I2) runs runC06ReservationSuite in
 * slices/account/money/test/contract.c06.test.ts. The usage-batch part comes in S-MONEY MONEY-I3; until then this
 * entry shows in every run.
 */
import { pendingProvider } from '../src/index.ts';

pendingProvider('C06', 'real ledger', 'MONEY-I3', 'usage batches on the posting port (§8) and the posting acknowledgement (§7) against runC06ProviderSuite');
