/**
 * 検証画面(`#verify`)の表示用データ(Issue #219。純関数)。`view.ts` がこれを VNode にする。状態(取得の状態・区分・通信中)を受け取り、文言・数値の整形・注記を導く
 * (DOM・fetch・時計に触れない)。数値の整形は exe と同じ(`verify-format.ts`)。
 *
 * **スマホ幅(360px 前後)で横に伸びない形**にする: exe が「/」区切りの 1 行で出していた内訳は、項目ごとの行に分ける(数値の 4 つ組は 2×2 のタイル)。横スクロールは使わない。
 * **サーバ由来の文は読まない**: 出す文言はすべてクライアントの固定の文言(サーバが返す日時・件数・券種コードは、整形して埋め込むだけ)。
 */
import { formatJstDateTime } from "./date";
import type { CalibrationBinView, ProposedSummaryView, PromptVersionView, VerifyOutcome, VerifyReportView, VerifyVenue } from "./api-verify";
import {
  additionalInstructionsFullText,
  additionalInstructionsSummary,
  calibrationBarWidthPercent,
  directionLabel,
  exclusionRows,
  formatAdjustment,
  formatBinRange,
  formatPayoutBreakdown,
  formatRate,
  formatUnknownBetTypeNotice,
  formatYen,
  markLabel,
  overconfidenceLabel,
  PROPOSED_BET_LABELS,
  promptVersionCalibrationHeading,
  promptVersionLabel,
  venueLabel,
} from "./verify-format";

/** 取得の状態。 */
export type VerifyLoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "ready"; readonly outcome: VerifyOutcome };

export interface VerifyModelInput {
  readonly load: VerifyLoadState;
  readonly venue: VerifyVenue;
  /** 通信中(取得・更新)。 */
  readonly busy: boolean;
  /** 自動更新を止めている(通信の失敗が続いた・回数の上限)。 */
  readonly pollStopped: boolean;
  /** キャリブレーションを開いている版のキー(`versionKey`)。 */
  readonly expandedVersions: readonly string[];
}

export type Tone = "info" | "ok" | "error" | "wait";

export interface Tile {
  readonly label: string;
  readonly value: string;
  /** 回収率のタイル(強調)。 */
  readonly strong: boolean;
}

export interface RowView {
  readonly label: string;
  readonly value: string;
}

export interface TypeRowView {
  readonly label: string;
  readonly count: string;
  readonly rate: string;
}

export interface BetSection {
  readonly heading: string;
  readonly description: string;
  /** 集計対象が 0 件のとき、タイルの代わりに出す文。 */
  readonly empty: string | null;
  readonly tiles: readonly Tile[];
  readonly payoutLine: string | null;
  readonly exclusionHeading: string;
  readonly exclusions: readonly RowView[];
  readonly exclusionNote: string | null;
}

export interface ProposedSection {
  readonly heading: string;
  readonly description: string;
  readonly empty: string | null;
  readonly tiles: readonly Tile[];
  readonly typeHeading: string;
  readonly types: readonly TypeRowView[];
  /** 判定不能(集計対象外)の券種別の点数。0 点なら null。 */
  readonly unjudged: { readonly heading: string; readonly rows: readonly RowView[] } | null;
  readonly unknownNotice: string | null;
  readonly populationHeading: string;
  readonly population: readonly RowView[];
}

/** 1 つの項目の値(名前つき)。名前と値を並べて折り返せるように、「/」区切りの 1 行にはしない。 */
export interface StatCell {
  readonly name: string;
  readonly value: string;
}

/** 帯グラフ(`progress`。`value`/`max` は整数。実複勝率を ×1000 で丸めた値)。 */
export interface BarView {
  readonly value: number;
  readonly max: number;
  readonly label: string;
}

/** 補正方向・キャリブレーションの帯・印・(版別の)帯の 1 行。 */
export interface StatRow {
  readonly label: string;
  readonly cells: readonly StatCell[];
  readonly bar: BarView | null;
}

/** 補正方向×結果・印別的中率の節。 */
export interface StatSection {
  readonly heading: string;
  readonly description: string;
  readonly rows: readonly StatRow[];
}

/** キャリブレーションの節。帯が 0 本のときは `empty` に文を入れる。 */
export interface CalibrationSection extends StatSection {
  readonly empty: string | null;
}

/** 版別比較の 1 版のカード。キャリブレーションは開いたときだけ行を持つ。 */
export interface VersionCard {
  /** 開閉の識別子(`versionKey`)。 */
  readonly key: string;
  readonly title: string;
  /** 「追加指示: 要約」。 */
  readonly instructions: string;
  readonly included: string;
  readonly tiles: readonly Tile[];
  readonly expanded: boolean;
  readonly toggleLabel: string;
  /** 開いたときだけ: 見出し(版+追加指示の要約)・追加指示の全文・帯の行(帯が 0 本なら `calibrationEmpty`)。 */
  readonly calibrationHeading: string | null;
  readonly fullInstructions: string | null;
  readonly calibrationEmpty: string | null;
  readonly calibrationRows: readonly StatRow[];
}

