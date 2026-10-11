import { Global, Inject, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';
import { billingConfig } from '../billing.config';

export const PG_POOL = Symbol('PG_POOL');

/** Thin wrapper over the pool: plain queries plus a transaction helper. */
@Injectable()
export class Db implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) readonly pool: Pool) {}

  query<T extends object = any>(sql: string, params: unknown[] = []) {
    return this.pool.query<T>(sql, params);
  }

  /** READ COMMITTED on purpose: lock-then-read relies on each statement taking a fresh snapshot. */
  async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  onModuleDestroy() {
    return this.pool.end();
  }
}

// @Global so every feature module can inject Db without importing this module.
// Kept to infrastructure only; feature modules still import each other explicitly.
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [billingConfig.KEY],
      useFactory: (cfg: ConfigType<typeof billingConfig>) =>
        new Pool({ connectionString: cfg.databaseUrl, max: 20 }),
    },
    Db,
  ],
  exports: [Db],
})
export class DatabaseModule {}
