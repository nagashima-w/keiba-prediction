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
import type { DayStats, RaceDigest } from "./daily-report-digest";
import { formatRecoveryPercent } from "./recovery-format";

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

function statsBlock(s: DayStats): string {
  const lines = [
    `分析したレース: ${s.raceCount} 件(結果あり ${s.resultRaceCount} 件・結果なし ${s.noResultRaceCount} 件・買い目のあるレース ${s.betRaceCount} 件)`,
    `買い目の成績(判定できたもの): 賭け金 ${yen(s.totalStake)}・払戻 ${yen(s.totalReturn)}・回収率 ${s.recoveryRate === null ? "なし(賭け金 0)" : formatRecoveryPercent(s.recoveryRate)}・${s.judgedBetCount} 点中 ${s.hitBetCount} 点的中`,
  ];
  if (s.unjudgedBetCount > 0) {
    lines.push(`判定不能の買い目: ${s.unjudgedBetCount} 点(賭け金 ${yen(s.unjudgedStake)}。結果が無い・払戻が未取得のため成績に含めない)`);
  }
  const types = Object.entries(s.byBetType);
  if (types.length > 0) {
    lines.push(`券種別: ${types.map(([t, v]) => `${betTypeLabel(t)} ${v.betCount} 点中 ${v.hitCount} 点的中(賭け金 ${yen(v.stake)}・払戻 ${yen(v.payout)})`).join(" / ")}`);
  }
  if (s.byMark.length > 0) {
    lines.push(`印別(結果のあるレース。頭数 / 1着 / 3着内): ${s.byMark.map((m) => `${m.mark} ${m.count} / ${m.win} / ${m.top3}`).join("、")}`);
  }
  return lines.join("\n");
}

export interface ReportPromptInput {
  readonly kaisaiDate: string;
  readonly digests: readonly RaceDigest[];
  readonly stats: DayStats;
}

export function buildReportPrompt(input: ReportPromptInput): string {
  const sections: string[] = [
    `あなたは競馬の期待値分析ツールの「日報」を書く振り返り担当です。以下は ${dateLabel(input.kaisaiDate)} に、このツールが発走前に分析した全レースの「予想」と「結果」です。`,
    "利用者は、この日報を読んで、ツールの予想がその日どうだったかを振り返ります。",
    "",
    "## 規則",
    "- 買い目の成績の数字(賭け金・払戻・回収率・的中数)はツールが計算した確定値です。計算し直さず、そのまま引用してください。",
    "- 書いてよいのは、下に書かれた事実から言えることだけです。馬の過去成績・騎手・展開・馬場の傾向など、書かれていないことを推測で補わないでください。",
    "- 「結果: なし」のレースは、予想の成否を判断しないでください(中止や取り込めていないだけの可能性があります)。",
    "- 数十レースの 1 日分では、偶然の影響が大きいです。1〜2 レースだけで起きたことは、偶然の可能性があると断ったうえで書き、繰り返し見える傾向を優先して「良かった点」「改善点」にしてください。",
    "- 改善点は、気づきとして書いてください(プロンプトや重みを変えるよう命令する書き方はしない)。",
    "- 印の意味: ◎本命 / 〇対抗 / ▲単穴 / △連下 / ☆穴(勝ち目)/ 注 穴(3着)。補正後の3着内率は複勝圏(3着以内)に入る確率の予想です。",
    "",
    "## 出力形式",
    "次の JSON オブジェクト 1 つだけを出力してください(前後に説明文・コードフェンスを付けない)。",
    "{",
    `  "summary": "その日の総括。${NARRATIVE_LIMITS.summary} 字以内。結果のあるレース数・的中の状況・回収率など、主な数字を含める",`,
    `  "good": ["良かった点。最大 ${NARRATIVE_LIMITS.items} 件、各 ${NARRATIVE_LIMITS.item} 字以内"],`,
    `  "improve": ["改善点。最大 ${NARRATIVE_LIMITS.items} 件、各 ${NARRATIVE_LIMITS.item} 字以内"],`,
    `  "races": [{"raceId": "下のレースの raceId", "comment": "そのレースの一言。${NARRATIVE_LIMITS.comment} 字以内"}]`,
    "}",
    `"races" は、特に振り返る価値のあるレース(最大 ${NARRATIVE_LIMITS.races} 件。無ければ空の配列)だけにしてください。`,
    "",
    `## ${dateLabel(input.kaisaiDate)} の成績(確定値)`,
    statsBlock(input.stats),
    "",
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
