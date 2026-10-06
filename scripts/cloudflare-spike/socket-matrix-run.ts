/**
 * #162 段階1(socket-matrix)の進行・集計・読み。実ネットワークにも Workers のランタイムにも依存しない純ロジック。
 *
 * **時計・送信・DO の呼び出し試験を注入できる**ので、順序・本数・間隔・打ち切り・マスク・要約・読みを単体テストできる
 * (ドライバが実際の Worker 呼び出しを注入する)。
 *  - netkeiba への本数と間隔は、全体で守る(合計 10 本以内・2 秒間隔。計画は 9 本)
 *  - 400/403/429 の2回連続の打ち切りは、**送信元をまたいだ全体**で数える(#160 は Worker とランナーの対照を残すために
 *    送信元ごとだったが、今回は対照がなく、「gzip を付けた版が拒否された」ことを別の送信元として数えて撃ち続けるのを避ける)
 *  - 本文のハッシュの不一致は事実として記録するだけで、失敗扱いにしない(出馬表・オッズはサーバ側で更新されうる)
 *  - **公開される結果にはマスク済みの値だけを載せる**(IP・workers.dev のサブドメイン・Worker 名・cf-ray の一意の部分)
 */

import { maskHeaderValue, maskText, type MaskContext } from "./echo.js";
import type { SocketFetchMeta } from "./http1.js";
import { judgeReachability, type NetkeibaProbeRecord, type ReachabilityVerdict } from "./reachability.js";
import { BLOCK_STATUSES, RequestGuard, type RequestGuardOptions } from "./request-guard.js";
import {
  buildSocketMatrixPlan,
  REFERENCE_E3_SHUTUBA_BYTES,
  SOCKET_MATRIX_SUBREQUEST_PROBE_COUNT,
  type MatrixRole,
  type MatrixStep,
  type MatrixVariant,
} from "./socket-matrix-plan.js";

/** DO(`SpikeDO`)のどのインスタンスの何回目の呼び出しか。同じインスタンスで再取得したかを事実として残す。 */
export interface DoInstanceInfo {
  readonly id: string;
  readonly call: number;
}

/** ドライバが1本の送信で受け取るもの(Worker → DO → ソケットの記録・メタ・インスタンス)。 */
export interface MatrixSendOutcome {
  readonly record: NetkeibaProbeRecord;
  readonly meta: SocketFetchMeta | null;
  readonly instance: DoInstanceInfo | null;
}

/** Worker から DO を繰り返し呼んで、subrequest の数え方を見る試験(netkeiba へは出ない)の結果。 */
export interface SubrequestProbeResult {
  /** Worker の試験が実行できたか(HTTP の失敗・例外なら false)。 */
  readonly ran: boolean;
  readonly requested: number;
  readonly attempted: number | null;
  readonly succeeded: number | null;
  /** 最初に失敗した呼び出しの通番(1 始まり)。失敗がなければ null。 */
  readonly firstFailureAt: number | null;
  readonly errorKind: SubrequestErrorKind | null;
  readonly error: string | null;
  readonly httpStatus: number | null;
}

export type SubrequestErrorKind = "subrequest-limit" | "cpu-limit" | "other";

/** 失敗のメッセージから種類を分ける(subrequest の上限か、CPU の上限か、その他か)。 */
export function classifySubrequestError(message: string): SubrequestErrorKind {
  if (/too many (?:subrequests|api requests)/i.test(message)) {
    return "subrequest-limit";
  }
  if (/cpu/i.test(message)) {
    return "cpu-limit";
  }
  return "other";
}

export interface SocketMatrixDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** netkeiba へ1本送って結果を返す(例外を投げてもよい。その場合は status=null の記録にする)。 */
  send(step: MatrixStep): Promise<MatrixSendOutcome>;
  /** Worker から DO を `count` 回呼ぶ試験(netkeiba へは出ない。例外を投げてもよい)。 */
  subrequestProbe(count: number): Promise<SubrequestProbeResult>;
  readonly mask: MaskContext;
}

export interface SocketMatrixOptions {
  readonly guard?: RequestGuardOptions;
  /** 送信の計画(テスト用の差し込み口。省略時は `buildSocketMatrixPlan()`)。 */
  readonly plan?: readonly MatrixStep[];
  /** 状態が変わるたびに呼ばれる(途中経過の保存用)。 */
  readonly onUpdate?: (result: SocketMatrixResult) => void;
}

