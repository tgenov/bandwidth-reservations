/**
 * Alerts of the S-RATE owners. C01 §2.10 defines the operational alert feed. The runtime
 * double has no alert stream, so the owners write alerts to this sink. A production sink
 * appends them on the `<kind>.alert.v1` stream.
 */

export interface RateAlert { owner: string; kind: string; detail?: string }

export interface AlertSink { raise(a: RateAlert): void }

export class MemoryAlerts implements AlertSink {
  readonly alerts: RateAlert[] = [];
  raise(a: RateAlert): void {
    this.alerts.push(a);
  }
  of(kind: string): RateAlert[] {
    return this.alerts.filter((a) => a.kind === kind);
  }
}
