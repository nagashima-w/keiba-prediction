/**
 * 重賞の過去傾向の集計結果の**型だけ**(Issue #201 で `grade-winner-trend.ts` から切り出した。実行時のコードも import も無い)。
 *
 * 切り出した理由: `build-prompt.ts` がこの型を `import type` で使う。`grade-winner-trend.ts` は `fetch-grade-winner.ts` → `http-client.ts`(undici・iconv-lite・`Buffer`)・
 * `parse-grade-winner.ts`(`node:zlib`)を値で import するので、**型だけの import でも、型検査(tsc)はその先まで辿る**。クラウド版のクライアント(`cloud/tsconfig.client.json`。
 * Node の型なし)が `buildPromptPreview` を使うと、`packages/core/node_modules` の無い CI の配置で TS2307・TS2591 になった(esbuild は型の import を消すのでバンドルは壊れない)。
 * 型だけのモジュールに分けて、`build-prompt.ts` の型の閉包を node 依存から切り離す。`grade-winner-trend.ts` から再 export しているので、既存の import(index・pipeline・テスト)は変わらない。
 */

/** 値ごとの出現回数(馬場内訳・柵内訳に使う)。 */
export interface GradeWinnerValueCount {
  readonly 値: string;
  readonly 回数: number;
}

/** 最小〜最大のレンジ。 */
export interface GradeWinnerRange {
  readonly min: number;
  readonly max: number;
}

/** summarizeGradeWinnerTrend の出力。常に同じキー構成の構造化オブジェクトに固定する。 */
export interface GradeWinnerTrendSummary {
  /**
   * 集計に渡された過去回の総数(条件一致・条件除外を問わない。10とは限らない)。
   * Issue #153 以降、`collectGradeWinnerTrend` 経由では先読みリークで除いた回
   * (当該回自身・基準日以降・日付不明)を**数えない**(除いた後の件数)。
   */
  readonly 対象回数: number;
  /** jyo+track+kyoriが一致した回数。 */
  readonly 条件一致回数: number;
  /** 条件不一致で除外した回数(= 対象回数 - 条件一致回数)。 */
  readonly 条件除外回数: number;
  /** 条件一致した回の出走頭数レンジ。集計対象が無ければ null。 */
  readonly 頭数レンジ: GradeWinnerRange | null;
  /** 条件一致した回の馬場状態の内訳。 */
  readonly 馬場内訳: readonly GradeWinnerValueCount[];
  /** 条件一致した回の柵の内訳(フィルタには使わず材料として提示するのみ)。 */
  readonly 柵内訳: readonly GradeWinnerValueCount[];
  /** 条件一致した回の複勝圏内(確定着順3着以内、降着は確定着順で判定)馬の延べ頭数。 */
  readonly 複勝圏内馬数: number;
  /** 複勝圏内馬の単勝人気レンジ。算出不能なら null。 */
  readonly 人気レンジ: GradeWinnerRange | null;
  /**
   * 人気レンジの算出に使えたサンプル数(プロンプト誤読解消。2026-07-28小改善)。
   * 複勝圏内馬数(延べ頭数)と食い違うことがある(複勝圏内馬のninkiがnull/0の場合等)ため、
   * 「複勝圏内(延べN頭)」のNとは別に、人気側自身のサンプル数を持たせて誤読を防ぐ。
   * レンジが null のときは常に 0。
   */
  readonly 人気サンプル数: number;
  /** 複勝圏内馬のうち単勝人気が二桁(10番人気以上)だった延べ頭数。 */
  readonly 二桁人気頭数: number;
  /** 複勝配当(fuku_pay1〜3)のレンジ。算出不能なら null。 */
  readonly 複勝配当レンジ: GradeWinnerRange | null;
  /** 複勝配当(fuku_pay1〜3)の中央値。算出不能なら null。 */
  readonly 複勝配当中央値: number | null;
  /**
   * 複勝配当レンジ・中央値の算出に使えたサンプル数(プロンプト誤読解消。2026-07-28小改善)。
   * 複勝圏内馬数(延べ頭数)と食い違うことがある。食い違いが起きる実在条件:
   * (a) 7頭以下等で fuku_pay3 が欠損する回、(b) 複勝非発売で fuku_pay1〜3 が全欠の回、
   * (c) 3着同着で複勝圏内は4頭だが payback は3枠のみの回、(d) payback 自体が null の回、
   * (e) fuku_pay が0または非有限値の回。レンジが null のときは常に 0。
   */
  readonly 複勝配当サンプル数: number;
  /**
   * 複勝圏内馬の平均通過順相対(コーナー通過順の平均÷頭数。leg-style.ts の
   * classifyRunLegStyleFull による算出を再利用)。ラベル化はしない(参考値)。算出不能なら null。
   */
  readonly 平均通過順相対: number | null;
  /** 平均通過順相対の算出に使えたサンプル数。 */
  readonly 通過順相対サンプル数: number;
  /** 複勝圏内馬の平均上がり3F(秒)。算出不能なら null。 */
  readonly 平均上がり: number | null;
  /** 平均上がりの算出に使えたサンプル数。 */
  readonly 上がりサンプル数: number;
  /**
   * 複勝圏内馬の平均馬番相対(umaban÷頭数。ラベル化はしない=内有利/外有利という判定値を持たない)。
   *
   * 命名について(code-reviewer指摘・要修正1対応): 当初「平均枠相対」としていたが、実装は
   * wakuban(枠番。1〜8)ではなく umaban(馬番)を使っている。日本の競馬用語で「枠」と「馬番」は
   * 別概念(既存の scorer 側「枠順バイアス」は実際の枠番ベース)であり、「枠」を名乗ると
   * LLMや将来の読者が実際の枠番グループのバイアスと誤読するため、名称を実装(umaban)に
   * 合わせて「馬番相対」へ改称した(wakuban側の実装への変更は行わない: 頭数が少ないレースでは
   * 枠番と馬番がほぼ一致し、かつ馬番の方が粒度が細かく相対位置の指標として情報量が多いため)。
   */
  readonly 平均馬番相対: number | null;
  /** 平均馬番相対の算出に使えたサンプル数。 */
  readonly 馬番相対サンプル数: number;
}
