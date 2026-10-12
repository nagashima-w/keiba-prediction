/**
 * 日報(Issue #235)のプロンプトの組み立てと、LLM の応答(JSON)の解釈。**純関数**。
 *
 * 方針:
 *  - 数字は決定的に計算済み(`daily-report-digest.ts`)。プロンプトには確定値として渡し、LLM には計算させない。
 *  - LLM が書くのは「総括・良かった点・改善点・レース別の一言」だけ。**プロンプトや重みを自動で変える入力にはしない**
 *    (日報は記録と振り返りの材料。`docs/prompt-improvement-plan.md`)。
 *  - 送信は既存の `MessageSender`(`AnthropicRequestParams`)で、system を別に持たない。規則・出力形式・事実を 1 通のユーザーメッセージにまとめる。
 *  - 応答は JSON。コードフェンス・前後の説明文があっても、最初の `{` から最後の `}` までを読む。読めなければ null(呼び出し側が生テキストを本文にする)。
 */
import { excludingTopRecoveryRate, type DayStats, type RaceDigest } from "./daily-report-digest";
import type { PeriodStats, RollingSummary } from "./period-stats";
import { formatRecoveryPercent } from "./recovery-format";
import { MARK_TEMPLATES, NEAR_MISS_LIMIT, type NearMissSummary, type WhatIfStats } from "./daily-report-whatif";
import { formatTemplateStat, templateLabel } from "./whatif-format";

/**
 * 日報のプロンプトの版(Issue #264)。日報の本文(`ReportBody.promptVersion`)に残し、どの文面が書いた日報かを後から区別する(日報の質の見直し〈`docs/prompt-improvement-plan.md`〉で、
 * 文面を変えた前後の日報を比べるため)。**プロンプトの文面〈規則・出力形式・成績の節の書き方〉を変えたら更新する**(分析のプロンプトの `PROMPT_VERSION` とは別)。
 * 本文に `promptVersion` が無い日報は、この版を持つ前〈2026-10-11 まで。「数十レースの 1 日分では偶然の影響が大きい」という規則だった版〉に作られたもの。
 * `report-2026-10-12.1`(Issue #272)で、印の定型の買い方(「もしも」)の節と規則の 1 文を足した。
 */
export const REPORT_PROMPT_VERSION = "report-2026-10-12.1";

/** 応答の最大トークン数(thinking を含む)。非ストリーミングの上限(21333)未満。日報の JSON は数千トークンの見込み。 */
export const REPORT_MAX_TOKENS = 12000;

/** 解釈した応答の長さの上限(UTF-16 の長さ)。 */
export const NARRATIVE_LIMITS = { summary: 400, items: 6, item: 200, races: 8, comment: 200 } as const;

export interface Narrative {
  /** 総括(Discord に載せる)。 */
  readonly summary: string;
  readonly good: readonly string[];
  readonly improve: readonly string[];
  /** レース別の一言(今日のレースの raceId のものだけ)。 */
  readonly races: readonly { readonly raceId: string; readonly comment: string }[];
}

const BET_TYPE_LABELS: Readonly<Record<string, string>> = {
  win: "単勝",
  place: "複勝",
  wide: "ワイド",
  trio: "3連複",
  quinella: "馬連",
  exacta: "馬単",
  trifecta: "三連単",
  bracketQuinella: "枠連",
};

export function betTypeLabel(betType: string): string {
  return BET_TYPE_LABELS[betType] ?? betType;
}

/** 組合せのキー(2 桁ゼロ埋めの連結)を読みやすくする。読めないキーは元の文字列のまま。 */
export function formatComboKey(betType: string, key: string): string {
  if (!/^(?:[0-9]{2})+$/.test(key) || !(betType in BET_TYPE_LABELS)) {
    return key;
  }
  const nums = (key.match(/[0-9]{2}/g) ?? []).map((s) => String(Number(s)));
  if (betType === "bracketQuinella") {
    return `${nums.join("-")}(枠)`;
  }
  const sep = betType === "exacta" || betType === "trifecta" ? "→" : "-";
  return `${nums.join(sep)}番`;
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

export function dateLabel(kaisaiDate: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(kaisaiDate);
  if (m === null) {
    return kaisaiDate;
  }
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const weekday = WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()]!;
  return `${y}年${mo}月${d}日(${weekday})`;
}

export const yen = (n: number): string => `${Math.round(n).toLocaleString("en-US")}円`;
export const percent = (n: number): string => `${(n * 100).toFixed(1)}%`;

