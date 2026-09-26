/**
 * mixed-allocation-queue — 混在配分の計算をレース単位に分割し、1ステップ=1レースで
 * 進める「実行役」(Issue #110・#24-C2)。
 *
 * `mixed-allocation-cache.ts`(値の記憶。キーの11項目・比較ロジックの唯一の定義)と
 * 組み合わせて使う。本モジュール自体はReactに依存しない純粋なオブジェクト/関数として実装し、
 * `BatchAnalysisView.tsx`からは1インスタンスを`useRef`で保持して呼び出すだけの薄い配線にする
 * (既存の`mixedAllocationCacheRef`と同じ流儀)。
 *
 * ## 設計上の危険その1(AC-3'): 「スケジュール開始時に捕まえた古いキー」の使い回し
 *
 * 一括分析画面は毎レンダーで`order`(表示順のraceId一覧)・`keyFor`(レースごとの現在の
 * キャッシュキーを組み立てる関数)・`compute`(実際の計算関数)を作り直す。これらは
 * `props.betAllocationSettings`(設定タブでの変更、タブ復帰時の再読込)に依存するため、
 * **計算の途中で内容が変わりうる**。
 *
 * `setInputs()`は呼ばれるたびに**必ず最新の`inputs`へ差し替える**(内部で保持するのは
 * 直近1回ぶんの参照のみ)。「最初の`setInputs`呼び出し時のものだけを覚え、以降の呼び出しを
 * 無視する」実装をしてしまうと、途中で設定が変わっても古い設定のままステップが進み続け、
 * 「変更後の設定で計算したはずの結果が、実は変更前の設定で計算されている」という
 * AC-3'(b)違反が起きる(`mixed-allocation-queue.test.ts`「AC-3'」で、この変異を注入すると
 * 赤になることを固定している)。
 *
 * さらに、`step()`は`pendingRaceIds()`の算出も含め、呼ばれるたびに**そのときの`inputs`から
 * 都度`keyFor(raceId)`を呼び直す**(過去の`step()`呼び出し時に組み立てたキーを保持して
 * 使い回さない)。これにより、表示側(`BatchAnalysisView.tsx`)が「今のキーで`peek`する」
 * 限り、このモジュールが過去にどんなキーで何を書き込んでいようと表示の正しさは
 * `MixedAllocationCache`のキー一致判定だけで担保される(AC-3'(a))。
 *
 * ## 設計上の危険その2(AC-7'): 失敗の無限リトライ
 *
 * `compute`が例外を投げたとき、キャッシュに何も書かずに次のレースへ進むと、次の
 * `pendingRaceIds()`で同じレースが再び「未計算」として現れ、また計算して、また失敗して……
 * という無限ループになる(1ステップごとにReactの再描画を挟む設計〈AC-2〉のため、これは
 * 「再描画のたびにCPUを回し続けて止まらない」ことを意味し、ブロッキング基準の区分3
 * 〈クラッシュ相当〉に当たる)。
 *
 * そのため`step()`は、失敗も`{status:"error"}`という値として**`MixedAllocationCache.get()`で
 * キャッシュに書き込む**(成功と全く同じ書き込み経路を使う。書き込み先を分けない)。
 * `peek()`はこの値もそのまま返すため、以降の`pendingRaceIds()`はこのレースを「計算済み」
 * として扱い、**同じキーのままでは再計算しない**。設定が変わってキーが変われば
 * (`get`/`peek`の通常のキー不一致判定により)自然に再試行される。
 *
 * なお`buildMixedAllocationDisplay`(`mixed-allocation-view.ts`)が実際に例外を投げる経路が
 * 現時点であるかは調査していない。既存の`resolvePlaceOnlyStake`のtry/catchと同じ
 * 「防御的な二重化」として置く(本リポジトリにReact error boundaryが1つも無いため。
 * `mixed-allocation-view.ts`の`resolvePlaceOnlyStake`のJSDoc参照)。
 *
 * ## 設計上の危険その3(AC-9・Issue #110メタレビュー差し戻し): 「ループが止まったまま再開しない」
 *
 * 当初の実装は、Reactの`useEffect(..., [hasPendingAllocation])`(未計算が1件以上あるかの
 * **真偽値**を依存配列にする)で「1ステップ進めては次のタイマーを張る」ループを駆動していた。
 * しかしcode-reviewerがReact 18本体のソース(`ensureRootIsScheduled`)を根拠に指摘した
 * とおり、**「既に予約済みの描画タスクがあると、同じ優先度の別の更新はその描画にまとめられる」**
 * ため、次の手順で**ループが止まったまま二度と再開しない**経路が実在する:
 *
 * 1. ループが最後の1件を計算し終え、未計算が0件になってタイマーが張られなくなる
 * 2. その直後(次のコミットが実際に走る前)に設定変更等で未計算が再び生じる
 * 3. Reactのバッチ処理により、「未計算0件」を経由するコミットが実際には発生せず、
 *    依存配列`[hasPendingAllocation]`の値は`true`(直前)→`true`(直後)のまま変化しない
 * 4. 依存配列が変化しないため`useEffect`は再実行されず、新しいタイマーが張られない
 * 5. → 利用者には「配分を計算中…」と出続けるが実際には何も計算されない状態が固定化する
 *    (別のタブへ行って戻り、コンポーネントが再マウントされるまで直らない)
 *
 * **対策**: 再開の判断を「直前の状態からの遷移」ではなく、**呼ばれるたびに「今、タイマーが
 * 張られているか」「今、未計算があるか」だけを見る冪等な判定**に変える
 * (`createAllocationScheduler`の`sync()`)。過去の真偽値を一切記憶しないため、
 * 「0件を経由しないバッチ処理」が起きても、`sync()`が**呼ばれた時点の実際の状態**を見て
 * 正しく再スケジュールする。呼び出し側(`BatchAnalysisView.tsx`)は依存配列の無い
 * `useEffect(() => { scheduler.sync(); })`(コミットのたびに必ず呼ぶ。cleanupは持たない)
 * にする。`sync()`自体が「既に張られていれば何もしない」ため、無関係な再描画のたびに
 * 呼んでもタイマーを張り直し続けて発火しない「飢餓」は起きない(`mixed-allocation-queue.test.ts`
 * 「createAllocationScheduler」のテーブル駆動テスト参照)。
 */

