/**
 * Discord の通知の embed を組み立てる(Issue #205〈#166-D〉)。**純関数**: DO・SQL・時計・送信を持たない。
 *
 *  - 分析の完了: core の `buildAnalysisEmbed` を流用する({@link buildAnalysisNotificationEmbed})。材料は、計算ステップの保存と同じ同期区間で、保存する `AnalysisRecord` から作る
 *    (馬名・コース・距離は `record.raceSnapshot` にある。D1 の要約には馬名もコースも無い。R2 に頼ると、R2 が使えないときに通知が劣化する)。LLM が効かなかったときは、固定の理由文を末尾に足す。
 *  - 失敗(赤)・手動スキップ(灰色): 理由ごとの**固定文だけ**を載せる(タスクのエラー文の生の値は載せない)。
 *  - 朝のまとめ: 中央は場ごとの field、地方は「地方 交流重賞」の field。**上限(AC-D4)は {@link fitEmbed} が最後に保証する**。
 *
 * `fields` は core の `DiscordEmbed` に無い(title・description・color だけ)ので、ここで {@link CloudEmbed} として拡張する(core には触らない)。
 * `sendDiscordNotification` は `JSON.stringify` するだけなので、そのまま通る。
 */
import { buildAnalysisEmbed, truncate, type DiscordEmbed, type EmbedHorse, type EmbedRaceInfo } from "../../packages/core/src/notify/discord";
import type { AnalysisAllocationMetaRecord, AnalysisAllocationRecord, AnalysisBetRecord, AnalysisRecord } from "../../packages/core/src/ev/analysis-store-types";
import type { SkipReasonCode } from "../../packages/core/src/ev/combo-bet-allocation";
import { parseComboOddsKey } from "../../packages/core/src/scraper/combo-odds-key";
import { venueNameFromRaceId } from "../../packages/app/src/main/venue-codes";
import { DISCORD_COLORS } from "./palette";
import type { AutoFailReason, AutoRunOutcome } from "./auto-run-result";
import type { PlanProgress } from "./race-day-core";

export interface EmbedField {
  readonly name: string;
  readonly value: string;
  readonly inline?: boolean;
}

/** core の `DiscordEmbed` に `fields` を足したもの。 */
export interface CloudEmbed extends DiscordEmbed {
  readonly fields?: readonly EmbedField[];
  /**
   * タイトルのリンク先(Issue #230。分析画面)。**文字数の上限の対象外**で、{@link fitEmbed} の切り詰めでも落ちない(description の末尾に書くと、収まらないときに失われる)。
   * 材料(`payload_json`)には入れず、**送信の直前に**足す(サイトの URL を DO の状態に残さない・secret を後から登録しても未送信分に反映される)。
   */
  readonly url?: string;
}

/** Discord の embed の上限(文字数。UTF-16 の `.length` で数える。コードポイントより保守側)。 */
export const EMBED_LIMITS = { title: 256, description: 4096, fieldName: 256, fieldValue: 1024, fields: 25, total: 6000 } as const;

// 帯の色は palette.ts(Issue #239。カラーユニバーサルデザイン)。
const COLOR_GREEN = DISCORD_COLORS.ok;
const COLOR_GRAY = DISCORD_COLORS.none;
const COLOR_RED = DISCORD_COLORS.fail;
const COLOR_ORANGE = DISCORD_COLORS.warn;

// ---- 上限を守る ----

/** UTF-16 の長さが max 以内になるように切る。切ったら末尾を「…」にする。サロゲートペアを割らない。 */
function cut(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  if (max <= 0) {
    return "";
  }
  let head = text.slice(0, max - 1);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    head = head.slice(0, -1); // 前半だけのサロゲートを残さない
  }
  return `${head}…`;
}