export function raceTitle(d: RaceDigest): string {
  const place = d.venueName !== null && d.raceNumber !== null ? `${d.venueName}${d.raceNumber}R` : d.raceId;
  const course = [d.courseType, d.distance === null ? null : `${d.distance}m`, d.trackCondition].filter((s): s is string => s !== null && s !== "");
  const meta = [d.startTime, course.join("")].filter((s): s is string => s !== null && s !== "");
  return `${place}${d.raceName === null ? "" : ` ${d.raceName}`}${meta.length === 0 ? "" : `(${meta.join(" ")})`}`;
}

function horseLabel(umaban: number, name: string | null): string {
  return name === null ? `${umaban}番` : `${umaban}番 ${name}`;
}

function raceBlock(d: RaceDigest): string {
  const lines: string[] = [`### ${raceTitle(d)} raceId=${d.raceId} ${d.llmUsed ? "[LLM分析]" : "[統計のみ]"}`];
  lines.push(
    d.hasResult
      ? `結果: ${d.top3.length === 0 ? "着順の記録なし" : d.top3.map((t) => `${t.finishPosition}着 ${horseLabel(t.umaban, t.name)}`).join(" / ")}`
      : "結果: なし(未取得・中止などで取り込めていない。成否は判断しない)",
  );
  lines.push("予想:");
  for (const h of d.horses) {
    const parts = [
      `- ${h.mark ?? "印なし"} ${horseLabel(h.umaban, h.name)}`,
      `補正後の3着内率 ${percent(h.adjustedProb)}`,
      h.ev === null ? "EV なし" : `EV ${h.ev.toFixed(2)}`,
      h.finishPosition === null ? "着順 不明" : `${h.finishPosition}着`,
    ];
    if (h.reason !== null) parts.push(`根拠: ${h.reason}`);
    if (h.highlights.length > 0) parts.push(`強調: ${h.highlights.join("、")}`);
    if (h.concerns.length > 0) parts.push(`懸念: ${h.concerns.join("、")}`);
    lines.push(parts.join(" | "));
  }
  if (d.bets.length === 0) {
    lines.push(`買い目: ${d.allocationNote ?? "なし"}`);
  } else {
    const bets = d.bets.map((b) => {
      const head = `${betTypeLabel(b.betType)} ${formatComboKey(b.betType, b.comboKey)} ${yen(b.stake)}`;
      return b.status === "hit" ? `${head} → 的中 ${yen(b.payout)}` : b.status === "miss" ? `${head} → はずれ` : `${head} → 判定不能`;
    });
    lines.push(`買い目: ${bets.join(" / ")}`);
    if (d.judgedBetCount > 0) {
      lines.push(`このレース(判定できた買い目): 賭け金 ${yen(d.totalStake)}・払戻 ${yen(d.totalReturn)}`);
    }
  }
  return lines.join("\n");
}

const signed = (n: number): string => `${n >= 0 ? "+" : "-"}${Math.abs(n).toFixed(2)}`;

/** 「見込みの的中数」の行(+ 差・対象外の注記)。見込みと比べる実際の数は `expectedBaseHits`(確率を導けた買い目だけの的中)。差は確定値として渡す(LLM に引き算させない)。 */
function expectedLines(s: DayStats): string[] {
  if (s.expectedBetCount === 0) {
    return ["見込みの的中数: なし(分析時点の的中確率を導ける、判定済みの買い目が無い)"];
  }
  const lines = [
    `見込みの的中数: ${s.expectedHits.toFixed(2)} 点(分析時点の的中確率の合計。確率のある ${s.expectedBetCount} 点が対象)・実際の的中: ${s.expectedBaseHits} 点(同じ ${s.expectedBetCount} 点中)`,
    `差(実際 − 見込み): ${signed(s.expectedBaseHits - s.expectedHits)} 点`,
  ];
  if (s.expectedBetCount < s.judgedBetCount) {
    lines.push(`(判定できた ${s.judgedBetCount} 点のうち ${s.judgedBetCount - s.expectedBetCount} 点は確率が無く、見込みに含めない)`);
  }
  return lines;
}

function excludingTopLine(s: DayStats): string {
  const rate = excludingTopRecoveryRate(s);
  return rate === null
    ? "払戻が最大の 1 点を除いた回収率: なし(的中が無い、または除くと賭け金が残らない)"
    : `払戻が最大の 1 点を除いた回収率: ${formatRecoveryPercent(rate)}(その 1 点: 払戻 ${yen(s.maxPayout)}・賭け金 ${yen(s.maxPayoutStake)})`;
}

