/**
 * 日単位の DO(`RaceDayCore`)の、JRA の出馬表の取得の段階(Issue #639)。中央の開催日に、馬ごとの血統・馬主・生産者と、レースごとのブリンカー・減量・マルガイの印を JRA の出馬表(詳細ページ)から取り、D1 に保存する。
 * **保存するだけ**(分析・プロンプト・画面には使わない。効くかは #542・#636 で測ってから)。
 * **純ロジック**: `cloudflare:workers`・`fetch`・D1 を import しない(取得口・保存先・計画の事実は注入。ストレージは DO の `race_day_meta` だけ)。URL もここには来ない(取得口の中だけにある。`jra-entries-fetch.ts`)。
 *
 * ## いつ動くか({@link JraEntriesStage.dueAtMs})
 * 取得口と保存先があり、開催日が固定されて計画が確定し、中央の一覧が 1 件以上ある日。**開催日の朝 {@link JRA_ENTRIES_START_JST} 以降**に動く(前夜には動かさない。ブリンカー・馬主・取消は当日のほうが正確)。
 * {@link JRA_ENTRIES_LAST_JST} 以降は動かない。今日(JST)が開催日と同じでなければ動かない。
 * `RaceDayCore.runNextStep` での順序は**最も低い優先度**: タスク(queued・fetched)が無く、馬場の取得も動けないときだけ。発走前の分析・通知・締切の再計算・馬場の取得を押しのけない。
 *
 * ## 1 起床 = 1 つのまとまり(JRA への本数は {@link JRA_ENTRIES_PAGES_PER_STEP} 本以下)
 *  1. 開催の選択 + 場ごとのレースの選択(1 + 場の数。多くとも 4 本)。場ごとの詳細ページの CNAME を `race_day_meta` に置く。
 *  2. 場ごとに、詳細ページ(1 場 12 レースなら 12 本)。レースの選択が 1 で失敗した場は、この回で取り直す(13 本)。
 * 3 場の日で 4 回の起床(合計 1 + 3 + 36 = 40 本)。起床と起床の間は {@link JRA_ENTRIES_STEP_GAP_MS} 以上あける。本の間隔(1.5 秒)は取得口が守る。
 * CNAME は計算できない(末尾の確認用の符号)ので、1 でたどった値を使い回す。詳細が `param-error`(符号が古い)になったら、開催の選択からたどり直す(1 回だけ)。
 *
 * ## 1 回の試みは 1 回だけ({@link JraEntriesStage.run})
 * JRA に出る**前に**、D1 の `jra_entry_fetches` に (開催日, 場, 試行番号) の行を INSERT し(`claim`。主キーの衝突 = その試みは既に行った)、続けて試行の回数を DO の meta に**同期で**書く。
 * DO の再起動・アラームの重複・DO のストレージの消失でも、同じ試みは二重に動かない。結果が何であっても同じ試みは再試行しない(次の試行番号で取り直す)。
 * 失敗した場は {@link JRA_ENTRIES_RETRY_MS}(10 分)後に、**失敗したレースだけ**取り直す。場ごとに最大 {@link JRA_ENTRIES_MAX_ATTEMPTS} 回で諦める(他の場は続ける)。
 * 全部の場が済む(または諦める)と {@link JRA_ENTRIES_META_DONE} を書き、以後動かない。
 *
 * ## 失敗しても分析を止めない・秘匿
 * {@link JraEntriesStage.run} は例外を投げない(DO のアラームは例外で再実行される)。警告は固定の文と分類だけ(例外の文面・URL・応答の本文は出さない・保存しない)。
 * 発走前の分析の経路は、この段の結果を読まない(`cloud/test/jra-entries-isolation.test.ts` が固定している)。
 * 1 起床の所要時間は、固定の語のログ(`onInfo`)と meta({@link JRA_ENTRIES_META_LAST_MS})に残す。CPU 時間は Workers の観測で見る。
 */