/** 行の並びを maxLen 以内の value にする。収まらなければ、末尾の行から落として最後に「…ほか N 件」を付ける(N = 落とした行の数)。 */
function fitLines(lines: readonly string[], maxLen: number): string {
  const full = lines.join("\n");
  if (full.length <= maxLen) {
    return full;
  }
  const n = lines.length;
  if (n <= 1) {
    return cut(full, maxLen); // 1 行しかないものは、行を落とせない(中身を切る)
  }
  for (let kept = n - 1; kept >= 0; kept -= 1) {
    const marker = `…ほか ${n - kept} 件`;
    const value = kept === 0 ? marker : `${lines.slice(0, kept).join("\n")}\n${marker}`;
    if (value.length <= maxLen) {
      return value;
    }
  }
  return cut(`…ほか ${n} 件`, maxLen);
}

/** embed の長さ(Discord が全体の上限に数える部分: title・description・field の name と value)。 */
export function embedLength(embed: CloudEmbed): number {
  return (
    (embed.title?.length ?? 0) +
    (embed.description?.length ?? 0) +
    (embed.fields ?? []).reduce((sum, f) => sum + f.name.length + f.value.length, 0)
  );
}

/**
 * embed を Discord の上限に収める(AC-D4)。収まる入力は変えない。
 *  1. title 256・description 4096・field 25 個・field の name 256・value 1024 に収める(value は行単位で落として「…ほか N 件」)。
 *  2. embed 全体が 6000 を超えるときは、**末尾の field から**縮める(各 field は「…ほか N 件」だけまで縮められる)。
 *  3. それでも超えるなら description を切り、最後は末尾の field を落とす。
 */
export function fitEmbed(embed: CloudEmbed): CloudEmbed {
  const title = embed.title === undefined ? undefined : cut(embed.title, EMBED_LIMITS.title);
  let description = embed.description === undefined ? undefined : cut(embed.description, EMBED_LIMITS.description);
  const fields = (embed.fields ?? []).slice(0, EMBED_LIMITS.fields).map((f) => {
    const lines = f.value.split("\n");
    return { name: cut(f.name, EMBED_LIMITS.fieldName), inline: f.inline, lines, value: fitLines(lines, EMBED_LIMITS.fieldValue) };
  });
  const total = (): number =>
    (title?.length ?? 0) + (description?.length ?? 0) + fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0);
  // 2. 末尾の field から縮める。
  for (let i = fields.length - 1; i >= 0 && total() > EMBED_LIMITS.total; i -= 1) {
    const f = fields[i]!;
    const excess = total() - EMBED_LIMITS.total;
    const minimal = `…ほか ${f.lines.length} 件`.length;
    f.value = fitLines(f.lines, Math.max(minimal, f.value.length - excess));
  }
  // 3. description を切る → 末尾の field を落とす。
  if (total() > EMBED_LIMITS.total && description !== undefined) {
    const excess = total() - EMBED_LIMITS.total;
    description = cut(description, Math.max(0, description.length - excess));
    if (description === "") {
      description = undefined;
    }
  }
  while (total() > EMBED_LIMITS.total && fields.length > 0) {
    fields.pop();
  }
  const out: { title?: string; url?: string; description?: string; color?: number; fields?: EmbedField[] } = {};
  if (title !== undefined) out.title = title;
  if (embed.url !== undefined) out.url = embed.url;
  if (description !== undefined) out.description = description;
  if (embed.color !== undefined) out.color = embed.color;
  if (embed.fields !== undefined) {
    out.fields = fields.map((f) => (f.inline === undefined ? { name: f.name, value: f.value } : { name: f.name, value: f.value, inline: f.inline }));
  }
  return out;
}

// ---- レースの見出し ----

/** 通知の見出しに使うレースの情報(計画の行から)。 */
export interface RaceLabel {
  readonly raceId: string;
  readonly venueName: string | null;
  readonly raceNumber: number | null;
  readonly raceName: string | null;
  readonly startTime: string | null;
}

function venueOf(label: Pick<RaceLabel, "raceId" | "venueName">): string {
  return label.venueName ?? venueNameFromRaceId(label.raceId);
}

/** 「会場 NR レース名」(無い部分は省く)。 */
export function raceTitle(label: RaceLabel): string {
  const parts = [venueOf(label)];
  if (label.raceNumber !== null) parts.push(`${label.raceNumber}R`);
  if (label.raceName !== null && label.raceName !== "") parts.push(label.raceName);
  return cut(parts.join(" "), EMBED_LIMITS.title);
}

