/**
 * The sender's rule for a `STALE_SENDER(recorded)` refusal (C01 §3.8, review 47 D4; plan S-PLAT-I3 work item 4).
 */
import type { WriterFence } from './api.ts';

/**
 * What a sender does with `STALE_SENDER(recorded)`:
 * - `slotLost`: the recorded generation equals the sender's and its epoch is higher: the sender was deposed (as
 *   `StaleEpoch` for that slot);
 * - `dropKeepSlot`: the recorded generation is higher: the partition moved and the new writer superseded the command;
 *   drop the command and keep the slot. `alertUnmoved` is true when the sender has not applied `moved` for the
 *   partition: it raises `STALE_SENDER_UNMOVED`;
 * - `defect`: anything else (the receiver refused a fence that is not below its record): alert and drop.
 */
export type StaleSenderAction =
  | { action: 'slotLost' }
  | { action: 'dropKeepSlot'; alertUnmoved: boolean }
  | { action: 'defect' };

/** C01 §3.8 D4: the action for a refusal that recorded `recorded`, for a sender at `own`. */
export function staleSenderAction(own: WriterFence, recorded: WriterFence, movedApplied: boolean): StaleSenderAction {
  if (recorded.generation === own.generation && recorded.epoch > own.epoch) return { action: 'slotLost' };
  if (recorded.generation > own.generation) return { action: 'dropKeepSlot', alertUnmoved: !movedApplied };
  return { action: 'defect' };
}
