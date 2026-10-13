/** C06 settlement and ledger: the real provider comes in S-MONEY MONEY-I2. Until then this entry shows in every run. */
import { pendingProvider } from '../src/index.ts';

pendingProvider('C06', 'real ledger', 'MONEY-I2', 'posting port (§8) and posting acknowledgement (§7) against runC06ProviderSuite');