// ---- 失敗・手動スキップ ----

const FAILURE_TEXTS: Readonly<Record<AutoFailReason | "unknown", string>> = {
  started: "発走済みのため、自動の分析を実行できませんでした",
  blocked: "netkeiba への取得が制限されている(ブレーカーが開いている)ため、自動の分析を実行できませんでした",
  "fetch-exhausted": "データの取得に繰り返し失敗したため、自動の分析を実行できませんでした",
  "compute-exhausted": "分析の計算・保存に繰り返し失敗したため、自動の分析を実行できませんでした",
  unknown: "原因を特定できない失敗のため、自動の分析を実行できませんでした",
};

/** 失敗の理由ごとの固定文(タスクのエラー文の生の値は載せない)。 */
export function failureText(reason: AutoFailReason | "unknown"): string {
  return FAILURE_TEXTS[reason];
}

/** 上限(1日のタスク数)で自動の分析を行わなかったときの固定文。 */
export const CAP_TEXT = "1日に受け付けられるレース数の上限に達したため、自動の分析を行いませんでした";
/** 発走時刻が分からないレースの固定文。 */
export const NO_START_TIME_TEXT = "発走時刻が分からないため、自動の分析を行いませんでした";
/** 手動の分析があるときの固定文(灰色の通知)。 */
export const MANUAL_SKIP_TEXT = "手動の分析があるため、自動の分析は行いませんでした";

/**
 * 赤い通知の本文(固定文)を、結果から決める。failed は理由ごと、昇格の時点のスキップは理由ごと(started・cap・no-start-time)。それ以外(通知しない結果)は「原因を特定できない」の固定文。
 * タスクのエラー文の生の値(`message`)は使わない。
 */
export function notificationText(outcome: AutoRunOutcome): string {
  if (outcome.kind === "failed") {
    return failureText(outcome.reason);
  }
  if (outcome.kind === "skipped") {
    if (outcome.reason === "started") return failureText("started");
    if (outcome.reason === "cap") return CAP_TEXT;
    if (outcome.reason === "no-start-time") return NO_START_TIME_TEXT;
  }
  return failureText("unknown");
}

function startLine(label: RaceLabel): string[] {
  return label.startTime === null ? [] : [`発走 ${label.startTime}`, ""];
}

/** 失敗の通知(赤)。 */
export function buildFailureEmbed(label: RaceLabel, text: string): CloudEmbed {
  return fitEmbed({ title: raceTitle(label), description: [...startLine(label), text].join("\n"), color: COLOR_RED });
}

/** 手動の分析があるため自動の分析を行わなかった通知(灰色)。 */
export function buildManualSkipEmbed(label: RaceLabel): CloudEmbed {
  return fitEmbed({ title: raceTitle(label), description: [...startLine(label), MANUAL_SKIP_TEXT].join("\n"), color: COLOR_GRAY });
}

/** 分析の embed の材料を組み立てられなかったときの代わり(分析は保存されている。画面で確認してもらう)。 */
export function buildMinimalAnalysisEmbed(label: RaceLabel): CloudEmbed {
  return fitEmbed({
    title: raceTitle(label),
    description: [...startLine(label), "分析が完了しました。詳細は画面で確認してください。", "(通知の詳細を組み立てられませんでした)"].join("\n"),
    color: COLOR_GRAY,
  });
}

// ---- 印の付いた馬・買い目の field(Issue #230)----

/**
 * 印の並び順。**正は core の `PREDICTION_MARKS`**(◎〇▲△☆注。「〇」は U+3007)。web の画面(`cloud/client/result.ts` の `KNOWN_MARK_ORDER`)と同じ順で、
 * `test/notify-embeds.test.ts` が値を固定する(core の parse-response をここに引き込まない)。
 */
export const MARK_ORDER: readonly string[] = ["◎", "〇", "▲", "△", "☆", "注"];

/** 馬名の上限(core の embed の馬の行と同じ 32 コードポイント)。 */
const MARK_NAME_MAX = 32;