import type { MixedAllocationCache, MixedAllocationCacheKey } from "./mixed-allocation-cache.js";

/**
 * 1レースぶんの計算結果(成功/失敗を区別する。AC-7')。
 * 失敗も「結果」としてキャッシュに記録するため、値の型`T`とは別にこの判別共用体で包む。
 */
export type AllocationOutcome<T> =
  | { readonly status: "ok"; readonly value: T }
  | { readonly status: "error" };

/**
 * `AllocationQueueRunner.setInputs`が受け取る最新入力。呼び出し側(`BatchAnalysisView.tsx`)は
 * 毎レンダーでこれを作り直し、`setInputs`へ渡す。
 */
export interface AllocationQueueInputs<T> {
  /** 計算対象レースの表示順(先頭から計算する)。 */
  readonly order: readonly string[];
  /**
   * レースIDから「今の」キャッシュキーを組み立てる。`step`・`pendingRaceIds`・`peek`は
   * 呼ばれるたびにこの関数を呼び直す(結果を保持して使い回さない)。
   */
  readonly keyFor: (raceId: string) => MixedAllocationCacheKey;
  /** 実際の計算(例外を投げてもよい。`step`側でtry/catchし、失敗として記録する)。 */
  readonly compute: (raceId: string, key: MixedAllocationCacheKey) => T;
}

/** レース単位で計算を1ステップずつ進める実行役。本体はReactに依存しない。 */
export interface AllocationQueueRunner<T> {
  /**
   * 最新の入力に差し替える。**呼ぶたびに`inputs`をそのまま採用する**(最初の呼び出しだけを
   * 覚えて以降を無視すると、AC-3'(b)が破れる。上記モジュールJSDoc参照)。
   */
  setInputs(inputs: AllocationQueueInputs<T>): void;
  /**
   * `raceId`の現在の結果を返す(無ければ`undefined`。`compute`は呼ばない)。
   * `setInputs`されていなければ常に`undefined`。
   */
  peek(raceId: string): AllocationOutcome<T> | undefined;
  /**
   * 現在の`inputs.order`のうち、まだ結果が無い(`peek`が`undefined`を返す)レースID一覧
   * (`order`と同じ並び。先頭が次に`step()`で計算される)。
   */
  pendingRaceIds(): readonly string[];
  /**
   * `pendingRaceIds()`の先頭のレースを1件だけ計算し、キャッシュへ書き込む(成功・失敗いずれも)。
   * 対象が無ければ何もしない。
   */
  step(): void;
}

/**
 * `AllocationQueueRunner`を新規作成する。`cache`は呼び出し側(`BatchAnalysisView.tsx`)が
 * `props`経由で受け取ったもの(コンポーネントの生存期間を超えて`App`側が保持する。
 * Issue #110・裁定「B. キャッシュの寿命をBatchAnalysisViewより長くする」)をそのまま渡す想定。
 * `runner`自身は`inputs`(直近1回ぶん)以外の状態を持たないため、`cache`さえ共有されていれば
 * `BatchAnalysisView`の再マウントのたびに新しい`runner`を作っても、進捗(=`cache`の中身)は
 * 引き継がれる。
 */
