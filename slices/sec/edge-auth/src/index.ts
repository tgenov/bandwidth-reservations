/** @share/edge-auth — the edge check of S-SEC I1: replica, authentication, principal context, forward once. */
export { EDGE_STALENESS_MAX_MICROS, EdgeReplica, type KeyEntry } from './replica.ts';
export {
  EdgeGateway, MATRIX_ROW, UNAUTH_FLOOR_MICROS, wallClock,
  type EdgeClock, type EdgeGatewayOptions, type EdgeOperation, type EdgeRequest, type EdgeResponse, type Forwarder,
  type OwnerAnswer, type OwnerCommand,
} from './gateway.ts';