function typeText(t: DayStats["byBetType"][string]): string {
  const expected = t.expectedBetCount === 0 ? "" : `・見込み ${t.expectedHits.toFixed(2)} 点${t.expectedBetCount < t.betCount ? `(確率あり ${t.expectedBetCount} 点)` : ""}`;
  return `${t.betCount} 点中 ${t.hitCount} 点的中(賭け金 ${yen(t.stake)}・払戻 ${yen(t.payout)}${expected})`;
}

/** 買い目の成績の行(その日・期間で共通)。 */
function betResultLine(s: DayStats): string {
  return `買い目の成績(判定できたもの): 賭け金 ${yen(s.totalStake)}・払戻 ${yen(s.totalReturn)}・回収率 ${s.recoveryRate === null ? "なし(賭け金 0)" : formatRecoveryPercent(s.recoveryRate)}・${s.judgedBetCount} 点中 ${s.hitBetCount} 点的中`;
}

function tailLines(s: DayStats): string[] {
  const lines: string[] = [...expectedLines(s), excludingTopLine(s)];
  if (s.unjudgedBetCount > 0) {
    lines.push(`判定不能の買い目: ${s.unjudgedBetCount} 点(賭け金 ${yen(s.unjudgedStake)}。結果が無い・払戻が未取得のため成績に含めない)`);
  }
  const types = Object.entries(s.byBetType);
  if (types.length > 0) {
    lines.push(`券種別: ${types.map(([t, v]) => `${betTypeLabel(t)} ${typeText(v)}`).join(" / ")}`);
  }
  if (s.byMark.length > 0) {
    lines.push(`印別(結果のあるレース。頭数 / 1着 / 3着内): ${s.byMark.map((m) => `${m.mark} ${m.count} / ${m.win} / ${m.top3}`).join("、")}`);
  }
  return lines;
}

function statsBlock(s: DayStats): string {
  return [
    `分析したレース: ${s.raceCount} 件(結果あり ${s.resultRaceCount} 件・結果なし ${s.noResultRaceCount} 件・買い目のあるレース ${s.betRaceCount} 件)`,
    betResultLine(s),
    ...tailLines(s),
  ].join("\n");
}

const ymdLabel = (kaisaiDate: string): string => {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(kaisaiDate);
  return m === null ? kaisaiDate : `${Number(m[1])}年${Number(m[2])}月${Number(m[3])}日`;
};

/** 期間の成績の節(直前 27 日・28 日累計)。`full` なら券種別・印別も出す(累計)。分析したレースが無い期間は、その旨だけ。 */
function periodBlock(p: PeriodStats, full: boolean): string {
  const lines = [
    `期間: ${ymdLabel(p.fromDate)}〜${ymdLabel(p.toDate)}。分析のあった開催日 ${p.dayCount} 日・分析したレース ${p.raceCount} 件(結果あり ${p.resultRaceCount} 件・結果なし ${p.noResultRaceCount} 件)`,
    betResultLine(p),
  ];
  const tail = tailLines(p);
  // 直前 27 日は見出しの数字だけ(見込み・最大払戻の 1 点を除いた回収率・判定不能)。券種別・印別は累計に出す。
  return [...lines, ...(full ? tail : tail.filter((l) => !l.startsWith("券種別:") && !l.startsWith("印別")))].join("\n");
}

const NO_PRIOR_BLOCK = "(この期間に分析したレースはありません。直前 27 日と比較できません)";

/** 実際の買い目の概要(惜しかったレースの行に添える)。買い目が無ければ見送りの理由か「買い目なし」。 */
function actualBetsText(d: RaceDigest): string {
  if (d.bets.length === 0) {
    return d.allocationNote ?? "買い目なし";
  }
  const parts: string[] = [];
  if (d.judgedBetCount > 0) parts.push(`賭け金 ${yen(d.totalStake)}・払戻 ${yen(d.totalReturn)}`);
  if (d.unjudgedBetCount > 0) parts.push(`判定不能 ${d.unjudgedBetCount} 点`);
  return parts.join("・");
}

const WHATIF_HEADING = "印の定型の買い方(「もしも」。確定値。各 100 円)";

function whatIfRows(w: WhatIfStats): string[] {
  return MARK_TEMPLATES.flatMap((t) => (w[t.id] === undefined ? [] : [`- ${templateLabel(t.id)}: ${formatTemplateStat(w[t.id]!, yen)}`]));
}

