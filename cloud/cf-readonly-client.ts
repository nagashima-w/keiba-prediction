/**
 * 手元の開発用の道具(`pull-race-archive.ts`・`build-prior-dataset.ts`)が、本番の Cloudflare の D1・R2 を**読むだけ**で使うための窓口(Issue #586・#587)。
 * **本番の Worker の束には入らない**(`wrangler.toml` の main から辿られない。`test/cf-readonly-client.test.ts` が、`src/` からこのファイルを import していないことを固定する)。
 *
 * ## 読み取り専用の守り(最重要)
 * - SQL: {@link assertReadOnlySql} が、コメントと文字列リテラルを除いたうえで、`SELECT` か `WITH` で始まり、`;` で文を連ねず、書き込み・DDL・PRAGMA の語を含まないものだけを通す。
 *   通らなければ**HTTP を送る前に**例外にする。
 * - HTTP: 送るのは「D1 の `query` への POST」と「R2 のオブジェクトの GET」の 2 種類だけ(このクラスの `send` にこの 2 つしか書いていない)。PUT・DELETE・LIST・HEAD は送れない。
 * - 既存のストア(`D1PriorExportStore` など)に差し込むための窓口 {@link asReadonlyD1}・{@link asReadonlyBucket} は、`run()`・`put()` を例外にする。
 *
 * ## 鍵
 * 環境変数 `CLOUDFLARE_API_TOKEN`(読み取り専用の鍵)を `Authorization: Bearer` に付ける。値は出力にも例外にも入れない。アカウント ID は `CLOUDFLARE_ACCOUNT_ID`。
 * Node の `fetch` をプロキシ越しに使うときは `NODE_USE_ENV_PROXY=1` を付けて実行する。
 *
 * ## 要求の間隔
 * Cloudflare の API の上限(5 分で 1,200 回)の手前に収まるよう、既定で 300ms あける(1 秒に 3 回強。5 分で約 1,000 回)。同時に出した要求も、この間隔で順に出る。
 * 429・5xx・通信の失敗は、待って再試行する(待ちは 5 秒・10 秒…、既定で 4 回まで)。404 は R2 では「無い」(null)、それ以外の 4xx はすぐ例外。
 */

/** 本番の D1 の ID(`cloud/wrangler.toml` の `database_id`。公開してよい値)。 */
export const DEFAULT_DATABASE_ID = "c52e97fc-d495-4395-8141-80d20ef57a16";
/** 本番の R2 のバケット名(`cloud/wrangler.toml`)。 */
export const DEFAULT_BUCKET = "keiba-cloud-r2";

const FORBIDDEN_WORDS = /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|CREATE|ALTER|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|ANALYZE|TRUNCATE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

/** コメントを空白に、文字列・引用符つきの識別子を `''` に置き換えた「骨格」を返す。閉じていないコメント・引用符は例外。 */
function skeletonOf(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
      out += " ";
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) {
        throw new Error("読み取り専用の守り: 閉じていないブロックコメントがあります");
      }
      i = end + 2;
      out += " ";
    } else if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) {
          throw new Error("読み取り専用の守り: 閉じていない引用符があります");
        }
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      i = j + 1;
      out += "''";
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/**
 * 読み取りの SQL だけを通す。通らなければ例外。
 * 通す条件: コメントと文字列リテラルを除いたうえで、(1) 先頭の語が SELECT か WITH (2) `;` は末尾にしか無い(複数の文にしない) (3) 書き込み・DDL・PRAGMA などの語を含まない。
 * 文字列リテラルの中の語は見ない。列名の一部(`updated_at` など)は語として数えない。保守的な検査で、`replace()` 関数のように読み取りに使える語も拒否する。
 */
export function assertReadOnlySql(sql: string): void {
  const code = skeletonOf(sql).trim().replace(/;+\s*$/, "").trim();
  if (code === "") {
    throw new Error("読み取り専用の守り: 空の SQL です");
  }
  if (code.includes(";")) {
    throw new Error("読み取り専用の守り: 複数の文は送れません");
  }
  if (!/^(SELECT|WITH)\b/i.test(code)) {
    throw new Error(`読み取り専用の守り: SELECT 以外は送れません: ${code.slice(0, 40)}`);
  }
  const hit = FORBIDDEN_WORDS.exec(code);
  if (hit !== null) {
    throw new Error(`読み取り専用の守り: 書き込みの語 ${hit[1]!.toUpperCase()} を含む SQL は送れません`);
  }
}

export interface ReadonlyCloudflareOptions {
  readonly accountId: string;
  readonly databaseId?: string;
  readonly bucket?: string;
  /** 読み取り専用の鍵。既定は環境変数 `CLOUDFLARE_API_TOKEN`(プロキシが本物を付けるのでダミーでもよい)。 */
  readonly token?: string;
  /** 通信(テストで偽物を渡す)。既定はグローバルの fetch。 */
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** 要求と要求の間隔(ms)。既定 300。 */
  readonly minIntervalMs?: number;
  /** 429・5xx・通信失敗の再試行の回数。既定 4(最大 5 回送る)。 */
  readonly maxRetries?: number;
  /** n 回目の再試行の前の待ちは `retryBaseMs * n`。既定 5000。 */
  readonly retryBaseMs?: number;
}

export interface D1QueryResult {
  readonly results: unknown[];
  readonly meta: { readonly rows_read?: number; readonly [key: string]: unknown };
}

const API = "https://api.cloudflare.com/client/v4";