const NO_MARKS_TEXT = "印の付いた馬はありません";

const markRank = (mark: string): number => {
  const i = MARK_ORDER.indexOf(mark);
  return i === -1 ? MARK_ORDER.length : i;
};

/** 印の付いた馬の field。印の順 → 馬番の昇順(web の結果画面の一覧と同じ)。印の無い馬(null・空白だけ)は載せない。 */
function buildMarksField(record: AnalysisRecord, names: ReadonlyMap<number, string | null>): EmbedField {
  const marked = record.horses
    .flatMap((h) => (h.mark === null || h.mark.trim() === "" ? [] : [{ umaban: h.umaban, mark: h.mark as string }]))
    .sort((a, b) => markRank(a.mark) - markRank(b.mark) || a.umaban - b.umaban);
  if (marked.length === 0) {
    return { name: "印", value: NO_MARKS_TEXT };
  }
  const lines = marked.map((h) => {
    const name = names.get(h.umaban);
    return name === null || name === undefined || name === "" ? `${h.mark} ${h.umaban}番` : `${h.mark} ${h.umaban}番 ${truncate(name, MARK_NAME_MAX)}`;
  });
  return { name: "印", value: lines.join("\n") };
}

/** 配分の状態(exe の `buildAllocationProposalView` の `kind` と同じ分類。パリティは `test/notify-allocation-parity.test.ts`)。 */
export type AllocationKind = "no-record" | "unset" | "yoso" | "unavailable" | "invalid" | "skip" | "allocated" | "indeterminate";

export function allocationKindOf(allocation: AnalysisAllocationRecord | undefined): AllocationKind {
  if (allocation === undefined) return "no-record";
  switch (allocation.meta.route) {
    case "unset":
      return "unset";
    case "yoso":
      return "yoso";
    case "unavailable":
      return "unavailable";
    case "invalid":
      return "invalid";
    case "place-only":
    case "mixed":
      if (allocation.meta.skipReasonCode !== null) return "skip";
      return allocation.bets.length === 0 ? "indeterminate" : "allocated";
    default:
      return "indeterminate";
  }
}

/** 未設定(unset)の内訳。exe の注記の選び方(`unsetNotices`)と同じ: 総資金・上限が 0 以下か。 */
export function unsetKindOf(meta: Pick<AnalysisAllocationMetaRecord, "bankroll" | "perRaceCap">): "both" | "bankroll" | "cap" | "indeterminate" {
  const bankrollUnset = meta.bankroll <= 0;
  const capUnset = meta.perRaceCap <= 0;
  return bankrollUnset && capUnset ? "both" : bankrollUnset ? "bankroll" : capUnset ? "cap" : "indeterminate";
}

const UNSET_TEXTS = {
  both: "総資金と1レースの上限が未設定のため、配分の提案は出ていません",
  bankroll: "総資金が未設定のため、配分の提案は出ていません",
  cap: "1レースの上限が未設定のため、配分の提案は出ていません",
  indeterminate: "配分の提案は出ていません(未設定の状態を判定できません)",
} as const;

/** 見送りの理由(core の `SkipReasonCode` の 6 分類。`Record` なので、分類が増えると型検査が落ちる)。文は core の見送りの文言の短縮。 */
const SKIP_REASON_TEXTS: Readonly<Record<SkipReasonCode, string>> = {
  "bankroll-unset": "総資金が未設定です",
  "cap-unset": "1レースの上限が未設定です",
  "cap-too-small": "1レースの上限が最小賭け金単位を下回ります",
  "kelly-zero": "ケリー係数が0です",
  "no-candidates": "EVプラスの買い目がありません",
  "no-edge": "妙味が小さく、賭ける価値のある配分が見つかりませんでした",
};

function skipText(code: string | null): string {
  const reason = code === null ? undefined : (SKIP_REASON_TEXTS as Readonly<Record<string, string | undefined>>)[code];
  return reason === undefined ? "見送り(買い目はありません)" : `見送り(${reason})`;
}