/** 「もしも」の節(Issue #272)。その日と累計のどちらかの成績が無い(旧形のジョブ)ときは出さない(null)。 */
function whatIfSection(input: ReportPromptInput): string[] | null {
  const day = input.stats.whatIf;
  const total = input.rolling.total.whatIf;
  if (day === null || total === null) {
    return null;
  }
  const lines = [
    `## ${WHATIF_HEADING}`,
    "印の定型の買い方(下の 5 つの型)を、毎レース各 100 円で買っていたときの成績です。対象は印の付いたレース全部で、実際の配分(買い目のあるレースだけ)とは点数も賭け金も揃っていません。判定不能は結果・払戻が未取得のレース、対象外は必要な印が付いていないレースで、どちらも成績に含めません。",
    "### その日",
    ...whatIfRows(day),
    "### 直近 28 日の累計(その日を含む)",
    ...whatIfRows(total),
  ];
  const near = input.nearMisses;
  if (near !== undefined && near !== null) {
    lines.push(`### 惜しかったレース(その日。組合せ券種の型が的中したのに、同じ組合せを買っていなかったレース。払戻の多い順に最大 ${NEAR_MISS_LIMIT} 件。全 ${near.total} 件)`);
    if (near.shown.length === 0) {
      lines.push("- 該当なし");
    }
    for (const n of near.shown) {
      const d = input.digests.find((x) => x.raceId === n.raceId);
      lines.push(`- ${d === undefined ? n.raceId : `${raceTitle(d)} raceId=${d.raceId}`}: ${templateLabel(n.templateId)}が的中していた(定型の払戻 ${yen(n.payout)})・実際の買い目: ${d === undefined ? "不明" : actualBetsText(d)}`);
    }
  }
  return lines;
}

export interface ReportPromptInput {
  readonly kaisaiDate: string;
  readonly digests: readonly RaceDigest[];
  readonly stats: DayStats;
  /** 直前 27 日と直近 28 日の累計(Issue #264)。 */
  readonly rolling: RollingSummary;
  /** 惜しかったレース(Issue #272)。省略・null は未計算(旧形のジョブ)で、その小節を出さない。 */
  readonly nearMisses?: NearMissSummary | null;
}