export function createAllocationQueueRunner<T>(
  cache: MixedAllocationCache<AllocationOutcome<T>>,
): AllocationQueueRunner<T> {
  let inputs: AllocationQueueInputs<T> | null = null;

  return {
    setInputs(next) {
      inputs = next;
    },
    peek(raceId) {
      if (inputs === null) {
        return undefined;
      }
      return cache.peek(inputs.keyFor(raceId));
    },
    pendingRaceIds() {
      if (inputs === null) {
        return [];
      }
      const current = inputs;
      return current.order.filter((raceId) => cache.peek(current.keyFor(raceId)) === undefined);
    },
    step() {
      if (inputs === null) {
        return;
      }
      const current = inputs;
      const pending = current.order.filter(
        (raceId) => cache.peek(current.keyFor(raceId)) === undefined,
      );
      const raceId = pending[0];
      if (raceId === undefined) {
        return;
      }
      const raceKey = current.keyFor(raceId);
      let outcome: AllocationOutcome<T>;
      try {
        outcome = { status: "ok", value: current.compute(raceId, raceKey) };
      } catch {
        outcome = { status: "error" };
      }
      // 成功・失敗いずれも同じ書き込み経路(get)を使う(AC-7'。失敗を記録しないと、
      // 次のpendingRaceIds()でまた「未計算」に見えてしまい無限ループになる)。
      cache.get(raceKey, () => outcome);
    },
  };
}

/**
 * `createAllocationScheduler`が操作する対象の最小限の形。`AllocationQueueRunner<T>`は
 * どんな`T`でもこの形を満たす(`pendingRaceIds`・`step`のどちらのシグネチャも`T`を
 * 参照しないため)。スケジューラ自体は値の型を一切知らなくてよい。
 */
export interface AllocationSchedulable {
  pendingRaceIds(): readonly string[];
  step(): void;
}

/** `createAllocationScheduler`が受け取る依存(タイマー等はReact側から注入する)。 */
export interface AllocationSchedulerDeps {
  readonly runner: AllocationSchedulable;
  /**
   * 「後で1回呼んでほしい」処理を予約し、識別できるハンドルを返す。
   * 呼び出し側(`BatchAnalysisView.tsx`)は`(cb) => window.setTimeout(cb, 0)`を渡す想定。
   */
  readonly schedule: (callback: () => void) => number;
  /** `schedule`が返したハンドルを取り消す(`window.clearTimeout`相当)。 */
  readonly cancel: (handle: number) => void;
  /**
   * 1レース計算した直後に呼ぶ(再描画の要求。呼び出し側がReactのstateを更新する想定)。
   * この呼び出しの結果として新しいコミットが起き、その後の`sync()`呼び出しで続きが
   * 判断される(スケジューラ自身は再帰しない。上記モジュールJSDoc「設計上の危険その3」参照)。
   */
  readonly onStepped: () => void;
}

/**
 * 計算ループを1ステップずつ進めるための「再開してよいか」の判断だけを持つ、
 * Reactに依存しない純粋なオブジェクト(AC-9・Issue #110メタレビュー差し戻し)。
 */
export interface AllocationScheduler {
  /**
   * 描画のたびに(依存配列を付けず、コミットのたびに)呼ぶ。**呼ばれた時点の実際の状態
   * だけを見る**(タイマーが既に張られているか・未計算があるか)。過去にどんな真偽値を
   * 見たかは一切記憶しない。既に張られていれば何もしない(冪等。飢餓の防止)。
   */
  sync(): void;
  /** アンマウント時に呼ぶ。張られているタイマーがあれば取り消す。 */
  dispose(): void;
}

export function createAllocationScheduler(deps: AllocationSchedulerDeps): AllocationScheduler {
  let timerHandle: number | null = null;
  let disposed = false;

  const fire = (): void => {
    // 発火した時点で「タイマーが無い」状態に戻す(次のsync()が正しく再スケジュールできるように、
    // runner.step()より前に必ず行う)。
    timerHandle = null;
    if (disposed) {
      // disposeより後にどうしても発火してしまった場合の二重防御(cancelを呼んでいても、
      // 実行環境によっては間に合わないことがありうる想定。上記モジュールJSDoc参照)。
      return;
    }
    deps.runner.step();
    deps.onStepped();
  };

  return {
    sync() {
      if (disposed) {
        return;
      }
      if (timerHandle !== null) {
        // 既に張られている(冪等。無関係な再描画のたびに呼んでも張り直さない)。
        return;
      }
      if (deps.runner.pendingRaceIds().length === 0) {
        return;
      }
      timerHandle = deps.schedule(fire);
    },
    dispose() {
      disposed = true;
      if (timerHandle !== null) {
        deps.cancel(timerHandle);
        timerHandle = null;
      }
    },
  };
}