export class ReadonlyCloudflare {
  /** これまでに送った要求の数(再試行を含む)。 */
  requests = 0;
  private nextSlot = 0;
  private readonly base: string;
  private readonly databaseId: string;
  private readonly bucket: string;
  private readonly token: string;
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(options: ReadonlyCloudflareOptions) {
    this.base = `${API}/accounts/${options.accountId}`;
    this.databaseId = options.databaseId ?? DEFAULT_DATABASE_ID;
    this.bucket = options.bucket ?? DEFAULT_BUCKET;
    this.token = options.token ?? process.env["CLOUDFLARE_API_TOKEN"] ?? "dummy";
    this.doFetch = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = options.now ?? Date.now;
    this.minIntervalMs = options.minIntervalMs ?? 300;
    this.maxRetries = options.maxRetries ?? 4;
    this.retryBaseMs = options.retryBaseMs ?? 5000;
  }

  /** 環境変数 `CLOUDFLARE_ACCOUNT_ID` から作る。無ければ例外。 */
  static fromEnv(): ReadonlyCloudflare {
    const accountId = process.env["CLOUDFLARE_ACCOUNT_ID"];
    if (accountId === undefined || accountId === "") {
      throw new Error("環境変数 CLOUDFLARE_ACCOUNT_ID がありません");
    }
    return new ReadonlyCloudflare({ accountId });
  }

  /** D1 に SELECT を送る。SQL は送る前に検査する。 */
  async query(sql: string, params: readonly unknown[]): Promise<D1QueryResult> {
    assertReadOnlySql(sql);
    const res = await this.send("POST", `${this.base}/d1/database/${this.databaseId}/query`, JSON.stringify({ sql, params }));
    const body = (await res.json()) as { success?: boolean; errors?: Array<{ message?: string }>; result?: D1QueryResult[] };
    if (body.success !== true || body.result?.[0] === undefined) {
      const messages = (body.errors ?? []).map((e) => e.message ?? "").join("; ");
      throw new Error(`D1 の失敗: ${messages === "" ? `HTTP ${res.status}` : messages}`);
    }
    return body.result[0];
  }

  /** R2 のオブジェクトを GET する。無ければ null。 */
  async getObject(key: string): Promise<Uint8Array | null> {
    const res = await this.send("GET", `${this.base}/r2/buckets/${this.bucket}/objects/${encodeURIComponent(key)}`, undefined);
    if (res.status === 404) {
      return null;
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /** 唯一の送信口。D1 の query への POST と R2 のオブジェクトの GET の 2 種類だけを、間隔をあけて送る。404 は呼び出し側が扱う(ここでは返す)。 */
  private async send(method: "POST" | "GET", url: string, body: string | undefined): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      // 間隔の枠は同期的に取る(同時に出した要求が重ならない)。
      const t = this.now();
      const slot = Math.max(t, this.nextSlot);
      this.nextSlot = slot + this.minIntervalMs;
      if (slot > t) {
        await this.sleep(slot - t);
      }
      this.requests += 1;
      let res: Response | null = null;
      try {
        const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
        if (body !== undefined) {
          headers["Content-Type"] = "application/json";
        }
        res = await this.doFetch(url, body === undefined ? { method, headers } : { method, headers, body });
      } catch {
        res = null; // 通信の失敗は再試行する(例外の本文に URL が入りうるので、そのまま投げない)
      }
      if (res !== null && res.status !== 429 && res.status < 500) {
        if (res.ok || res.status === 404) {
          return res;
        }
        throw new Error(`Cloudflare の失敗: HTTP ${res.status}`);
      }
      if (attempt >= this.maxRetries) {
        throw new Error(`Cloudflare の失敗: ${res === null ? "通信の失敗" : `HTTP ${res.status}`}(再試行 ${this.maxRetries} 回で諦めました)`);
      }
      await this.sleep(this.retryBaseMs * (attempt + 1));
    }
  }
}

/** 既存のストアが使う D1 の最小の窓口(`prepare`・`batch`)。`run()` は例外。 */
class ReadonlyStatement {
  constructor(private readonly client: ReadonlyCloudflare, readonly sql: string, readonly params: readonly unknown[] = []) {}
  bind(...params: unknown[]): ReadonlyStatement {
    return new ReadonlyStatement(this.client, this.sql, params);
  }
  async all<T>(): Promise<{ results: T[]; meta: D1QueryResult["meta"] }> {
    const r = await this.client.query(this.sql, this.params);
    return { results: r.results as T[], meta: r.meta };
  }
  async first<T>(): Promise<T | null> {
    const r = await this.client.query(this.sql, this.params);
    return (r.results[0] as T | undefined) ?? null;
  }
  async run(): Promise<never> {
    throw new Error("読み取り専用の守り: run() は使えません");
  }
}

export interface ReadonlyD1 {
  prepare(sql: string): ReadonlyStatement;
  batch<T = unknown>(statements: ReadonlyStatement[]): Promise<Array<{ results: T[]; meta: D1QueryResult["meta"] }>>;
}

/** 既存のストア(`D1PriorExportStore` など)に D1 として差し込む窓口。SELECT しか送れない。 */
export function asReadonlyD1(client: ReadonlyCloudflare): ReadonlyD1 {
  return {
    prepare: (sql) => new ReadonlyStatement(client, sql),
    batch: async (statements) => {
      // 1 つでも読み取りでなければ、どれも送らない。
      for (const s of statements) {
        assertReadOnlySql(s.sql);
      }
      const out = [];
      for (const s of statements) {
        out.push(await s.all());
      }
      return out as never;
    },
  };
}

export interface ReadonlyBucket {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(): Promise<never>;
}

/** 既存のストアに R2 として差し込む窓口。`get` だけ。`put` は例外。 */
export function asReadonlyBucket(client: ReadonlyCloudflare): ReadonlyBucket {
  return {
    get: async (key) => {
      const bytes = await client.getObject(key);
      return bytes === null ? null : { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer };
    },
    put: async () => {
      throw new Error("読み取り専用の守り: put は使えません");
    },
  };
}