export interface VersionsSection {
  readonly heading: string;
  readonly description: string;
  /** 版不明の行があるときの、その内訳の注記。 */
  readonly unknownNote: string | null;
  /** 版別が 0 件のときの文。 */
  readonly empty: string | null;
  readonly cards: readonly VersionCard[];
}

export interface VerifyNotice {
  readonly tone: Tone;
  readonly text: string;
}

export interface VerifyModel {
  readonly kind: "verify";
  readonly backHref: "#";
  readonly venueTabs: readonly { readonly venue: VerifyVenue; readonly label: string; readonly current: boolean }[];
  readonly loading: boolean;
  readonly refreshDisabled: boolean;
  readonly error: string | null;
  readonly pollNotice: string | null;
  /** 集計が出せない間の説明(補完中・柵・上限)。 */
  readonly unavailable: VerifyNotice | null;
  /** 集計時点(JST)。 */
  readonly computedAt: string | null;
  /** 古い集計・発走時刻の欠落などの注記。 */
  readonly notices: readonly VerifyNotice[];
  readonly bet: BetSection | null;
  readonly proposed: ProposedSection | null;
  /** プロンプト版別の比較(Issue #220。区分に依らず全体)。 */
  readonly versions: VersionsSection | null;
  /** 補正方向×結果(Issue #220)。 */
  readonly direction: StatSection | null;
  /** キャリブレーション(Issue #220)。 */
  readonly calibration: CalibrationSection | null;
  /** 印別的中率(Issue #220)。 */
  readonly marks: StatSection | null;
}

const POLL_STOPPED_NOTICE = "自動更新を止めました。「更新」で取り直せます。";

function tiles(betCount: number, totalStake: number, totalReturn: number, recoveryRate: number | null): readonly Tile[] {
  return [
    { label: "賭け数", value: `${betCount}点`, strong: false },
    { label: "投資額", value: formatYen(totalStake), strong: false },
    { label: "回収額", value: formatYen(totalReturn), strong: false },
    { label: "回収率", value: formatRate(recoveryRate), strong: true },
  ];
}

function betSection(report: VerifyReportView): BetSection {
  const suspicious = report.excludedLookaheadSuspectCount + report.excludedLookaheadUnknownCount > 0;
  return {
    heading: "累積回収率",
    description: "EVプラスの馬の複勝を、一律 100 円ずつ買ったとした場合。",
    empty: report.includedAnalysisCount === 0 ? "集計対象がありません。" : null,
    tiles: tiles(report.bet.betCount, report.bet.totalStake, report.bet.totalReturn, report.bet.recoveryRate),
    payoutLine: `払戻内訳: ${formatPayoutBreakdown(report.bet)}(実配当が無い点は複勝下限で近似)`,
    exclusionHeading: "集計の内訳",
    exclusions: exclusionRows(report),
    exclusionNote: suspicious ? "該当レースを分析し直すと、集計に戻ります。" : null,
  };
}

function rateRow(label: string, s: ProposedSummaryView): TypeRowView {
  return { label, count: `${s.betCount}点`, rate: formatRate(s.recoveryRate) };
}

function proposedSection(report: VerifyReportView): ProposedSection {
  const p = report.proposedBet;
  return {
    heading: "配分ベースの回収率",
    description: "分析時点の設定で実際に提案した配分額を、そのまま賭け金とした場合。上の累積回収率とは賭け金の仮定が違うので、合算しません。",
    empty: report.includedAnalysisCount === 0 ? "集計対象がありません。" : null,
    tiles: tiles(p.overall.betCount, p.overall.totalStake, p.overall.totalReturn, p.overall.recoveryRate),
    typeHeading: "券種別(点数・回収率)",
    types: PROPOSED_BET_LABELS.map(({ type, label }) => rateRow(label, p.byType[type])),
    unjudged:
      p.overall.unjudgedCount > 0
        ? { heading: "判定不能(集計対象外)", rows: PROPOSED_BET_LABELS.map(({ type, label }) => ({ label, value: `${p.byType[type].unjudgedCount}点` })) }
        : null,
    unknownNotice: formatUnknownBetTypeNotice(p.unknownBetType),
    populationHeading: "母集団",
    population: [
      { label: "配分あり", value: `${p.population.allocated}件` },
      { label: "見送り", value: `${p.population.skipped}件` },
      { label: "未到達", value: `${p.population.unreached}件` },
      { label: "記録なし", value: `${p.population.noRecord}件` },
    ],
  };
}