export function buildReportPrompt(input: ReportPromptInput): string {
  const whatIf = whatIfSection(input);
  const sections: string[] = [
    `あなたは競馬の期待値分析ツールの「日報」を書く振り返り担当です。以下は ${dateLabel(input.kaisaiDate)} に、このツールが発走前に分析した全レースの「予想」と「結果」です。`,
    "利用者は、この日報を読んで、ツールの予想がその日どうだったかを振り返ります。",
    "",
    "## 規則",
    "- 買い目の成績の数字(賭け金・払戻・回収率・的中数)はツールが計算した確定値です。計算し直さず、そのまま引用してください。",
    "- 書いてよいのは、下に書かれた事実から言えることだけです。馬の過去成績・騎手・展開・馬場の傾向など、書かれていないことを推測で補わないでください。",
    "- 「結果: なし」のレースは、予想の成否を判断しないでください(中止や取り込めていないだけの可能性があります)。",
    "- このツールは穴馬の高配当を狙います。的中の頻度は低く、1 点の的中で回収率が大きく動くのは想定どおりです。回収率が 1 点の的中で動いたこと自体を、問題としても手柄としても書かないでください。",
    "- 予想の評価は「見込みの的中数」との比較で書いてください。見込みの的中数は、判定できた買い目それぞれの分析時点の的中確率の合計です(確定値)。実際の的中数が見込みを上回ったか、下回ったか、同程度かを、数字を挙げて述べてください。「その日」と「直近 28 日の累計」の両方で同じ比較をし、その日が 4 週の水準と比べてどうだったか(回収率・的中・印別)も書いてください。",
    "- 「偶然」と書いてよいのは、その根拠を下の確定値の数字で示せるときだけです(例: 払戻が最大の 1 点を除いた回収率、点数の少なさ)。見込みの的中数との比較で説明できることは、「偶然」ではなく見込みとの比較で書いてください。「偶然の影響が強い 1 日です」のように数字を伴わない定型の断りは書かないでください。「偶然」という断りは、総括で多くとも 1 回にして、良かった点・改善点では繰り返さないでください。",
    ...(whatIf === null
      ? []
      : ["- 「もしも」(印の定型の買い方)の成績は、後から買い方を選び直したときの参考値です。1 日分は点数が少なく、その日に当たった型を追いかける材料にしないでください。続けてよい型かどうかは、直近 28 日の累計の点数と回収率で述べてください(累計でも点数の少ない型は断定しない)。"]),
    "- 直前 27 日の開催日数や点数が少ないときは、その少なさを一度だけ述べ、4 週の傾向を断定しないでください。",
    "- 1〜2 レースだけで起きた個別の出来事は、レース別の一言に回し、「良かった点」「改善点」には繰り返し見える傾向を優先してください。",
    "- 改善点は、気づきとして書いてください(プロンプトや重みを変えるよう命令する書き方はしない)。",
    "- 印の意味: ◎本命 / 〇対抗 / ▲単穴 / △連下 / ☆穴(勝ち目)/ 注 穴(3着)。補正後の3着内率は複勝圏(3着以内)に入る確率の予想です。",
    "",
    "## 出力形式",
    "次の JSON オブジェクト 1 つだけを出力してください(前後に説明文・コードフェンスを付けない)。",
    "{",
    `  "summary": "その日の総括。${NARRATIVE_LIMITS.summary} 字以内。結果のあるレース数・見込みの的中数と実際の的中数の比較・回収率など、主な数字を含める",`,
    `  "good": ["良かった点。最大 ${NARRATIVE_LIMITS.items} 件、各 ${NARRATIVE_LIMITS.item} 字以内"],`,
    `  "improve": ["改善点。最大 ${NARRATIVE_LIMITS.items} 件、各 ${NARRATIVE_LIMITS.item} 字以内"],`,
    `  "races": [{"raceId": "下のレースの raceId", "comment": "そのレースの一言。${NARRATIVE_LIMITS.comment} 字以内"}]`,
    "}",
    `"races" は、特に振り返る価値のあるレース(最大 ${NARRATIVE_LIMITS.races} 件。無ければ空の配列)だけにしてください。`,
    "",
    `## ${dateLabel(input.kaisaiDate)} の成績(確定値)`,
    statsBlock(input.stats),
    "",
    "## 直前 27 日(その日を除く)の成績(確定値)",
    input.rolling.prior.raceCount === 0 ? NO_PRIOR_BLOCK : periodBlock(input.rolling.prior, false),
    "",
    "## 直近 28 日の累計(その日を含む)の成績(確定値)",
    input.rolling.prior.raceCount === 0 ? "(直前 27 日に分析したレースが無いため、累計はその日の成績と同じです)" : periodBlock(input.rolling.total, true),
    "",
    ...(whatIf === null ? [] : [...whatIf, ""]),
    "## レースごとの予想と結果",
    ...(input.digests.length === 0 ? ["(分析したレースはありません)"] : input.digests.flatMap((d) => [raceBlock(d), ""])),
  ];
  return sections.join("\n").trimEnd() + "\n";
}

function cut(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  let head = text.slice(0, max - 1);
  const last = head.charCodeAt(head.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    head = head.slice(0, -1);
  }
  return `${head}…`;
}

function strings(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .slice(0, maxItems)
    .map((v) => cut(v.trim(), maxChars));
}

/** LLM の応答を日報の文章にする。読めなければ null。 */
export function parseNarrative(text: string, knownRaceIds: ReadonlySet<string>): Narrative | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const o = raw as Record<string, unknown>;
  if (typeof o["summary"] !== "string" || o["summary"].trim() === "") {
    return null;
  }
  const races: { raceId: string; comment: string }[] = [];
  if (Array.isArray(o["races"])) {
    for (const r of o["races"]) {
      if (races.length >= NARRATIVE_LIMITS.races) {
        break;
      }
      const e = typeof r === "object" && r !== null ? (r as Record<string, unknown>) : null;
      if (e !== null && typeof e["raceId"] === "string" && knownRaceIds.has(e["raceId"]) && typeof e["comment"] === "string" && e["comment"].trim() !== "") {
        races.push({ raceId: e["raceId"], comment: cut(e["comment"].trim(), NARRATIVE_LIMITS.comment) });
      }
    }
  }
  return {
    summary: cut(o["summary"].trim(), NARRATIVE_LIMITS.summary),
    good: strings(o["good"], NARRATIVE_LIMITS.items, NARRATIVE_LIMITS.item),
    improve: strings(o["improve"], NARRATIVE_LIMITS.items, NARRATIVE_LIMITS.item),
    races,
  };
}