import { startTimeEpochMs } from "./pre-race-time";
import { jstKaisaiDate } from "./auto-run-plan";
import type { SqlLike } from "./sql-like";
import type { JraEntriesFetcher, JraEntriesSession, JraPageFailure } from "./jra-entries-fetch";
import type { JraEntriesFinish, JraEntriesStoreLike, SavedRace } from "./jra-entries-repository";

/** 動き始める時刻(開催日の朝)と、これ以降は動かない時刻。 */
export const JRA_ENTRIES_START_JST = "07:00";
export const JRA_ENTRIES_LAST_JST = "15:00";
/** 1 起床で JRA に送る本数の上限(1 場のレースの選択 1 + 詳細 12)。Workers の Free のサブリクエスト 50 に、D1 の文を足しても収まる。 */
export const JRA_ENTRIES_PAGES_PER_STEP = 13;
/** 場ごと(開催の選択も)の試行の上限。 */
export const JRA_ENTRIES_MAX_ATTEMPTS = 3;
/** 失敗した後に取り直すまでの待ち。 */
export const JRA_ENTRIES_RETRY_MS = 10 * 60_000;
/** 成功した回と次の回のあいだの最小の間隔(JRA への取得を詰めない)。 */
export const JRA_ENTRIES_STEP_GAP_MS = 5_000;
/** 開催の選択でたどる場の数の上限(JRA は 1 日に最大 3 場)。 */
const MAX_VENUES = 4;
/** 開催の選択・レースの選択をたどる回の「場コード」。 */
const DISCOVERY = "00";

/** DO の meta のキー: 場ごとの CNAME・試行の回数・済みの印(JSON)。 */
export const JRA_ENTRIES_META_STATE = "jra_entries_state";
/** DO の meta のキー: 次に動ける時刻(エポックミリ秒)。 */
export const JRA_ENTRIES_META_NEXT_AT = "jra_entries_next_at";
/** DO の meta のキー: 全部の場が済んだ(または諦めた)印。あれば以後動かない。 */
export const JRA_ENTRIES_META_DONE = "jra_entries_done";
/** DO の meta のキー: 最後の起床の所要時間(ミリ秒。観測用)。 */
export const JRA_ENTRIES_META_LAST_MS = "jra_entries_last_ms";
/** DO の meta のキー: 最後の起床の結果の分類(観測用)。 */
export const JRA_ENTRIES_META_RESULT = "jra_entries_result";

/** 計画の事実(`RaceDayCore` が計画の表から作る)。 */
export interface JraEntriesFacts {
  /** DO が固定された開催日(YYYYMMDD)。未確定は null。 */
  readonly kaisaiDate: string | null;
  readonly planFinalized: boolean;
  /** 中央の一覧が取得できて 1 件以上ある(= JRA の開催日)。 */
  readonly centralListed: boolean;
  /** 計画の中央の行にある場コード。空なら、開催の選択にある全部の場を取る。 */
  readonly venueCodes: readonly string[];
}

export interface JraEntriesStageDeps {
  readonly sql: SqlLike;
  readonly now: () => number;
  /** 取得口(本番は常にある。無ければ機能全体が止まる〈印も書かない〉のはテスト用)。 */
  readonly fetcher: JraEntriesFetcher | undefined;
  readonly store: JraEntriesStoreLike | undefined;
  readonly onWarn: (message: string) => void;
  /** 1 起床ごとの固定の語のログ(所要時間の観測)。省略時は出さない。 */
  readonly onInfo?: (message: string) => void;
  readonly facts: () => JraEntriesFacts;
}

/** 出馬表の取得ステップの結果(`StepOutcome` の 1 種)。`raceId` は開催日。 */
export interface JraEntriesStepOutcome {
  readonly kind: "ran";
  readonly raceId: string;
  readonly mode: "jra-entries";
  readonly step: "fetch";
  readonly result: "ok" | "retry" | "failed";
}

interface VenueState {
  readonly code: string;
  readonly drl: string;
  /** 取り残しているレースの詳細の CNAME。null = レースの選択をまだ読めていない。 */
  races: string[] | null;
  attempts: number;
  done: boolean;
}