/** 実複勝率の帯グラフ。`progress` の value/max は整数なので、実複勝率(0〜1)を ×1000 で丸める。 */
function rateBar(rate: number | null): BarView {
  const value = Math.min(1000, Math.max(0, Math.round(calibrationBarWidthPercent(rate) * 10)));
  return { value, max: 1000, label: `実複勝率 ${formatRate(rate)}` };
}

/**
 * キャリブレーションの行。過信バイアスは帯と**同じ添字**で対応づける(exe の `CalibrationTable` と同じ。無ければ「予測−実績」は -)。
 * 版別のキャリブレーション(`verify-versions` の射影)は帯に過信バイアスを含むので、`gaps` を帯と同じ長さで渡す。
 */
export function calibrationRows(bins: readonly CalibrationBinView[], gaps: readonly (number | null)[]): readonly StatRow[] {
  return bins.map((bin, index) => {
    const gap = gaps[index] ?? null;
    return {
      label: formatBinRange(bin),
      bar: rateBar(bin.actualPlaceRate),
      cells: [
        { name: "予測件数", value: `${bin.predictedCount}件` },
        { name: "複勝件数", value: `${bin.placedCount}件` },
        { name: "実複勝率", value: formatRate(bin.actualPlaceRate) },
        { name: "予測−実績", value: gap === null ? "-" : `${formatAdjustment(gap)}(${overconfidenceLabel(gap)})` },
      ],
    };
  });
}

/** 版別の開閉のキー。版不明(null)と、文字列の版が衝突しない形にする。 */
export function versionKey(promptVersion: string | null): string {
  return promptVersion === null ? "unknown" : `v:${promptVersion}`;
}

const UNKNOWN_VERSION_NOTE = "「版不明」は版記録導入前の旧データと、APIキー未設定で実行したLLM未使用の分析の両方を含みます(区別できません)。";

function versionCard(v: PromptVersionView, expandedKeys: ReadonlySet<string>): VersionCard {
  const key = versionKey(v.promptVersion);
  const expanded = expandedKeys.has(key);
  return {
    key,
    title: promptVersionLabel(v.promptVersion),
    instructions: `追加指示: ${additionalInstructionsSummary(v.additionalInstructions)}`,
    included: `集計件数 ${v.includedAnalysisCount}件`,
    tiles: tiles(v.bet.betCount, v.bet.totalStake, v.bet.totalReturn, v.bet.recoveryRate),
    expanded,
    toggleLabel: expanded ? "キャリブレーションを閉じる" : "キャリブレーションを表示",
    calibrationHeading: expanded ? promptVersionCalibrationHeading(v.promptVersion, v.additionalInstructions) : null,
    fullInstructions: expanded ? `追加指示(全文): ${additionalInstructionsFullText(v.additionalInstructions)}` : null,
    calibrationEmpty: expanded && v.calibration.length === 0 ? "データがありません。" : null,
    calibrationRows: expanded ? calibrationRows(v.calibration, v.overconfidenceGaps) : [],
  };
}

function versionsSection(versions: readonly PromptVersionView[], expandedVersions: readonly string[]): VersionsSection {
  const expandedKeys = new Set(expandedVersions);
  return {
    heading: "プロンプト版別比較",
    description: "プロンプトの版ごとの累積回収率とキャリブレーション。版別は全体の集計です(上の区分の切替には連動しません)。同じ版でも追加指示が違えば別条件です。",
    unknownNote: versions.some((v) => v.promptVersion === null) ? UNKNOWN_VERSION_NOTE : null,
    empty: versions.length === 0 ? "集計対象がありません。" : null,
    cards: versions.map((v) => versionCard(v, expandedKeys)),
  };
}

function directionSection(report: VerifyReportView): StatSection {
  return {
    heading: "補正方向×結果",
    description: "AI が確率を上げた馬・下げた馬・据え置いた馬が、実際に複勝圏に来たか。",
    rows: report.trend.directionGroups.map((g) => ({
      label: directionLabel(g.direction),
      bar: null,
      cells: [
        { name: "件数", value: `${g.count}件` },
        { name: "実複勝率", value: formatRate(g.actualPlaceRate) },
        { name: "平均補正幅", value: formatAdjustment(g.averageAdjustment) },
      ],
    })),
  };
}

function calibrationSection(report: VerifyReportView): CalibrationSection {
  return {
    heading: "キャリブレーション(推定確率帯ごとの実複勝率・過信バイアス)",
    description: "予測−実績が正なら過信、負なら過小評価。",
    empty: report.calibration.length === 0 ? "データがありません。" : null,
    rows: calibrationRows(report.calibration, report.trend.calibrationBias.map((b) => b.overconfidenceGap)),
  };
}