/** 1本の取得の記録(`NetkeibaProbeRecord` に、ステップ・メタ・インスタンスを足したもの。マスク済み)。 */
export interface MatrixRecord extends NetkeibaProbeRecord {
  readonly stepId: string;
  readonly variant: MatrixVariant;
  readonly role: MatrixRole;
  readonly pairWith: string | null;
  readonly meta: SocketFetchMeta | null;
  readonly instance: DoInstanceInfo | null;
  /** 最初の送信からの経過(ms)。 */
  readonly sentAtMs: number;
}

export interface CoverageRow {
  readonly stepId: string;
  readonly targetId: string;
  readonly host: string;
  readonly status: number | null;
  readonly verdict: ReachabilityVerdict;
  readonly parsedKind: string | null;
  readonly parsedCount: number | null;
  readonly replacementChars: number | null;
  /** 展開後の本文のバイト数(取れなければ null)。 */
  readonly bodyBytes: number | null;
}

export interface CompressionRow {
  readonly stepId: string;
  readonly pairWith: string;
  readonly targetId: string;
  readonly identityStatus: number | null;
  readonly gzipStatus: number | null;
  /** 線上の本文のバイト数(chunked の枠を除く。gzip なら圧縮後)。 */
  readonly identityWireBytes: number | null;
  readonly gzipWireBytes: number | null;
  readonly identityDecodedBytes: number | null;
  readonly gzipDecodedBytes: number | null;
  /** gzip の線上のバイト数 / identity の線上のバイト数(小数第3位まで。どちらかが無い・0 バイトなら null)。 */
  readonly wireRatio: number | null;
  readonly identityTotalMs: number | null;
  readonly gzipTotalMs: number | null;
  readonly identityFirstByteMs: number | null;
  readonly gzipFirstByteMs: number | null;
  readonly contentEncoding: string | null;
  /**
   * gzip で返ったか(gzip の応答が 2xx でメタがあるときだけ。content-encoding が gzip なら true、付いていない・identity なら
   * false。拒否・通信エラーなど判断できないときは null)。false は「gzip を要求したが圧縮されなかった」。
   */
  readonly compressed: boolean | null;
  /** 展開後の本文のハッシュが一致したか(両方が 2xx で、メタが両方あるときだけ。それ以外は null)。 */
  readonly bodyHashEqual: boolean | null;
}

export interface RepeatRow {
  readonly stepId: string;
  readonly pairWith: string;
  readonly targetId: string;
  readonly firstStatus: number | null;
  readonly secondStatus: number | null;
  /** 本文のバイト数が同じか(両方が 2xx で、メタが両方あるときだけ。それ以外は null)。 */
  readonly bytesEqual: boolean | null;
  /** 展開後の本文のハッシュが同じか(両方が 2xx で、メタが両方あるときだけ。それ以外は null)。 */
  readonly hashEqual: boolean | null;
  /** 1本目の送信から2本目の送信までの間隔(ms)。 */
  readonly gapMs: number;
  readonly sameInstance: boolean | null;
  readonly firstTotalMs: number | null;
  readonly secondTotalMs: number | null;
}

export interface SocketMatrixSummary {
  readonly coverage: readonly CoverageRow[];
  readonly compression: readonly CompressionRow[];
  readonly repeat: readonly RepeatRow[];
  readonly instances: { readonly distinctIds: number; readonly maxCall: number | null };
}

export interface SocketMatrixReading {
  /** 記録(結果 JSON)に書かれていること。 */
  readonly facts: readonly string[];
  /** 事実からの推測(事実ではない)。 */
  readonly inferences: readonly string[];
  /** 結論の限界。常に併記する。 */
  readonly limitations: readonly string[];
}