interface State {
  /** 開催の選択・レースの選択をたどる回の試行の回数と上限(たどり直すと上限を足す)。 */
  discoveryAttempts: number;
  discoveryLimit: number;
  discovered: boolean;
  rediscovered: boolean;
  venues: VenueState[];
}

const freshState = (): State => ({ discoveryAttempts: 0, discoveryLimit: JRA_ENTRIES_MAX_ATTEMPTS, discovered: false, rediscovered: false, venues: [] });

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** 保存した状態を読む。壊れていれば null(最初からやり直す)。 */
function parseState(text: string | null): State | null {
  if (text === null) {
    return null;
  }
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== "object" || raw === null) {
      return null;
    }
    const o = raw as Record<string, unknown>;
    if (
      typeof o["discoveryAttempts"] !== "number" ||
      typeof o["discoveryLimit"] !== "number" ||
      typeof o["discovered"] !== "boolean" ||
      typeof o["rediscovered"] !== "boolean" ||
      !Array.isArray(o["venues"])
    ) {
      return null;
    }
    const venues: VenueState[] = [];
    for (const item of o["venues"] as unknown[]) {
      if (typeof item !== "object" || item === null) {
        return null;
      }
      const v = item as Record<string, unknown>;
      if (typeof v["code"] !== "string" || typeof v["drl"] !== "string" || typeof v["attempts"] !== "number" || typeof v["done"] !== "boolean" || !(v["races"] === null || isStringArray(v["races"]))) {
        return null;
      }
      venues.push({ code: v["code"], drl: v["drl"], races: v["races"] as string[] | null, attempts: v["attempts"], done: v["done"] });
    }
    return { discoveryAttempts: o["discoveryAttempts"], discoveryLimit: o["discoveryLimit"], discovered: o["discovered"], rediscovered: o["rediscovered"], venues };
  } catch {
    return null;
  }
}

/** 1 つの試みの作業の結果。 */
interface Work {
  /** 結果の分類(`jra_entry_fetches.result`)。 */
  readonly result: string;
  readonly racesTotal: number;
  readonly racesSaved: number;
  readonly horsesSkipped: number;
  /** その場(開催の選択の回は使わない)が全部済んだ。 */
  readonly complete: boolean;
  /** 失敗があった(10 分後に取り直す)。 */
  readonly failed: boolean;
}

export class JraEntriesStage {
  private inFlight = false;

  constructor(private readonly deps: JraEntriesStageDeps) {}

  private metaGet(key: string): string | null {
    const rows = this.deps.sql.exec("SELECT value FROM race_day_meta WHERE key = ?", key).toArray() as { value: string }[];
    return rows[0]?.value ?? null;
  }

