/**
 * 取得した Cloudflare の拠点(3 文字のコード。例 `NRT`)を、DO が 1 日 1 回だけ読んで持つ(Issue #804)。JRA の取得の失敗の詳細(`fail_detail` の `c`)に付ける。
 *
 * ## 何の拠点か(正直な限界)
 * `https://www.cloudflare.com/cdn-cgi/trace` を DO の中から 1 本取り、`colo=` の行を読む。DO のアラームには受けたリクエストが無く、`request.cf.colo` が使えないための代わり。
 * 値は **「その日の最初の JRA の取得のときの拠点」**: 1 日 1 回だけ取るので、その日のうちに DO の場所が変わっても同じ値のまま。
 * subrequest が出る拠点と、この取得が出る拠点が同じとは限らない(DO の拠点は作られた場所に固定されるはずだが、本番での確認は公開後の記録で行う)。
 * 取れない(失敗・形違い)ときは null で、JRA の取得は止めない。取れなかった日も、その日は取り直さない(1 日 1 回まで)。
 */
import { parseTraceColo } from "./jra-fail-detail";

export const COLO_TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";
/** 拠点の取得のタイムアウト(ミリ秒)。最初の JRA の取得を待たせすぎない。 */
const COLO_TIMEOUT_MS = 3_000;
/** 本文の上限(バイト)。trace は 300 バイト前後。 */
const COLO_MAX_BYTES = 64 * 1024;

/** 注入できる fetch。 */
export type ColoFetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** `cdn-cgi/trace` から拠点を読む。投げない(失敗・リダイレクト・200 台以外・大きすぎる本文・形違いは null)。 */
export async function fetchTraceColo(fetchFn: ColoFetchLike): Promise<string | null> {
  try {
    const response = await fetchFn(COLO_TRACE_URL, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(COLO_TIMEOUT_MS) });
    if (response.status < 200 || response.status >= 300) {
      void response.body?.cancel().catch(() => undefined);
      return null;
    }
    const declared = Number(response.headers.get("content-length"));
    if (response.headers.get("content-length") !== null && Number.isFinite(declared) && declared > COLO_MAX_BYTES) {
      void response.body?.cancel().catch(() => undefined);
      return null;
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.byteLength > COLO_MAX_BYTES ? null : parseTraceColo(new TextDecoder().decode(buffer));
  } catch {
    return null;
  }
}

export interface ColoOfDayDeps {
  readonly metaGet: (key: string) => string | null;
  readonly metaSet: (key: string, value: string) => void;
  readonly now: () => number;
  /** 拠点を取る関数(本番は {@link fetchTraceColo})。投げてもよい(`ensure` が握る)。 */
  readonly fetchColo: () => Promise<string | null>;
}

const DAY_KEY = "colo_day";
const COLO_KEY = "colo";
const COLO_PATTERN = /^[A-Z]{3}$/;
/** 取れなかった印(メタの値は NULL にできないので)。 */
const NONE = "-";

/** JST の日付(YYYYMMDD)。 */
function jstDay(epochMs: number): string {
  return new Date(epochMs + 9 * 3_600_000).toISOString().slice(0, 10).replaceAll("-", "");
}

/** 1 日 1 回、最初の JRA の取得の前に拠点を取って、日付つきで DO のメタに持つ。 */
export class ColoOfDay {
  private inFlight: Promise<void> | null = null;

  constructor(private readonly deps: ColoOfDayDeps) {}

  /** 今日の拠点をまだ取っていないか(取れなかった日は「取った」と数える)。同期で答える(呼び出し側が、取らない日に待たないための判定)。 */
  isPending(): boolean {
    return this.deps.metaGet(DAY_KEY) !== jstDay(this.deps.now());
  }

  /** 今日の拠点がまだ決まっていなければ(取れなかった日も「決まった」と数える)取る。投げない。 */
  async ensure(): Promise<void> {
    const today = jstDay(this.deps.now());
    if (this.deps.metaGet(DAY_KEY) === today) {
      return;
    }
    this.inFlight ??= this.fetchOnce(today).finally(() => {
      this.inFlight = null;
    });
    await this.inFlight;
  }

  private async fetchOnce(today: string): Promise<void> {
    // 取る前に日を記録する(途中で DO が落ちても、その日のうちに繰り返し取らない。1 日 1 回まで)。
    this.deps.metaSet(DAY_KEY, today);
    this.deps.metaSet(COLO_KEY, NONE);
    let colo: string | null = null;
    try {
      colo = await this.deps.fetchColo();
    } catch {
      colo = null;
    }
    if (colo !== null && COLO_PATTERN.test(colo)) {
      this.deps.metaSet(COLO_KEY, colo);
    }
  }

  /** 今日の拠点(まだ取っていない・取れなかった・形違いは null)。前の日の値は返さない。 */
  get(): string | null {
    if (this.deps.metaGet(DAY_KEY) !== jstDay(this.deps.now())) {
      return null;
    }
    const value = this.deps.metaGet(COLO_KEY);
    return value !== null && COLO_PATTERN.test(value) ? value : null;
  }

  /**
   * 画面用(Issue #812): 最後に取れた拠点と、取った日(JST の YYYYMMDD)。日が変わっても返す(DO の拠点は作られた場所に固定されるはずなので、前日の値でも拠点の確認には使える)。
   * 取れなかった日(印)・形違い・日付の形違い・メタ無しは null。
   */
  latest(): { readonly colo: string; readonly day: string } | null {
    const colo = this.deps.metaGet(COLO_KEY);
    const day = this.deps.metaGet(DAY_KEY);
    return colo !== null && day !== null && COLO_PATTERN.test(colo) && /^\d{8}$/.test(day) ? { colo, day } : null;
  }
}