/** 券種のラベル(exe の `betTypeLabel` と同じ。8 券種。未知はそのまま)。 */
const BET_TYPE_LABELS: Readonly<Record<string, string>> = {
  place: "複勝",
  win: "単勝",
  wide: "ワイド",
  quinella: "馬連",
  bracketQuinella: "枠連",
  exacta: "馬単",
  trio: "三連複",
  trifecta: "三連単",
};

/** 券種の表示順(同額のときの並び。exe の `BET_TYPE_ORDER` と同じ。未知は末尾)。 */
const BET_TYPE_ORDER: Readonly<Record<string, number>> = { place: 0, win: 1, wide: 2, quinella: 3, bracketQuinella: 4, exacta: 5, trio: 6, trifecta: 7 };

/** 組合せの表記(exe の `comboLabelOf`・`formatComboBetLabel` と同じ)。読めない comboKey はそのまま。 */
function comboLabelOf(comboKey: string, betType: string): string {
  const numbers = parseComboOddsKey(comboKey);
  if (numbers === null) return comboKey;
  if (betType === "exacta" || betType === "trifecta") return numbers.join("→");
  if (betType === "bracketQuinella") return `枠${numbers.join("-")}`;
  return numbers.length === 1 ? `${numbers[0]}番` : numbers.join("-");
}

export interface AllocationBetRow {
  readonly betTypeLabel: string;
  readonly comboLabel: string;
  readonly stake: number;
  /** 「1,000円」(exe の `formatYen` と同じ)。 */
  readonly stakeText: string;
}

/** 買い目の行。**金額の大きい順**(同額は券種の表示順 → comboKey の昇順)。web の画面は券種順だが、Discord は収まらないときに末尾から落とすので、大きい金額を先に出す。 */
export function allocationBetRows(bets: readonly AnalysisBetRecord[]): AllocationBetRow[] {
  const rank = (betType: string): number => BET_TYPE_ORDER[betType] ?? 99;
  return [...bets]
    .sort((a, b) => b.stake - a.stake || rank(a.betType) - rank(b.betType) || (a.betType < b.betType ? -1 : a.betType > b.betType ? 1 : 0) || (a.comboKey < b.comboKey ? -1 : a.comboKey > b.comboKey ? 1 : 0))
    .map((b) => ({ betTypeLabel: BET_TYPE_LABELS[b.betType] ?? b.betType, comboLabel: comboLabelOf(b.comboKey, b.betType), stake: b.stake, stakeText: `${b.stake.toLocaleString("en-US")}円` }));
}

/** 買い目の field。配分があれば name に点数と合計(行が落ちても合計は欠けない)、無ければ状態ごとの固定文。 */
function buildAllocationField(allocation: AnalysisAllocationRecord | undefined): EmbedField {
  const kind = allocationKindOf(allocation);
  switch (kind) {
    case "allocated": {
      const rows = allocationBetRows(allocation!.bets);
      const total = rows.reduce((sum, r) => sum + r.stake, 0);
      return { name: `買い目(${rows.length}点・合計${total.toLocaleString("en-US")}円)`, value: rows.map((r) => `${r.betTypeLabel} ${r.comboLabel} ${r.stakeText}`).join("\n") };
    }
    case "unset":
      return { name: "買い目", value: UNSET_TEXTS[unsetKindOf(allocation!.meta)] };
    case "yoso":
      return { name: "買い目", value: "オッズが未発売のため、配分の提案は出ていません" };
    case "unavailable":
      return { name: "買い目", value: "複勝が配分の対象外のため、配分の提案は出ていません" };
    case "invalid":
      return { name: "買い目", value: "配分の計算でエラーが起きたため、配分の提案は出ていません" };
    case "skip":
      return { name: "買い目", value: skipText(allocation!.meta.skipReasonCode) };
    case "no-record":
      return { name: "買い目", value: "配分の記録がありません" };
    case "indeterminate":
      return { name: "買い目", value: "配分の状態を判定できません" };
  }
}

// ---- 分析の完了 ----

const ODDS_STATUSES: readonly string[] = ["result", "middle", "yoso"];

