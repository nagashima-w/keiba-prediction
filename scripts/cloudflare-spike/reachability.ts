/**
 * 到達性(netkeiba が Cloudflare Workers のデータセンター IP からのアクセスを受け付けるか)の
 * 判定と集計(Issue #159〈#21-A〉)。Worker が返した記録を入力にする純ロジック。
 */

/** Worker が1本の取得について返す記録。 */
export interface NetkeibaProbeRecord {
  readonly targetId: string;
  readonly url: string;
  /** HTTP ステータス。fetch が例外のときは null。 */
  readonly status: number | null;
  /** 応答本文のバイト数(取得できなければ null)。 */
  readonly bodyLength: number | null;
  /** Content-Type の charset(なければ null)。 */
  readonly charset: string | null;
  /** どのパーサで読んだか(shutuba / odds-json / horse-page / horse-results)。 */
  readonly parsedKind: string | null;
  /** 既存パーサが読めた件数(出馬表なら頭数など)。未実施・失敗は null。 */
  readonly parsedCount: number | null;
  readonly parseError: string | null;
  /** デコード後の文字列に含まれる置換文字(U+FFFD)の数。文字化けの検出用。 */
  readonly replacementChars: number | null;
  /** 診断用に選んだ応答ヘッダ(server / cf-ray / cf-mitigated 等)。 */
  readonly headers: Readonly<Record<string, string>>;
  /** 非 2xx またはパース失敗のときの本文の先頭(診断用。成功時は null)。 */
  readonly bodyHead: string | null;
  /** fetch の例外メッセージなど。 */
  readonly error: string | null;
}

export type ReachabilityVerdict =
  | "ok"
  | "reachable-but-unparsed"
  | "blocked"
  | "challenge"
  | "redirect"
  | "http-error"
  | "network-error";

export interface ReachabilityJudgement {
  readonly verdict: ReachabilityVerdict;
  readonly reason: string;
}

const CHALLENGE_BODY_PATTERN = /just a moment|attention required|cf-chl|challenge-platform/i;

function isChallenge(record: NetkeibaProbeRecord): boolean {
  if ((record.headers["cf-mitigated"] ?? "").toLowerCase() === "challenge") {
    return true;
  }
  return record.bodyHead !== null && CHALLENGE_BODY_PATTERN.test(record.bodyHead);
}

/** 1本の取得結果から到達性を判定する。 */
export function judgeReachability(record: NetkeibaProbeRecord): ReachabilityJudgement {
  const { status } = record;
  if (status === null) {
    return {
      verdict: "network-error",
      reason: `fetch が例外になりました(${record.error ?? "原因不明"})`,
    };
  }
  if (isChallenge(record) && (status === 403 || status === 503 || (status >= 200 && status < 300 && !(record.parsedCount !== null && record.parsedCount > 0)))) {
    return {
      verdict: "challenge",
      reason: `Cloudflare のチャレンジページと思われます(HTTP ${status})`,
    };
  }
  if (status === 400 || status === 403 || status === 429) {
    return { verdict: "blocked", reason: `拒否されました(HTTP ${status})` };
  }
  if (status >= 300 && status < 400) {
    // Worker はリダイレクトに従わない(redirect: "manual")ので、転送は到達したが先へは進んでいない状態として区別する。
    return {
      verdict: "redirect",
      reason: `到達しましたが転送されました(HTTP ${status}、転送先: ${record.headers["location"] ?? "不明"})。追従はしていません`,
    };
  }
  if (status >= 200 && status < 300) {
    if (record.parseError !== null) {
      return {
        verdict: "reachable-but-unparsed",
        reason: `到達しましたが既存パーサが失敗しました(${record.parseError})`,
      };
    }
    if (record.parsedCount === null || record.parsedCount <= 0) {
      return {
        verdict: "reachable-but-unparsed",
        reason: `到達しましたが既存パーサで1件も読めませんでした(件数 ${record.parsedCount ?? "未実施"})`,
      };
    }
    if (record.replacementChars !== null && record.replacementChars > 0) {
      return {
        verdict: "reachable-but-unparsed",
        reason: `パースはできましたが文字化け(置換文字 ${record.replacementChars} 個)があります`,
      };
    }
    return { verdict: "ok", reason: `HTTP ${status}、既存パーサで ${record.parsedCount} 件を読めました` };
  }
  return { verdict: "http-error", reason: `想定外のステータスです(HTTP ${status})` };
}

export interface ReachabilitySummary {
  readonly total: number;
  readonly counts: Readonly<Record<ReachabilityVerdict, number>>;
  readonly byHost: Readonly<Record<string, { readonly ok: number; readonly total: number }>>;
}

/** 判定ごとの件数と、ホストごとの ok 数/総数を数える。 */
export function summarizeReachability(
  records: readonly NetkeibaProbeRecord[],
): ReachabilitySummary {
  const counts: Record<ReachabilityVerdict, number> = {
    ok: 0,
    "reachable-but-unparsed": 0,
    blocked: 0,
    challenge: 0,
    redirect: 0,
    "http-error": 0,
    "network-error": 0,
  };
  const byHost: Record<string, { ok: number; total: number }> = {};
  for (const record of records) {
    const { verdict } = judgeReachability(record);
    counts[verdict] += 1;
    let host = "(不明)";
    try {
      host = new URL(record.url).hostname;
    } catch {
      // URL として読めない記録は不明ホストに数える。
    }
    const entry = (byHost[host] ??= { ok: 0, total: 0 });
    entry.total += 1;
    if (verdict === "ok") {
      entry.ok += 1;
    }
  }
  return { total: records.length, counts, byHost };
}
