import type { PoolClient, QueryResult } from "pg";

export interface RecordedQuery {
    sql: string;
    params: readonly unknown[];
}

/**
 * Records every `client.query(sql, params)` call. Tests can pre-stage responses
 * (consumed in order) for SELECTs that the processor branches on (e.g. the
 * idempotency-check `SELECT count(*)`). All non-staged calls return an empty
 * result, which is fine for INSERT/UPDATE — the assertion is on the recorded
 * SQL + params, not on a database round-trip.
 *
 * Use this for processor unit tests in lieu of a real pg client. It keeps tests
 * fast, deterministic, and decoupled from pg-mem's BYTEA quirks.
 */
export class FakePoolClient {
    readonly recorded: RecordedQuery[] = [];
    private readonly stagedResponses: QueryResult<unknown>[] = [];

    /** Push a response that the next .query() call will return. */
    queueResponse<T = unknown>(rows: T[]): void {
        this.stagedResponses.push({
            rows,
            rowCount: rows.length,
            command: "SELECT",
            oid: 0,
            fields: [],
        } as unknown as QueryResult<unknown>);
    }

    async query<T = unknown>(
        sql: string,
        params: readonly unknown[] = [],
    ): Promise<QueryResult<T>> {
        this.recorded.push({ sql, params });
        const next = this.stagedResponses.shift();
        if (next) return next as QueryResult<T>;
        return {
            rows: [],
            rowCount: 0,
            command: "INSERT",
            oid: 0,
            fields: [],
        } as unknown as QueryResult<T>;
    }

    release(): void {
        // no-op
    }

    /** Return the first recorded query whose SQL contains the snippet. */
    findBySqlContains(snippet: string): RecordedQuery | undefined {
        return this.recorded.find((q) => q.sql.includes(snippet));
    }

    /** Return all recorded queries whose SQL contains the snippet. */
    filterBySqlContains(snippet: string): RecordedQuery[] {
        return this.recorded.filter((q) => q.sql.includes(snippet));
    }
}

/** Coerce the fake into the PoolClient type the processor signatures expect. */
export function asPoolClient(c: FakePoolClient): PoolClient {
    return c as unknown as PoolClient;
}

/** Stage an idempotency-check SELECT count() that returns 0 (proceed with mutation). */
export function stageNotYetStamped(c: FakePoolClient): void {
    c.queueResponse([{ count: "0" }]);
}

/** Stage an idempotency-check SELECT count() that returns 1 (skip mutation). */
export function stageAlreadyStamped(c: FakePoolClient): void {
    c.queueResponse([{ count: "1" }]);
}