function marksSection(report: VerifyReportView): StatSection {
  return {
    heading: "印別的中率",
    description: "印付けが機能しているか(複勝率は 3 着以内、勝率は 1 着)。",
    rows: report.trend.markStats.map((m) => ({
      label: markLabel(m.mark),
      bar: null,
      cells: [
        { name: "件数", value: `${m.count}件` },
        { name: "複勝率", value: formatRate(m.placeRate) },
        { name: "勝率", value: formatRate(m.winRate) },
      ],
    })),
  };
}

function jst(iso: string): string {
  return `${formatJstDateTime(iso)}(JST)`;
}

function staleNotice(outcome: Extract<VerifyOutcome, { kind: "ready" }>): VerifyNotice | null {
  const at = jst(outcome.computedAt);
  switch (outcome.staleReason) {
    case null:
      return null;
    case "backfilling":
      return { tone: "wait", text: `古い分析の発走時刻を確認しています。終わると、最新の集計に自動で更新されます(いま表示しているのは ${at} 時点の集計です)。` };
    case "min-interval":
      return { tone: "wait", text: `データが更新されていますが、集計は 5 分に 1 回までです。いま表示しているのは ${at} 時点の集計で、${outcome.nextRecomputeAt === null ? "しばらくあと" : jst(outcome.nextRecomputeAt)}以降の「更新」で反映されます。` };
    case "daily-limit":
      return { tone: "wait", text: `1 日の集計の上限に達しているため、いま表示しているのは ${at} 時点の集計です。${outcome.nextRecomputeAt === null ? "翌日" : jst(outcome.nextRecomputeAt)}以降に更新できます。` };
  }
}

function gapNotice(gaps: { readonly lost: number; readonly affecting: number }): VerifyNotice | null {
  if (gaps.affecting > 0) {
    return {
      tone: "wait",
      text: `発走時刻を確認できなかった旧い分析が ${gaps.lost}件あります(分析の詳細を読めませんでした。詳細が無い・壊れている・まだ書き込み中などの理由があります)。うち ${gaps.affecting}件は、先読みの判定が発走時刻に依るため、exe とは判定が違う可能性があります。`,
    };
  }
  if (gaps.lost > 0) {
    return { tone: "info", text: `発走時刻を確認できなかった分析が ${gaps.lost}件ありますが、先読みの判定には影響しません。` };
  }
  return null;
}

function unavailableNotice(outcome: Exclude<VerifyOutcome, { kind: "ready" }>): VerifyNotice {
  if (outcome.kind === "throttled") {
    return { tone: "wait", text: `1 日の集計の上限に達していて、表示できる集計がありません。${jst(outcome.nextAt)}以降にもう一度開いてください。` };
  }
  if (outcome.blocked === "r2-fence") {
    return { tone: "wait", text: `保存先(R2)の読み出し回数の上限に達したため、発走時刻の確認を止めています。${outcome.resumeAt === null ? "翌月" : jst(outcome.resumeAt)}ごろに自動で再開します(残り ${outcome.remaining}件)。` };
  }
  if (outcome.blocked === "error") {
    return { tone: "error", text: `発走時刻の確認でエラーが続き、止まっています(残り ${outcome.remaining}件)。少し待ってから「更新」を押してください。` };
  }
  return { tone: "info", text: `古い分析の発走時刻を確認しています(残り ${outcome.remaining}件)。終わるまで数分かかることがあります。この画面は自動で更新されます。` };
}

export function buildVerifyModel(input: VerifyModelInput): VerifyModel {
  const { load } = input;
  const outcome = load.kind === "ready" ? load.outcome : null;
  const ready = outcome !== null && outcome.kind === "ready" ? outcome : null;
  const notices: VerifyNotice[] = [];
  if (ready !== null) {
    const stale = staleNotice(ready);
    if (stale !== null) notices.push(stale);
    const gap = gapNotice(ready.startTimeGaps);
    if (gap !== null) notices.push(gap);
  }
  return {
    kind: "verify",
    backHref: "#",
    venueTabs: (["all", "central", "nar"] as const).map((venue) => ({ venue, label: venueLabel(venue), current: venue === input.venue })),
    loading: load.kind === "loading" || input.busy,
    refreshDisabled: load.kind === "loading" || input.busy,
    error: load.kind === "error" ? load.message : null,
    pollNotice: input.pollStopped ? POLL_STOPPED_NOTICE : null,
    unavailable: outcome !== null && outcome.kind !== "ready" ? unavailableNotice(outcome) : null,
    computedAt: ready === null ? null : jst(ready.computedAt),
    notices,
    bet: ready === null ? null : betSection(ready.report),
    proposed: ready === null ? null : proposedSection(ready.report),
    versions: ready === null ? null : versionsSection(ready.promptVersions, input.expandedVersions),
    direction: ready === null ? null : directionSection(ready.report),
    calibration: ready === null ? null : calibrationSection(ready.report),
    marks: ready === null ? null : marksSection(ready.report),
  };
}
