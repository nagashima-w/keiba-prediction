/**
 * 月報(Issue #265・#280)のプロンプトの組み立てと、LLM の応答(JSON)の解釈。**純関数**。
 *
 * 方針(日報の `daily-report-prompt.ts` と同じ。日報の規則をそのまま引き継ぐ):
 *  - 数字は決定的に計算済み(`monthly-stats.ts`)。プロンプトには確定値として渡し、LLM には計算させない。
 *  - **渡すのは月の確定値の節だけ**(ユーザーの決定・2026-10-13): 月全体の成績・開催日ごとの表・券種別・印別・「もしも」・版ごとの表。
 *    各レースのブロックと日報の総括(LLM の文章)は渡さない(要約の要約で誤りが伝わるため)。
 *  - LLM が書くのは「総括・良かった点・改善点・来月に向けて」だけ。気づきとして書かせ、**プロンプトや重みを変えるよう命令する書き方はさせない**
 *    (月報は記録と振り返りの材料。`docs/prompt-improvement-plan.md`)。
 *  - 送信は既存の `MessageSender` で、system を別に持たない。規則・出力形式・事実を 1 通のユーザーメッセージにまとめる。
 *  - 応答は JSON。コードフェンス・前後の説明文があっても、最初の `{` から最後の `}` までを読む。読めなければ null(呼び出し側が生テキストを本文にする)。
 *
 * この module は、クライアント(ブラウザの束)から import しない(プロンプトの文面が束に入って肥大するため)。
 */
import { dateLabel, periodBlock, whatIfRows, WHATIF_HEADING, yen } from "./daily-report-prompt";
import { formatMonthLabel } from "./monthly-month";
import type { MonthDayRow, MonthStats, MonthVersionRow } from "./monthly-stats";
import { formatRecoveryPercent } from "./recovery-format";

/**
 * 月報のプロンプトの版。月報の本文(`MonthlyReportBody.promptVersion`)に残し、どの文面が書いた月報かを後から区別する(日報の `REPORT_PROMPT_VERSION` とは別)。
 * **プロンプトの文面〈規則・出力形式・成績の節の書き方〉を変えたら更新する。**
 */
export const MONTHLY_PROMPT_VERSION = "monthly-2026-10-13.1";

/** 応答の最大トークン数(thinking を含む)。日報と同じ値(月報の JSON は日報より短い)。非ストリーミングの上限(21333)未満。 */
export const MONTHLY_MAX_TOKENS = 12000;

/** 解釈した応答の長さの上限(UTF-16 の長さ)と件数。日報の `NARRATIVE_LIMITS` に倣う。 */
export const MONTHLY_NARRATIVE_LIMITS = { summary: 500, items: 6, item: 200 } as const;

export interface MonthlyNarrative {
  /** 総括(Discord の説明に載せる)。 */
  readonly summary: string;
  readonly good: readonly string[];
  readonly improve: readonly string[];
  /** 来月に向けて(見ておく数字・確かめたい点)。 */
  readonly outlook: readonly string[];
}

export interface MonthlyPromptInput {
  /** YYYYMM。 */
  readonly month: string;
  readonly stats: MonthStats;
  /** 最終日の結果・日報がそろう前に作った(最終日の分が一部未反映かもしれない)。 */
  readonly lastDayPending: boolean;
}

const resultText = (r: { readonly totalStake: number; readonly totalReturn: number; readonly recoveryRate: number | null; readonly judgedBetCount: number; readonly hitBetCount: number }, refunded: number): string =>
  `賭け金 ${yen(r.totalStake)}・払戻 ${yen(r.totalReturn)}・回収率 ${r.recoveryRate === null ? "なし(賭け金 0)" : formatRecoveryPercent(r.recoveryRate)}・${r.judgedBetCount} 点中 ${r.hitBetCount} 点的中${refunded > 0 ? `(うち返還 ${refunded} 点)` : ""}`;