  private metaSet(key: string, value: string): void {
    this.deps.sql.exec("INSERT INTO race_day_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  private loadState(): State {
    return parseState(this.metaGet(JRA_ENTRIES_META_STATE)) ?? freshState();
  }

  private saveState(state: State): void {
    this.metaSet(JRA_ENTRIES_META_STATE, JSON.stringify(state));
  }

  /** まだ取る余地があるか(開催の選択が済んでいない・取れていない場が試行の上限に達していない)。 */
  private pending(state: State): boolean {
    return state.discovered ? state.venues.some((v) => !v.done && v.attempts < JRA_ENTRIES_MAX_ATTEMPTS) : state.discoveryAttempts < state.discoveryLimit;
  }

  /**
   * 次の取得の期限(アラームの候補。エポックミリ秒)。動けない構成・状態なら null(候補にしない)。
   * 開催日の {@link JRA_ENTRIES_START_JST} 以降(前夜のうちから、翌朝のその時刻で候補になる)。今日が開催日より後・済んだ・{@link JRA_ENTRIES_LAST_JST} を過ぎた、なら null。
   */
  dueAtMs(): number | null {
    const { fetcher, store } = this.deps;
    if (fetcher === undefined || store === undefined) {
      return null;
    }
    const facts = this.deps.facts();
    if (facts.kaisaiDate === null || !facts.planFinalized || !facts.centralListed) {
      return null;
    }
    if (this.metaGet(JRA_ENTRIES_META_DONE) !== null) {
      return null;
    }
    const now = this.deps.now();
    if (jstKaisaiDate(now) > facts.kaisaiDate) {
      return null;
    }
    if (now >= startTimeEpochMs(facts.kaisaiDate, JRA_ENTRIES_LAST_JST) || !this.pending(this.loadState())) {
      return null;
    }
    const nextAt = this.metaGet(JRA_ENTRIES_META_NEXT_AT);
    const due = Math.max(startTimeEpochMs(facts.kaisaiDate, JRA_ENTRIES_START_JST), nextAt === null ? 0 : Number(nextAt));
    return due >= startTimeEpochMs(facts.kaisaiDate, JRA_ENTRIES_LAST_JST) ? null : due;
  }

  /** いま動けるか: 実行中でなく、期限が来ていて、今日(JST)が開催日。 */
  runnable(): boolean {
    if (this.inFlight) {
      return false;
    }
    const due = this.dueAtMs();
    const facts = this.deps.facts();
    return due !== null && this.deps.now() >= due && jstKaisaiDate(this.deps.now()) === facts.kaisaiDate;
  }

  /** 1 起床ぶんを行う。動けないときは何もしない(`retry`)。**例外を投げない。** 手順は冒頭。 */
  async run(): Promise<JraEntriesStepOutcome> {
    const date = this.deps.facts().kaisaiDate ?? "";
    const outcome = (result: JraEntriesStepOutcome["result"]): JraEntriesStepOutcome => ({ kind: "ran", raceId: date, mode: "jra-entries", step: "fetch", result });
    if (!this.runnable()) {
      return outcome("retry");
    }
    this.inFlight = true;
    try {
      return outcome(await this.runOnce(date));
    } catch {
      // 想定外の例外(状態の読み書きなど)。文面は残さない。次の起床を遅らせて、続きは次の回に任せる。
      this.deps.onWarn("JRA の出馬表の取得: 想定外の失敗が起きたため、この回は中止しました(分類: other)");
      try {
        this.metaSet(JRA_ENTRIES_META_NEXT_AT, String(this.deps.now() + JRA_ENTRIES_RETRY_MS));
      } catch {
        // meta も書けないときは何もしない(アラームの候補は期限のまま。例外は投げない)
      }
      return outcome("failed");
    } finally {
      this.inFlight = false;
    }
  }

  private async runOnce(date: string): Promise<JraEntriesStepOutcome["result"]> {
    const { store, fetcher } = this.deps;
    const state = this.loadState();
    const startedAt = this.deps.now();

    // どの単位を試みるか。
    const venue = state.discovered ? state.venues.find((v) => !v.done && v.attempts < JRA_ENTRIES_MAX_ATTEMPTS) : undefined;
    if (state.discovered && venue === undefined) {
      this.metaSet(JRA_ENTRIES_META_DONE, "1");
      return "ok";
    }
    const unit = venue?.code ?? DISCOVERY;
    const attempt = (venue === undefined ? state.discoveryAttempts : venue.attempts) + 1;
    const useUp = (): void => {
      if (venue === undefined) {
        state.discoveryAttempts = attempt;
      } else {
        venue.attempts = attempt;
      }
      this.saveState(state);
    };

    // 1. 試みを先に記録する(D1)。ここまでは JRA に何も送っていない。
    let claim: "claimed" | "exists" | "done";
    try {
      claim = await (store as JraEntriesStoreLike).claim(date, unit, attempt, startedAt);
    } catch {
      useUp();
      this.metaSet(JRA_ENTRIES_META_NEXT_AT, String(this.deps.now() + JRA_ENTRIES_RETRY_MS));
      this.deps.onWarn(`JRA の出馬表の取得: 試みの記録(D1)に失敗しました(場=${unit} 試行=${attempt}。JRA には送っていません。${JRA_ENTRIES_RETRY_MS / 60_000} 分後に取り直します)`);
      return "retry";
    }

    // 2. DO の印を、同期で、JRA に出る前に書く。次に動ける時刻も先に置く(途中で落ちても詰めて撃ち直さない)。
    useUp();
    this.metaSet(JRA_ENTRIES_META_NEXT_AT, String(startedAt + JRA_ENTRIES_RETRY_MS));
    if (claim === "done" && venue !== undefined) {
      venue.done = true;
      venue.races = [];
      return this.finishStep(state, startedAt + JRA_ENTRIES_STEP_GAP_MS, "ok");
    }
    if (claim !== "claimed") {
      // exists(その試みは既に行った)。開催の選択の回の done も同じ扱い(D1 の complete を使わないので来ない)。
      this.metaSet(JRA_ENTRIES_META_RESULT, "exists");
      this.deps.onWarn(`JRA の出馬表の取得: この試みは既に行われています(場=${unit} 試行=${attempt}。JRA には送っていません)`);
      return this.finishStep(state, startedAt + JRA_ENTRIES_STEP_GAP_MS, "failed");
    }

    // 3. 取得と保存。取得口は投げない契約だが、どんな例外でも分類だけを残す。
    let session: JraEntriesSession | null = null;
    let work: Work;
    try {
      session = (fetcher as JraEntriesFetcher).open();
      work = venue === undefined ? await this.discover(session, state, date) : await this.fetchVenue(session, state, venue, date);
    } catch {
      work = { result: "other", racesTotal: 0, racesSaved: 0, horsesSkipped: 0, complete: false, failed: true };
    }
    const requests = session?.requestCount ?? 0;
    const elapsedMs = Math.max(0, this.deps.now() - startedAt);

    // 4. 結果の記録。失敗しても、保存済みのものは戻さない。
    const finish: JraEntriesFinish = {
      finishedAt: this.deps.now(),
      result: work.result,
      racesTotal: work.racesTotal,
      racesSaved: work.racesSaved,
      horsesSkipped: work.horsesSkipped,
      requests,
      elapsedMs,
      complete: work.complete,
    };
    try {
      await (store as JraEntriesStoreLike).finish(date, unit, attempt, finish);
    } catch {
      this.deps.onWarn(`JRA の出馬表の取得: 結果(${work.result})を D1 に記録できませんでした(場=${unit} 試行=${attempt})`);
    }
    this.metaSet(JRA_ENTRIES_META_RESULT, work.result);
    this.metaSet(JRA_ENTRIES_META_LAST_MS, String(elapsedMs));
    this.deps.onInfo?.(`JRA の出馬表の取得: 場=${unit} 試行=${attempt} 結果=${work.result} 本数=${requests} 保存=${work.racesSaved}/${work.racesTotal} 所要=${elapsedMs}ms`);

    const exhausted = venue === undefined ? !state.discovered && state.discoveryAttempts >= state.discoveryLimit : !venue.done && venue.attempts >= JRA_ENTRIES_MAX_ATTEMPTS;
    if (work.failed) {
      this.deps.onWarn(
        `JRA の出馬表の取得: 取得できませんでした(場=${unit} 試行=${attempt} 分類: ${work.result}。${exhausted ? "試行を使い切ったため、これ以上取り直しません" : `${JRA_ENTRIES_RETRY_MS / 60_000} 分後に取り直します`})`,
      );
    }
    const nextAt = this.deps.now() + (work.failed ? JRA_ENTRIES_RETRY_MS : JRA_ENTRIES_STEP_GAP_MS);
    return this.finishStep(state, nextAt, work.failed ? "failed" : "ok");
  }

  /** 状態と次の時刻を書き、済んだら印を書く。 */
  private finishStep(state: State, nextAt: number, result: JraEntriesStepOutcome["result"]): JraEntriesStepOutcome["result"] {
    this.saveState(state);
    this.metaSet(JRA_ENTRIES_META_NEXT_AT, String(nextAt));
    if (!this.pending(state)) {
      this.metaSet(JRA_ENTRIES_META_DONE, "1");
    }
    return result;
  }

  /** 開催の選択 → 場ごとのレースの選択。 */
  private async discover(session: JraEntriesSession, state: State, date: string): Promise<Work> {
    const facts = this.deps.facts();
    const failed = (result: string): Work => ({ result, racesTotal: 0, racesSaved: 0, horsesSkipped: 0, complete: false, failed: true });
    const venues = await session.listVenues(date);
    if (venues.status !== "ok") {
      return failed(venues.status);
    }
    const wanted = venues.value.filter((v) => facts.venueCodes.length === 0 || facts.venueCodes.includes(v.venueCode)).slice(0, MAX_VENUES);
    if (wanted.length === 0) {
      return failed("no-venues");
    }
    const previous = new Map(state.venues.map((v) => [v.code, v]));
    const next: VenueState[] = [];
    let listed = 0;
    for (const link of wanted) {
      const old = previous.get(link.venueCode);
      const races = await session.listRaces(link.drlCname, date, link.venueCode);
      if (races.status === "ok") {
        listed += 1;
      }
      next.push({
        code: link.venueCode,
        drl: link.drlCname,
        // たどり直しでは、取り残しのレースは新しい CNAME で取り直す(済んだ場・試行の回数は引き継ぐ)。
        races: old?.done === true ? [] : races.status === "ok" ? [...races.value] : null,
        attempts: old?.attempts ?? 0,
        done: old?.done ?? false,
      });
    }
    state.venues = next;
    state.discovered = true;
    return { result: "ok", racesTotal: wanted.length, racesSaved: listed, horsesSkipped: 0, complete: false, failed: false };
  }

  /** 1 場の詳細ページ(取り残しのレースだけ)。 */
  private async fetchVenue(session: JraEntriesSession, state: State, venue: VenueState, date: string): Promise<Work> {
    const store = this.deps.store as JraEntriesStoreLike;
    const rediscover = (word: JraPageFailure): void => {
      // 符号が古い(param-error)。開催の選択からたどり直す(1 回だけ。試行の上限を足す)。
      if (word === "param-error" && !state.rediscovered) {
        state.rediscovered = true;
        state.discovered = false;
        state.discoveryLimit = state.discoveryAttempts + JRA_ENTRIES_MAX_ATTEMPTS;
      }
    };
    const bail = (result: string): Work => ({ result, racesTotal: 0, racesSaved: 0, horsesSkipped: 0, complete: false, failed: true });

    if (venue.races === null) {
      const listed = await session.listRaces(venue.drl, date, venue.code);
      if (listed.status !== "ok") {
        rediscover(listed.status);
        return bail(listed.status);
      }
      venue.races = [...listed.value];
    }
    const targets = venue.races;
    const budget = Math.max(0, JRA_ENTRIES_PAGES_PER_STEP - session.requestCount);
    const saved: SavedRace[] = [];
    const savedCnames: string[] = [];
    const failedCnames: string[] = [];
    let firstFailure: JraPageFailure | null = null;
    let skipped = 0;
    let visited = 0;
    for (const cname of targets.slice(0, budget)) {
      visited += 1;
      const r = await session.fetchRace(cname);
      if (r.status === "ok") {
        saved.push({ raceId: r.value.race.raceId, horses: r.value.horses });
        savedCnames.push(cname);
        skipped += r.value.skipped;
        continue;
      }
      failedCnames.push(cname);
      firstFailure ??= r.status;
      if (r.status === "param-error") {
        rediscover(r.status);
        break;
      }
    }
    const unvisited = targets.slice(visited);

    // 保存(1 回の呼び出し)。失敗したら、保存できなかったレースは取り残しに戻す。
    let saveFailed = false;
    if (saved.length > 0) {
      try {
        await store.saveRaces(date, saved);
      } catch {
        saveFailed = true;
      }
    }
    const remaining = targets.filter((c) => failedCnames.includes(c) || unvisited.includes(c) || (saveFailed && savedCnames.includes(c)));
    venue.races = remaining;
    venue.done = remaining.length === 0;
    const racesSaved = saveFailed ? 0 : saved.length;
    const failure = saveFailed ? "save-failed" : firstFailure;
    return {
      result: venue.done ? "ok" : failure !== null ? (racesSaved > 0 ? "partial" : failure) : "partial",
      racesTotal: visited,
      racesSaved,
      horsesSkipped: saveFailed ? 0 : skipped,
      complete: venue.done,
      failed: failure !== null,
    };
  }
}