export interface SocketMatrixResult {
  readonly plannedCount: number;
  readonly netkeibaRequestCount: number;
  /** 全体の打ち切り理由(max-requests / consecutive-blocks)。なければ null。 */
  readonly stoppedReason: string | null;
  /** 打ち切りで送らなかったステップの ID。 */
  readonly skippedStepIds: readonly string[];
  readonly records: readonly MatrixRecord[];
  readonly summary: SocketMatrixSummary;
  readonly subrequestProbe: SubrequestProbeResult | null;
  readonly reading: SocketMatrixReading;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 2xx か(本文の比較は、両方が 2xx のときだけ行う。拒否のエラー応答の本文どうしを比べて、違いを読まないため)。 */
function is2xx(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

/** 拒否と数えるステータス(request-guard.ts の BLOCK_STATUSES と同じ 400・403・429)。 */
function isRefused(status: number | null): boolean {
  return status !== null && BLOCK_STATUSES.includes(status);
}

/** 事実の文に載せる error の最大文字数(結果を肥大化させない)。 */
const FACT_ERROR_MAX_CHARS = 160;

/**
 * 本文を比較できない理由を、実際の理由で書く(2種類を言い分ける)。
 *  (i) どちらかが 2xx でない(拒否・エラー応答。本文どうしを比べても意味がない)
 *  (ii) 2xx だが本文を扱えなかった(status=2xx・error あり・meta=null。未対応の content-encoding・gzip の展開失敗など。
 *       どのステップか、その記録の error を併記する)
 * 両方が当てはまるときは両方書く。
 */
function describeNotCompared(pair: readonly (MatrixRecord | undefined)[]): string {
  const present = pair.filter((r): r is MatrixRecord => r !== undefined);
  const reasons: string[] = [];
  if (present.some((r) => !is2xx(r.status))) {
    reasons.push(`どちらかが 2xx ではない(${present.map((r) => `${r.stepId}: ${r.status ?? "例外"}`).join("、")})`);
  }
  const unhandled = present.filter((r) => is2xx(r.status) && r.meta === null);
  if (unhandled.length > 0) {
    reasons.push(
      `2xx だが本文を扱えなかった: ${unhandled.map((r) => `${r.stepId}(error: ${(r.error ?? "不明").slice(0, FACT_ERROR_MAX_CHARS)})`).join("、")}`,
    );
  }
  return reasons.join("。");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** 記録から要約(網羅・圧縮の比較・再現性・DO のインスタンス)を作る。 */
export function summarizeSocketMatrix(records: readonly MatrixRecord[]): SocketMatrixSummary {
  const byStep = new Map(records.map((r) => [r.stepId, r]));

  const coverage: CoverageRow[] = records
    .filter((r) => r.variant === "identity" && r.role !== "repeat")
    .map((r) => ({
      stepId: r.stepId,
      targetId: r.targetId,
      host: hostOf(r.url),
      status: r.status,
      verdict: judgeReachability(r).verdict,
      parsedKind: r.parsedKind,
      parsedCount: r.parsedCount,
      replacementChars: r.replacementChars,
      bodyBytes: r.meta?.decodedBytes ?? r.bodyLength,
    }));

  const compression: CompressionRow[] = records
    .filter((r) => r.role === "compression" && r.pairWith !== null)
    .map((g) => {
      const id = byStep.get(g.pairWith!) ?? null;
      const idMeta = id?.meta ?? null;
      const gzMeta = g.meta ?? null;
      const idWire = idMeta?.wireBodyBytes ?? null;
      const gzWire = gzMeta?.wireBodyBytes ?? null;
      // 比較は、両方が 2xx で、メタが両方あるときだけ(拒否のエラー応答の本文で、比率やハッシュの違いを作らない)。
      const comparable = idMeta !== null && gzMeta !== null && is2xx(id?.status ?? null) && is2xx(g.status);
      const ratioable = comparable && idWire !== null && gzWire !== null && idWire > 0;
      return {
        stepId: g.stepId,
        pairWith: g.pairWith!,
        targetId: g.targetId,
        identityStatus: id?.status ?? null,
        gzipStatus: g.status,
        identityWireBytes: idWire,
        gzipWireBytes: gzWire,
        identityDecodedBytes: idMeta?.decodedBytes ?? null,
        gzipDecodedBytes: gzMeta?.decodedBytes ?? null,
        wireRatio: ratioable ? round3(gzWire! / idWire!) : null,
        identityTotalMs: idMeta?.totalMs ?? null,
        gzipTotalMs: gzMeta?.totalMs ?? null,
        identityFirstByteMs: idMeta?.firstByteMs ?? null,
        gzipFirstByteMs: gzMeta?.firstByteMs ?? null,
        contentEncoding: gzMeta?.contentEncoding ?? null,
        compressed: gzMeta !== null && is2xx(g.status) ? gzMeta.contentEncoding === "gzip" : null,
        bodyHashEqual: comparable ? idMeta!.bodySha256 === gzMeta!.bodySha256 : null,
      };
    });

  const repeat: RepeatRow[] = records
    .filter((r) => r.role === "repeat" && r.pairWith !== null)
    .flatMap((second) => {
      const first = byStep.get(second.pairWith!);
      if (first === undefined) {
        return [];
      }
      const a = first.meta;
      const b = second.meta;
      // 本文の比較は、両方が 2xx で、メタが両方あるときだけ。2本目が拒否(403 など)のとき、エラー応答の本文との違いを読まない。
      const comparable = a !== null && b !== null && is2xx(first.status) && is2xx(second.status);
      return [
        {
          stepId: second.stepId,
          pairWith: second.pairWith!,
          targetId: second.targetId,
          firstStatus: first.status,
          secondStatus: second.status,
          bytesEqual: comparable ? a.decodedBytes === b.decodedBytes : null,
          hashEqual: comparable ? a.bodySha256 === b.bodySha256 : null,
          gapMs: second.sentAtMs - first.sentAtMs,
          sameInstance: first.instance !== null && second.instance !== null ? first.instance.id === second.instance.id : null,
          firstTotalMs: a?.totalMs ?? null,
          secondTotalMs: b?.totalMs ?? null,
        },
      ];
    });

  const instances = records.flatMap((r) => (r.instance === null ? [] : [r.instance]));
  return {
    coverage,
    compression,
    repeat,
    instances: {
      distinctIds: new Set(instances.map((i) => i.id)).size,
      maxCall: instances.length === 0 ? null : Math.max(...instances.map((i) => i.call)),
    },
  };
}

const LIMITATIONS: readonly string[] = [
  "標本が小さい: 各セルは n=1(同じ取得先・同じ方式の取得は1本。再現性だけが同じ URL の2本)で、1アカウント・1回の実行。通った・拒否されたという結果は、その1回の観測である。",
  "ms(所要時間)は、CloudFront のキャッシュの状態・経路・実行のタイミングの揺れを含む。n=1 なので、セルどうしの差の下位桁に意味はなく、読めるのは大まかな桁だけ。",
  "本文のハッシュの不一致は、サーバ側での更新(出馬表・オッズの更新)による正当な違いでありうる。拒否や不具合の証拠とは読まない。",
  "プランは確認していない(§6・§7 と同じ Secrets のアカウント。Free と推定しているだけ)。Free でソケットが使えるかの公式の記載は見当たらない。",
  "ヘッダは #160 E3 と同じ4つ(User-Agent・accept・accept-language・sec-fetch-mode)。どのヘッダが拒否に効くか、TLS の特徴や HTTP バージョンが効くかは、この実験では分離できない。",
  "gzip は、2対象(出馬表・三連複のオッズ)だけで測った。ほかの取得先で gzip が通るかは未測定。",
];

/** 要約と DO の呼び出し試験から、事実・推測・限界を組み立てる。事実と推測は混ぜない。 */
export function describeSocketMatrix(
  records: readonly MatrixRecord[],
  summary: SocketMatrixSummary,
  probe: SubrequestProbeResult | null,
  stoppedReason: string | null,
): SocketMatrixReading {
  const facts: string[] = [];
  const inferences: string[] = [];

  // ---- 事実 ----
  facts.push(`DO の中のソケットで netkeiba へ出した本数: ${records.length} 本`);
  for (const r of records) {
    const j = judgeReachability(r);
    const gz = r.variant === "gzip" ? "、gzip を要求" : "";
    facts.push(
      `${r.stepId}: ${r.status ?? "例外"}(${r.targetId}${gz}。判定 ${j.verdict}、パース ${r.parsedCount ?? "未実施"} 件、本文 ${r.meta?.decodedBytes ?? r.bodyLength ?? "-"} バイト)`,
    );
  }
  facts.push(stoppedReason === null ? "打ち切り: なし" : `打ち切り: ${stoppedReason}`);

  const s1 = records.find((r) => r.stepId === "S1");
  if (s1 !== undefined && s1.status === 200) {
    const bytes = s1.meta?.decodedBytes ?? s1.bodyLength;
    facts.push(
      `出馬表(S1)の本文は ${bytes ?? "-"} バイトで、#160 E3(通常の Worker のソケット)の ${REFERENCE_E3_SHUTUBA_BYTES} バイトと${
        bytes === REFERENCE_E3_SHUTUBA_BYTES ? "同じ" : "違う"
      }`,
    );
  }

  for (const row of summary.compression) {
    if (row.gzipStatus === null || row.identityStatus === null) {
      continue;
    }
    if (row.bodyHashEqual === null) {
      // 比較できない(どちらかが 2xx でない、または 2xx だが本文を扱えなかった)とき、本文・所要時間・ハッシュは比較しない。
      // bodyHashEqual は、両方が 2xx でメタが両方あるときだけ値を持つ。理由は実際のものを書く(describeNotCompared)。
      facts.push(
        `${row.stepId}: gzip の取得(HTTP ${row.gzipStatus})と identity(${row.pairWith}。HTTP ${row.identityStatus})は、本文・所要時間を比較しない(${describeNotCompared([
          records.find((r) => r.stepId === row.pairWith),
          records.find((r) => r.stepId === row.stepId),
        ])})`,
      );
      continue;
    }
    const hash = row.bodyHashEqual ? "一致" : "不一致";
    const times = `所要時間(全体)は gzip ${row.gzipTotalMs ?? "-"} ms / identity ${row.identityTotalMs ?? "-"} ms`;
    if (row.compressed) {
      facts.push(
        `${row.stepId}: content-encoding: gzip で返った。gzip の線上の本文は ${row.gzipWireBytes} バイトで、identity(${row.pairWith}。${row.identityWireBytes} バイト)の ${row.wireRatio ?? "-"} 倍。` +
          `展開後は ${row.gzipDecodedBytes} バイト。${times}、展開後の本文のハッシュは${hash}`,
      );
    } else {
      facts.push(
        `${row.stepId}: gzip を要求したが圧縮されなかった(content-encoding: ${row.contentEncoding ?? "なし"})。本文は ${row.gzipWireBytes} バイトで、identity(${row.pairWith}。${row.identityWireBytes} バイト)と${
          row.gzipWireBytes === row.identityWireBytes ? "同じ" : "違う"
        }。${times}、本文のハッシュは${hash}`,
      );
    }
  }
  for (const row of summary.repeat) {
    const head = `${row.stepId}: ${row.pairWith} と同じ URL の2回目(${row.gapMs} ms 後)。ステータスは ${row.firstStatus ?? "例外"} → ${row.secondStatus ?? "例外"}`;
    const instance = `DO のインスタンスは${row.sameInstance === null ? "比較できない" : row.sameInstance ? "同じ" : "別"}`;
    if (row.bytesEqual === null && row.hashEqual === null) {
      const reason = describeNotCompared([
        records.find((r) => r.stepId === row.pairWith),
        records.find((r) => r.stepId === row.stepId),
      ]);
      facts.push(`${head}、本文は比較しない(両方が 2xx のときだけ比較する。${reason})、${instance}`);
    } else {
      facts.push(
        `${head}、本文のバイト数は${row.bytesEqual === null ? "比較できない" : row.bytesEqual ? "同じ" : "違う"}、` +
          `本文のハッシュは${row.hashEqual === null ? "比較できない" : row.hashEqual ? "一致" : "不一致"}、${instance}`,
      );
    }
  }
  facts.push(
    `DO のインスタンス: 記録全体で異なる ID は ${summary.instances.distinctIds} 個(呼び出し通番の最大は ${summary.instances.maxCall ?? "なし"})`,
  );

  if (probe !== null) {
    if (!probe.ran) {
      facts.push(`Worker から DO を ${probe.requested} 回呼ぶ試験は、実行できなかった(${probe.error ?? "理由不明"})`);
    } else if (probe.firstFailureAt === null) {
      facts.push(`Worker から DO を ${probe.requested} 回呼ぶ試験: ${probe.requested} 回すべて成功した`);
    } else {
      facts.push(
        `Worker から DO を ${probe.requested} 回呼ぶ試験: ${probe.succeeded ?? "-"} 回成功し、${probe.firstFailureAt} 回目で失敗した(種類: ${probe.errorKind ?? "不明"}。メッセージ: ${probe.error ?? "-"})`,
      );
    }
  }

  // ---- 推測(事実ではない) ----
  if (s1 !== undefined) {
    if (judgeReachability(s1).verdict === "ok") {
      inferences.push(
        "DO の中から、通常の Worker(#160 E3)と同じヘッダで、出馬表が通った(取得でき、既存パーサで読めた)。これは1回の観測で、DO と通常の Worker で送信元の扱いが同じかどうかは分離できていない。",
      );
    } else {
      inferences.push(
        "DO の中からの取得は、この実行では出馬表が読めなかった。原因が DO にあるのか、実行のタイミングや netkeiba 側の判定なのかは、この実験では分離できない。",
      );
    }
  }
  const notOk = summary.coverage.filter((c) => c.verdict !== "ok").map((c) => c.stepId);
  if (summary.coverage.length > 1) {
    inferences.push(
      notOk.length === 0
        ? `測った identity の取得先(${summary.coverage.map((c) => c.stepId).join("・")})は、すべて ok と判定された。取得先ごとに1本ずつの観測である。`
        : `identity の取得先のうち ok でなかったもの: ${notOk.join("・")}。理由は、判定(blocked・パース失敗・通信エラー)ごとに記録を見る。`,
    );
  }
  for (const row of summary.compression) {
    const idOk = is2xx(row.identityStatus);
    if (isRefused(row.gzipStatus)) {
      // gzip の拒否を Accept-Encoding の引き金と読むのは、対の identity と、**直前に送った identity** がどちらも拒否されて
      // いないときだけ(直前の identity も拒否されていたら、時間経過・連続した取得による拒否と区別できない)。
      const at = records.findIndex((r) => r.stepId === row.stepId);
      const prior = at < 0 ? undefined : records.slice(0, at).reverse().find((r) => r.variant === "identity");
      const priorPassed = prior !== undefined && prior.status !== null && !isRefused(prior.status);
      if (idOk && priorPassed) {
        inferences.push(
          `${row.stepId}: identity(${row.pairWith}。直前の identity は ${prior.stepId})は通り、Accept-Encoding: gzip を足した版が拒否された。Accept-Encoding の追加が拒否の引き金になった疑いがある(変えたのはこのヘッダ1つだけ。ただし2本の標本)。`,
        );
      } else {
        inferences.push(
          `${row.stepId}: gzip の取得が拒否されたが、Accept-Encoding の追加が原因かは区別できない(対の identity ${row.pairWith} が通っていない、または直前の identity の取得(${
            prior?.stepId ?? "なし"
          })が拒否・未取得で、時間経過や連続した取得による拒否と区別できない)。`,
        );
      }
    } else if (is2xx(row.gzipStatus)) {
      const gz = records.find((r) => r.stepId === row.stepId);
      if (gz !== undefined && gz.meta === null) {
        // 2xx だが本文を扱えなかった(未対応の content-encoding・gzip の展開失敗など)。圧縮の有無も本文も読めていない。
        inferences.push(
          `${row.stepId}: Accept-Encoding: gzip を足して、拒否はされなかったが、本文を扱えなかった(error: ${(gz.error ?? "不明").slice(0, FACT_ERROR_MAX_CHARS)})。圧縮されたかどうか・本文は読めていない。`,
        );
        continue;
      }
      inferences.push(
        row.compressed === false
          ? `${row.stepId}: Accept-Encoding: gzip を足しても拒否されなかったが、サーバは圧縮せずに返した(圧縮されなかった。この取得先の1本の観測)。`
          : `${row.stepId}: Accept-Encoding: gzip を足しても拒否されなかった(この取得先の1本の観測)。`,
      );
    }
  }
  for (const row of summary.repeat) {
    if (row.hashEqual === false) {
      inferences.push(
        `${row.stepId}: 同じ URL の2本で本文が違った。サーバ側の更新による正当な違いの可能性があり、拒否や不具合とは読まない。`,
      );
    }
  }
  if (probe !== null && probe.ran) {
    if (probe.firstFailureAt === null) {
      inferences.push(
        `Worker から DO を ${probe.requested} 回呼んで失敗しなかったので、DO の呼び出し(stub.fetch)は、Free の subrequest 上限(50)に数えられていないか、上限がこのアカウントでは違う可能性がある(プランは未確認)。`,
      );
    } else if (probe.errorKind === "subrequest-limit") {
      inferences.push(
        `${probe.firstFailureAt} 回目で subrequest の上限のメッセージが出たので、DO の呼び出しが呼び出し側の subrequest 数に数えられている疑いがある(Free の上限 50 と整合するが、プランは未確認)。DO の中のソケットが数えられるかは、この試験では測っていない。`,
      );
    } else {
      inferences.push(
        `${probe.firstFailureAt} 回目の失敗の種類は ${probe.errorKind ?? "不明"} で、subrequest の数え方は、この試験からは決められない。`,
      );
    }
  }

  return { facts, inferences, limitations: LIMITATIONS };
}

function maskRecord(record: NetkeibaProbeRecord, mask: MaskContext): NetkeibaProbeRecord {
  return {
    ...record,
    headers: Object.fromEntries(Object.entries(record.headers).map(([k, v]) => [k, maskHeaderValue(k, v, mask)])),
    bodyHead: record.bodyHead === null ? null : maskText(record.bodyHead, mask),
    parseError: record.parseError === null ? null : maskText(record.parseError, mask),
    error: record.error === null ? null : maskText(record.error, mask),
  };
}

function emptyRecord(step: MatrixStep, error: string): NetkeibaProbeRecord {
  return {
    targetId: step.target.id,
    url: step.target.url,
    status: null,
    bodyLength: null,
    charset: null,
    parsedKind: step.target.kind,
    parsedCount: null,
    parseError: null,
    replacementChars: null,
    headers: {},
    bodyHead: null,
    error,
  };
}

export async function runSocketMatrix(deps: SocketMatrixDeps, options: SocketMatrixOptions = {}): Promise<SocketMatrixResult> {
  const plan = options.plan ?? buildSocketMatrixPlan();
  // 連続拒否は全体(送信元をまたがず)で数える。本数・間隔・連続拒否の既定は request-guard.ts の定数(10 本・2 秒・2 回)。
  const guard = new RequestGuard(options.guard);
  const records: MatrixRecord[] = [];
  const skipped: string[] = [];
  let stoppedReason: string | null = null;
  let probe: SubrequestProbeResult | null = null;
  let startedAt: number | null = null;

  const assemble = (): SocketMatrixResult => {
    const summary = summarizeSocketMatrix(records);
    return {
      plannedCount: plan.length,
      netkeibaRequestCount: guard.sentCount,
      stoppedReason,
      skippedStepIds: [...skipped],
      records: [...records],
      summary,
      subrequestProbe: probe,
      reading: describeSocketMatrix(records, summary, probe, stoppedReason),
    };
  };
  const notify = (): void => options.onUpdate?.(assemble());

  for (const step of plan) {
    // 打ち切り後も guard は許可を返さない(連続拒否・本数の状態は戻らない)ので、残りはここでも送らない。
    const decision = guard.next(deps.now());
    if (!decision.allow) {
      stoppedReason = decision.reason;
      skipped.push(step.id);
      continue;
    }
    if (decision.waitMs > 0) {
      await deps.sleep(decision.waitMs);
    }
    const sentAt = deps.now();
    startedAt ??= sentAt;
    guard.markSent(sentAt);
    let outcome: MatrixSendOutcome;
    try {
      outcome = await deps.send(step);
    } catch (error) {
      outcome = { record: emptyRecord(step, messageOf(error)), meta: null, instance: null };
    }
    guard.recordStatus(outcome.record.status);
    records.push({
      ...maskRecord(outcome.record, deps.mask),
      stepId: step.id,
      variant: step.variant,
      role: step.role,
      pairWith: step.pairWith,
      meta: outcome.meta,
      instance: outcome.instance,
      sentAtMs: sentAt - startedAt,
    });
    notify();
  }

  // netkeiba へ出ない試験は、打ち切りの有無にかかわらず実行する(別の問いに答える)。
  try {
    const raw = await deps.subrequestProbe(SOCKET_MATRIX_SUBREQUEST_PROBE_COUNT);
    probe = { ...raw, error: raw.error === null ? null : maskText(raw.error, deps.mask) };
  } catch (error) {
    probe = {
      ran: false,
      requested: SOCKET_MATRIX_SUBREQUEST_PROBE_COUNT,
      attempted: null,
      succeeded: null,
      firstFailureAt: null,
      errorKind: null,
      error: maskText(messageOf(error), deps.mask),
      httpStatus: null,
    };
  }
  notify();
  return assemble();
}