function dayRow(d: MonthDayRow): string {
  // 判定不能の買い目がある日だけ、その点数と賭け金を添える(成績の数字には含まれない。月全体の「判定不能の買い目」との対応が分かるように)。無い日は従来の文面のまま。
  const unjudged = d.unjudgedBetCount > 0 ? `・判定不能 ${d.unjudgedBetCount} 点(賭け金 ${yen(d.unjudgedStake)})` : "";
  return `- ${dateLabel(d.date)}: ${d.raceCount} レース${d.noResultRaceCount > 0 ? `(結果なし ${d.noResultRaceCount})` : ""}・${resultText(d, d.refundedBetCount)}${unjudged}`;
}

function versionRow(v: MonthVersionRow): string {
  return `- ${v.promptVersion ?? "版不明"}: ${v.raceCount} レース(結果あり ${v.resultRaceCount})・${resultText(v, 0)}`;
}

export function buildMonthlyPrompt(input: MonthlyPromptInput): string {
  const { stats } = input;
  const label = formatMonthLabel(input.month);
  const hasRefund = stats.refundedBetCount > 0;
  const hasVersions = stats.byVersion.length >= 2;
  const whatIf = stats.whatIf;
  const sections: string[] = [
    `あなたは競馬の期待値分析ツールの「月報」を書く振り返り担当です。以下は ${label}の 1 か月に、このツールが発走前に分析した全レースの成績を集計した「確定値」です。`,
    "利用者は、この月報を読んで、ツールの予想がその月どうだったかを振り返ります。日報より長い期間なので、1 日の出来事ではなく、月を通して見える傾向を述べてください。",
    "",
    "## 規則",
    "- 成績の数字(賭け金・払戻・回収率・的中数)はツールが計算した確定値です。計算し直さず、そのまま引用してください。",
    "- 書いてよいのは、下に書かれた事実から言えることだけです。馬の過去成績・騎手・展開・馬場の傾向など、書かれていないことを推測で補わないでください。前の月・昨年との比較は、材料が無いので書かないでください。",
    "- このツールは穴馬の高配当を狙います。的中の頻度は低く、少数の的中で回収率が大きく動くのは想定どおりです。回収率が少数の的中で動いたこと自体を、問題としても手柄としても書かないでください。",
    "- 予想の評価は「見込みの的中数」との比較で書いてください。見込みの的中数は、判定できた買い目それぞれの分析時点の的中確率の合計です(確定値)。実際の的中数が見込みを上回ったか、下回ったか、同程度かを、数字を挙げて述べてください。あわせて、払戻が最大の 1 点を除いた回収率を挙げ、月の回収率がその 1 点にどれだけ依存しているかを述べてください。",
    "- 「偶然」と書いてよいのは、その根拠を下の確定値の数字で示せるときだけです(例: 払戻が最大の 1 点を除いた回収率、点数の少なさ)。見込みの的中数との比較で説明できることは、「偶然」ではなく見込みとの比較で書いてください。数字を伴わない定型の断りは書かないでください。「偶然」という断りは、総括で多くとも 1 回にして、良かった点・改善点では繰り返さないでください。",
    "- 開催日数や点数が少ないときは、その少なさを一度だけ述べ、月の傾向を断定しないでください。券種別・印別・「もしも」の型も、点数の少ない区分は断定しないでください。",
    "- 開催日ごとの表は、成績が特定の日に偏っていたかを、数字を挙げて述べるために使ってください。1 日だけの出来事を、月の傾向として書かないでください。",
    ...(whatIf === null || whatIf === undefined
      ? []
      : ["- 「もしも」(印の定型の買い方)の成績は、後から買い方を選び直したときの参考値です。続けてよい型かどうかは、月の点数と回収率で述べてください(点数の少ない型は断定しない)。実際の配分とは点数も賭け金も揃っていません。"]),
    ...(hasVersions
      ? ["- プロンプトの版ごとの表は、版ごとの件数が少なく、回収率の差は偶然の範囲のことが多いものです。版の優劣を決める材料にしないでください。版の違いを結論として書かないでください。"]
      : []),
    ...(hasRefund
      ? ["- 「返還」は、取消・除外になった馬を含む買い目で、賭け金がそのまま戻ったものです。的中でもはずれでもないので、「はずれ」と書かないでください。賭け金と払戻の両方に含まれ(回収率の計算に入っています)、的中数・見込みの的中数には含めません。予想の巧拙の根拠にしないでください。"]
      : []),
    ...(input.lastDayPending
      ? ["- 最終日の結果または日報がそろう前に作ったため、最終日の分は一部または全部が反映されていない可能性があります。最終日の成績を断定しないでください。"]
      : []),
    "- 改善点は、気づきとして書いてください(プロンプトや重みを変えるよう命令する書き方はしない)。",
    "- 来月に向けては、来月も見ておくとよい数字・確かめたい点を、気づきの形で書いてください(「〜すべき」「〜を変える」のように命令しない。来月の結果を予言しない)。",
    "- 印の意味: ◎本命 / 〇対抗 / ▲単穴 / △連下 / ☆穴(勝ち目)/ 注 穴(3着)。",
    "",
    "## 出力形式",
    "次の JSON オブジェクト 1 つだけを出力してください(前後に説明文・コードフェンスを付けない)。",
    "{",
    `  "summary": "その月の総括。${MONTHLY_NARRATIVE_LIMITS.summary} 字以内。分析したレース数・見込みの的中数と実際の的中数の比較・回収率など、主な数字を含める",`,
    `  "good": ["良かった点。最大 ${MONTHLY_NARRATIVE_LIMITS.items} 件、各 ${MONTHLY_NARRATIVE_LIMITS.item} 字以内"],`,
    `  "improve": ["改善点。最大 ${MONTHLY_NARRATIVE_LIMITS.items} 件、各 ${MONTHLY_NARRATIVE_LIMITS.item} 字以内"],`,
    `  "outlook": ["来月に向けて(見ておく数字・確かめたい点)。最大 ${MONTHLY_NARRATIVE_LIMITS.items} 件、各 ${MONTHLY_NARRATIVE_LIMITS.item} 字以内"]`,
    "}",
    "",
    `## ${label}の成績(確定値)`,
    periodBlock(stats, true),
    "",
    "## 開催日ごとの成績(確定値)",
    ...stats.days.map(dayRow),
    "",
    ...(whatIf === null || whatIf === undefined
      ? []
      : [
          `## ${WHATIF_HEADING}`,
          "印の定型の買い方(下の 5 つの型)を、毎レース各 100 円で買っていたときの月の成績です。対象は印の付いたレース全部で、実際の配分(買い目のあるレースだけ)とは点数も賭け金も揃っていません。判定不能は結果・払戻が未取得のレース、対象外は必要な印が付いていないレースで、どちらも成績に含めません。",
          ...whatIfRows(whatIf),
          "",
        ]),
    ...(hasVersions ? ["## プロンプトの版ごとの成績(確定値)", ...stats.byVersion.map(versionRow), ""] : []),
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

/** LLM の応答を月報の文章にする。読めなければ null。 */
export function parseMonthlyNarrative(text: string): MonthlyNarrative | null {
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
  return {
    summary: cut(o["summary"].trim(), MONTHLY_NARRATIVE_LIMITS.summary),
    good: strings(o["good"], MONTHLY_NARRATIVE_LIMITS.items, MONTHLY_NARRATIVE_LIMITS.item),
    improve: strings(o["improve"], MONTHLY_NARRATIVE_LIMITS.items, MONTHLY_NARRATIVE_LIMITS.item),
    outlook: strings(o["outlook"], MONTHLY_NARRATIVE_LIMITS.items, MONTHLY_NARRATIVE_LIMITS.item),
  };
}