interface SnapshotView {
  readonly raceName: string | null;
  readonly courseType: string;
  readonly distance: number;
  readonly oddsStatus: EmbedRaceInfo["oddsStatus"];
  readonly names: ReadonlyMap<number, string | null>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `record.raceSnapshot`(型は unknown。`buildRaceSnapshot` の実物)から、embed に要る部分だけを読む。想定の形でなければ投げる(呼び出し側が最小の embed に代える)。 */
function readSnapshot(raw: unknown): SnapshotView {
  if (!isObject(raw) || !isObject(raw["race"]) || !Array.isArray(raw["horses"])) {
    throw new Error("レース情報のスナップショットが想定の形ではありません");
  }
  const race = raw["race"];
  const distance = race["distance"];
  const oddsStatus = race["oddsStatus"];
  if (typeof race["courseType"] !== "string" || typeof distance !== "number" || !Number.isFinite(distance) || typeof oddsStatus !== "string" || !ODDS_STATUSES.includes(oddsStatus)) {
    throw new Error("レース情報のスナップショットのコース・距離・オッズ状態が想定の形ではありません");
  }
  const names = new Map<number, string | null>();
  for (const horse of raw["horses"] as unknown[]) {
    if (isObject(horse) && typeof horse["umaban"] === "number") {
      names.set(horse["umaban"], typeof horse["name"] === "string" ? horse["name"] : null);
    }
  }
  return {
    raceName: typeof race["raceName"] === "string" ? race["raceName"] : null,
    courseType: race["courseType"],
    distance,
    oddsStatus: oddsStatus as EmbedRaceInfo["oddsStatus"],
    names,
  };
}

function slashDate(kaisaiDate: string | null | undefined): string {
  return typeof kaisaiDate === "string" && /^\d{8}$/.test(kaisaiDate) ? `${kaisaiDate.slice(0, 4)}/${kaisaiDate.slice(4, 6)}/${kaisaiDate.slice(6, 8)}` : "日付不明";
}

/**
 * 分析の完了の embed(AC-D1。狙い目あり=緑・なし=灰色)。core の `buildAnalysisEmbed` を流用し、LLM が効かなかった(または一部だけ)ときは、固定の理由文(`outcome.note`)を末尾に足す。
 * @throws `record.raceSnapshot` が想定の形でないとき(呼び出し側は {@link buildMinimalAnalysisEmbed} に代える。分析は止めない)
 */
export function buildAnalysisNotificationEmbed(record: AnalysisRecord, outcome: { readonly effective: boolean; readonly note: string | null }, label: RaceLabel): CloudEmbed {
  const snapshot = readSnapshot(record.raceSnapshot);
  const raceInfo: EmbedRaceInfo = {
    raceName: snapshot.raceName ?? label.raceName ?? "",
    date: slashDate(record.kaisaiDate),
    venueName: venueOf(label),
    courseType: snapshot.courseType,
    distance: snapshot.distance,
    llmUsed: outcome.effective,
    oddsStatus: snapshot.oddsStatus,
  };
  const horses: EmbedHorse[] = record.horses.map((h) => ({
    umaban: h.umaban,
    horseName: snapshot.names.get(h.umaban) ?? `${h.umaban}番`,
    adjustedProb: h.adjustedProb,
    placeOddsMin: h.placeOddsMin,
    ev: h.ev,
    isPositive: h.isPositive,
    mark: h.mark,
    evEstimated: record.evEstimated === true,
  }));
  const base = buildAnalysisEmbed(raceInfo, horses);
  const body = outcome.note === null ? base.description : `${base.description ?? ""}\nLLM補正の注記: ${outcome.note}`;
  // 発走時刻(Issue #236)は、失敗・手動スキップ・最小の通知と同じ書き方(`startLine`)で、description の先頭に置く(先頭なので、収まらないときの切り詰めで失われない)。時刻が無ければ何も足さない。
  const description = body === undefined ? undefined : [...startLine(label), body].join("\n");
  // 印の付いた馬 → 買い目の順(収まらないときは末尾の買い目から縮める)。EV プラスの馬の行(description)は core のまま残す。
  const fields: EmbedField[] = [buildMarksField(record, snapshot.names), buildAllocationField(record.allocation)];
  // タイトルは失敗・手動スキップ・最小の通知と同じ関数で作る(Issue #230。「会場 NR レース名」)。core のタイトルは番号を持たない(core は変えない)。
  // 番号は計画の行(`label.raceNumber`)から。無ければ番号なしの今の形(「会場 レース名」)になる。レース名は、スナップショットにあればそれを優先する(従来どおり)。
  const title = raceTitle({ ...label, raceName: snapshot.raceName ?? label.raceName });
  // 帯の色は cloud 側で決める(Issue #239。カラーユニバーサルデザイン)。core の `buildAnalysisEmbed` も色を返すが、その定数は exe の Discord と共有で変えられない(exe は対象外)。
  // 条件は core と同じ「EV プラスの馬がいるか」(`record.horses` を `EmbedHorse` に 1:1 で写しており、isPositive をそのまま渡している)。
  const color = record.horses.some((h) => h.isPositive) ? COLOR_GREEN : COLOR_GRAY;
  return fitEmbed({ ...base, title, color, ...(description === undefined ? {} : { description }), fields });
}

// ---- 朝のまとめ ----

type PlanRow = PlanProgress["rows"][number];
type PlanVenueState = PlanProgress["venues"][number];

const SKIP_LABELS = { "no-start-time": "時刻不明", started: "発走済み", "too-late": "間に合わない", cap: "上限超過", manual: "手動の分析あり" } as const;
/** description の「スキップ:」の内訳の並び(上限超過は失敗に数えるので、ここには入れない)。 */
const SKIP_BREAKDOWN_ORDER = ["started", "no-start-time", "too-late", "manual"] as const;
const LIST_FAILURE_LABELS: Readonly<Record<string, string>> = { blocked: "取得制限中", busy: "混雑", failed: "取得エラー" };
/** 行に出すレース名の上限(コードポイント)。 */
const RACE_NAME_MAX = 20;

function listFailureText(venue: PlanVenueState): string {
  return `一覧を取得できませんでした(${LIST_FAILURE_LABELS[venue.reason ?? ""] ?? "取得エラー"})`;
}

function rowStatus(row: PlanRow): "ok" | "failed" | "incomplete" | "skipped" {
  if (row.state === "skipped") {
    return "skipped";
  }
  return row.morning === "done" ? "ok" : row.morning === "failed" ? "failed" : "incomplete";
}

function rowTag(row: PlanRow): string {
  if (row.state === "skipped") {
    return `スキップ(${row.skipReason === null ? "理由不明" : SKIP_LABELS[row.skipReason]})`;
  }
  const status = rowStatus(row);
  return status === "ok" ? "準備OK" : status === "failed" ? "準備失敗" : "未完了";
}

function rowLine(row: PlanRow, withVenue: boolean): string {
  const venue = withVenue ? `${row.venueName ?? venueNameFromRaceId(row.raceId)} ` : "";
  const number = row.raceNumber === null ? "?" : String(row.raceNumber);
  return `${venue}${number}R ${truncate(row.raceName ?? "", RACE_NAME_MAX)} ${row.startTime ?? "--:--"} ${rowTag(row)}`;
}

const byRaceNumber = (a: PlanRow, b: PlanRow): number => (a.raceNumber ?? 99) - (b.raceNumber ?? 99) || a.raceId.localeCompare(b.raceId);

export interface SummaryInput {
  /** 開催日(YYYYMMDD)。 */
  readonly kaisaiDate: string;
  readonly progress: PlanProgress;
}

/**
 * 朝のまとめ(AC-D3・AC-D5)。中央は場ごとの field、地方は「地方 交流重賞」の field。一覧の取得に失敗した会場は、description と field に出す。
 * 準備の成否は morning タスクの状態(done=準備OK・failed=準備失敗・それ以外=未完了)。上限超過(cap)のスキップは失敗として数える。
 * 長さの保証は {@link fitEmbed}。
 */
export function buildSummaryEmbed(input: SummaryInput): CloudEmbed {
  const { progress } = input;
  const central = progress.rows.filter((r) => r.venue === "central");
  const narRows = progress.rows.filter((r) => r.venue === "nar");
  let ok = 0;
  let failed = 0;
  let incomplete = 0;
  let cap = 0;
  const skipCounts: Record<string, number> = {};
  for (const row of progress.rows) {
    const status = rowStatus(row);
    if (status === "ok") ok += 1;
    else if (status === "failed") failed += 1;
    else if (status === "incomplete") incomplete += 1;
    else if (row.skipReason === "cap") {
      failed += 1;
      cap += 1;
    } else {
      skipCounts[row.skipReason ?? "unknown"] = (skipCounts[row.skipReason ?? "unknown"] ?? 0) + 1;
    }
  }
  const failedVenues = progress.venues.filter((v) => v.state === "failed");
  const venueLabel = (v: PlanVenueState): string => (v.venue === "central" ? "中央" : "地方");

  const lines = [
    `対象 ${progress.rows.length} 件(中央 ${central.length}・地方 交流重賞 ${narRows.length})`,
    `準備OK ${ok} / 失敗 ${failed}${cap > 0 ? `(うち上限超過 ${cap})` : ""} / 未完了 ${incomplete}`,
  ];
  const skipParts = SKIP_BREAKDOWN_ORDER.filter((reason) => (skipCounts[reason] ?? 0) > 0).map((reason) => `${SKIP_LABELS[reason]} ${skipCounts[reason]}`);
  if (skipParts.length > 0) {
    lines.push(`スキップ: ${skipParts.join("・")}`);
  }
  if (incomplete > 0) {
    lines.push(`※ 未完了 ${incomplete} 件のまま送信しています`);
  }
  for (const v of failedVenues) {
    lines.push(`⚠ ${venueLabel(v)}の${listFailureText(v)}`);
  }
  if (progress.offsetMinutes !== null) {
    lines.push(`発走の ${progress.offsetMinutes} 分前に自動で分析します${progress.offsetSource === "default-fallback" ? "(設定を読めなかったため、既定値で計画しました)" : ""}`);
  }

  const fields: EmbedField[] = [];
  // 中央: 場ごと。
  const byVenue = new Map<string, PlanRow[]>();
  for (const row of central) {
    const name = row.venueName ?? venueNameFromRaceId(row.raceId);
    byVenue.set(name, [...(byVenue.get(name) ?? []), row]);
  }
  for (const [name, rows] of byVenue) {
    fields.push({ name, value: [...rows].sort(byRaceNumber).map((r) => rowLine(r, false)).join("\n") });
  }
  const centralVenue = progress.venues.find((v) => v.venue === "central");
  if (central.length === 0 && centralVenue !== undefined) {
    fields.push({ name: "中央", value: centralVenue.state === "failed" ? listFailureText(centralVenue) : "一覧が空でした(0件)" });
  }
  // 地方: 交流重賞。
  const narVenue = progress.venues.find((v) => v.venue === "nar");
  if (narVenue !== undefined || narRows.length > 0) {
    let value: string;
    if (narRows.length > 0) {
      value = [...narRows].sort(byRaceNumber).map((r) => rowLine(r, true)).join("\n");
    } else if (narVenue?.state === "failed") {
      value = listFailureText(narVenue);
    } else if (narVenue?.listed === 0) {
      value = "一覧が空でした(0件)";
    } else if (narVenue?.listed !== null && narVenue?.listed !== undefined) {
      value = `交流重賞はありません(一覧 ${narVenue.listed} 件)`;
    } else {
      value = "対象はありません";
    }
    fields.push({ name: "地方 交流重賞", value });
  }

  const color = failedVenues.length > 0 || (ok === 0 && failed > 0) ? COLOR_RED : failed > 0 || incomplete > 0 ? COLOR_ORANGE : COLOR_GREEN;
  return fitEmbed({ title: `朝の準備 ${slashDate(input.kaisaiDate)}`, description: lines.join("\n"), color, fields });
}
