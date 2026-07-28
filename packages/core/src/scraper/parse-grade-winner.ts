/**
 * 同レース(重賞)の過去10年結果・優勝馬 API(AplGradeWinner)のレスポンスパーサ(タスク機能B)。
 *
 * レスポンスは `{status, reason, data}` のJSONで、`status !== "OK"` は非重賞・対象データなし
 * (呼び出し側は静かにスキップする。エラーではない)。`status === "OK"` のとき、
 * `data` 配下のキーの1つ(`nkrace_gw::race_ids_<hash>` のようにハッシュを含む)の値が
 * base64 + zlib(deflate)で圧縮された過去10回分のJSON配列になっている。
 * ハッシュは事前に分からないため、キー名をハードコードせず「`_last_dt` で終わらないキー」を
 * 拾う実装にする(2026-07-28 boss着手前ゲート合意・recon確認済み)。
 *
 * 本ファイルは「入力=生レスポンス文字列、出力=正規化済み型」の純関数のみを持つ
 * (ネットワークアクセスは行わない。取得アダプタは fetch-grade-winner.ts に分離する)。
 *
 * 型の揺れに注意(実測。正規化して吸収する):
 * - odds/futan/haron3/weight_diff/chakusa は文字列(本パーサは集計に使う haron3/chakusa のみ
 *   正規化対象とする。odds/futan/weight_diff は今回のスコープ〈5集計項目〉で未使用のため
 *   型定義に含めない)。
 * - ninki/tosu/kyori/weight は数値。
 * - chakusa は先頭馬(着差なし)で空文字になる(異常ではない。nullへ正規化する)。
 * - ijyo は正常時に半角スペース1文字("&nbsp;"ではない)になる。トリムして空になれば
 *   null(正常)、非空なら異常事由(取消・除外等)の文字列として扱う。
 */

import { inflateSync } from "node:zlib";

/** 過去10年結果APIのパース失敗を表す例外(status:"OK"なのに構造が壊れている場合のみ)。 */
export class GradeWinnerParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GradeWinnerParseError";
  }
}

/** 1走(上位入線馬)分の結果。 */
export interface GradeWinnerResultHorse {
  /** 枠番。取得できなければ null。 */
  readonly wakuban: number | null;
  /** 馬番。取得できなければ null。 */
  readonly umaban: number | null;
  /**
   * 確定着順。降着があった場合はこちらが正(nyusenとは異なる場合がある)。
   * 中止・除外・取消(ijyoが非null)等では null になり得る。
   */
  readonly kakutei: number | null;
  /** 入線順位(降着前)。確定着順(kakutei)と異なる場合、降着があったことを示す。 */
  readonly nyusen: number | null;
  /** 同着コード。同着でなければ null。 */
  readonly dochakuCd: string | null;
  /** 同着頭数。同着でなければ null。 */
  readonly dochakuTosu: number | null;
  /** 異常区分(取消・除外・中止等)。正常なら null(半角スペースをトリムして判定)。 */
  readonly ijyo: string | null;
  /** コーナー通過順(例: "7-8-7-7")。取得できなければ null。 */
  readonly corner: string | null;
  /** 上がり3F(秒)。文字列表記を数値化する。取得・解析できなければ null。 */
  readonly haron3: number | null;
  /** 単勝人気。取得できなければ null。 */
  readonly ninki: number | null;
  /** 着差。先頭馬は空文字(正規化してnull)。取得できなければ null。 */
  readonly chakusa: string | null;
}

/** 払戻(複勝1〜3着分のみ。本ツールが複勝EV中心のため必須採用)。 */
export interface GradeWinnerPayback {
  readonly fukuPay1: number | null;
  readonly fukuNinki1: number | null;
  readonly fukuPay2: number | null;
  readonly fukuNinki2: number | null;
  readonly fukuPay3: number | null;
  readonly fukuNinki3: number | null;
}

/** 過去10年結果APIの1回(1年)分。 */
export interface GradeWinnerEntry {
  /** レースID。年ごとに異なる(このフィールドを信頼し、年を機械的に置換して導出しないこと)。 */
  readonly raceId: string | null;
  /** 開催日(YYYY-MM-DD)。 */
  readonly raceDate: string | null;
  /** 競馬場名(例: 福島)。 */
  readonly jyo: string | null;
  /** 開催回次(第N回)。 */
  readonly nkai: number | null;
  /** 距離(m)。 */
  readonly kyori: number | null;
  /** コース種別(芝/ダ等。生テキスト)。 */
  readonly track: string | null;
  /** 柵(coursekubun_cd)。フィルタには使わず材料として提示する。 */
  readonly fence: string | null;
  /** 馬場状態。 */
  readonly baba: string | null;
  /** 天候。 */
  readonly tenko: string | null;
  /** 出走頭数。 */
  readonly tosu: number | null;
  /** 上がり3F(先頭)。 */
  readonly haronL3: number | null;
  /** 上がり3F(後方)。 */
  readonly haronS3: number | null;
  /** 上位入線馬の結果(通常3件だが、同着等で件数が変わり得るため配列長を仮定しない)。 */
  readonly result: readonly GradeWinnerResultHorse[];
  /** 払戻(複勝関連のみ)。取得できなければ null。 */
  readonly payback: GradeWinnerPayback | null;
}

/** APIレスポンス全体のJSON構造(必要部分のみ)。 */
interface RawApiResponse {
  status?: unknown;
  reason?: unknown;
  data?: unknown;
}

/** 数値・数値文字列を number へ、それ以外(空文字・非数値・null/undefined)は null へ正規化する。 */
function numOrNull(raw: unknown): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw === "string") {
    const t = raw.trim();
    if (t === "") {
      return null;
    }
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 文字列をトリムし、空文字なら null にする(半角スペースのみの ijyo 等に対応)。 */
function strOrNull(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const t = raw.trim();
  return t === "" ? null : t;
}

/** 生のresult要素を GradeWinnerResultHorse に正規化する。 */
function parseResultHorse(raw: unknown): GradeWinnerResultHorse {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    wakuban: numOrNull(r.wakuban),
    umaban: numOrNull(r.umaban),
    kakutei: numOrNull(r.kakutei),
    nyusen: numOrNull(r.nyusen),
    dochakuCd: strOrNull(r.dochaku_cd),
    dochakuTosu: numOrNull(r.dochaku_tosu),
    ijyo: strOrNull(r.ijyo),
    corner: strOrNull(r.corner),
    haron3: numOrNull(r.haron3),
    ninki: numOrNull(r.ninki),
    chakusa: strOrNull(r.chakusa),
  };
}

/** 生のpaybackを GradeWinnerPayback に正規化する(欠損・非オブジェクトは null)。 */
function parsePayback(raw: unknown): GradeWinnerPayback | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const p = raw as Record<string, unknown>;
  return {
    fukuPay1: numOrNull(p.fuku_pay1),
    fukuNinki1: numOrNull(p.fuku_ninki1),
    fukuPay2: numOrNull(p.fuku_pay2),
    fukuNinki2: numOrNull(p.fuku_ninki2),
    fukuPay3: numOrNull(p.fuku_pay3),
    fukuNinki3: numOrNull(p.fuku_ninki3),
  };
}

/** 生の1回分エントリを GradeWinnerEntry に正規化する。 */
function parseEntry(raw: unknown): GradeWinnerEntry {
  const e = (raw ?? {}) as Record<string, unknown>;
  const resultRaw = Array.isArray(e.result) ? e.result : [];
  return {
    raceId: strOrNull(e.race_id),
    raceDate: strOrNull(e.race_date),
    jyo: strOrNull(e.jyo),
    nkai: numOrNull(e.nkai),
    kyori: numOrNull(e.kyori),
    track: strOrNull(e.track),
    fence: strOrNull(e.coursekubun_cd),
    baba: strOrNull(e.baba),
    tenko: strOrNull(e.tenko),
    tosu: numOrNull(e.tosu),
    haronL3: numOrNull(e.haron_l3),
    haronS3: numOrNull(e.haron_s3),
    result: resultRaw.map(parseResultHorse),
    payback: parsePayback(e.payback),
  };
}

/**
 * data オブジェクトから、ハッシュ付きキー("_last_dt" で終わらないキー)の値(base64文字列)を取り出す。
 * キー名をハードコードしないための実装(recon合意事項)。
 */
function findEncodedPayload(data: Record<string, unknown>): string {
  const key = Object.keys(data).find((k) => !k.endsWith("_last_dt"));
  if (key === undefined) {
    throw new GradeWinnerParseError(
      "同レース過去10年結果APIの応答からデータキー(_last_dtで終わらないキー)を特定できません",
    );
  }
  const value = data[key];
  if (typeof value !== "string") {
    throw new GradeWinnerParseError(
      "同レース過去10年結果APIの応答データがbase64文字列ではありません",
    );
  }
  return value;
}

/**
 * 過去10年結果APIの生レスポンス文字列をパースする。
 *
 * @param raw HTTPレスポンスの本文(JSON文字列)
 * @returns status==="OK" のとき復号済みの過去回配列(長さは10とは限らない。新設・改称の
 *   レースは10件未満のことがある)。status!=="OK"(非重賞・対象データなし)は null(呼び出し側は
 *   これを異常とみなさず静かにスキップすること)。
 * @throws GradeWinnerParseError JSON解析失敗・data欠損・base64/zlib復号失敗など、
 *   status==="OK"であるにもかかわらず構造が壊れている場合
 */
export function parseGradeWinnerResponse(
  raw: string,
): readonly GradeWinnerEntry[] | null {
  let response: RawApiResponse;
  try {
    response = JSON.parse(raw) as RawApiResponse;
  } catch (error) {
    throw new GradeWinnerParseError(
      `同レース過去10年結果APIの応答がJSONとして解析できません: ${String(error)}`,
    );
  }

  if (response.status !== "OK") {
    // 非重賞・対象データなし。HTTPステータスは200のまま status:"NG" で返る仕様
    // (呼び出し側は静かにスキップし、エラー扱いにしないこと)。
    return null;
  }

  if (typeof response.data !== "object" || response.data === null) {
    throw new GradeWinnerParseError(
      "同レース過去10年結果APIの応答にdataがありません(status:OKなのに構造が不正)",
    );
  }

  const encoded = findEncodedPayload(response.data as Record<string, unknown>);

  let decodedText: string;
  try {
    decodedText = inflateSync(Buffer.from(encoded, "base64")).toString("utf-8");
  } catch (error) {
    throw new GradeWinnerParseError(
      `同レース過去10年結果APIの応答の復号(base64/zlib)に失敗しました: ${String(error)}`,
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(decodedText);
  } catch (error) {
    throw new GradeWinnerParseError(
      `復号後データのJSON解析に失敗しました: ${String(error)}`,
    );
  }

  if (!Array.isArray(decoded)) {
    throw new GradeWinnerParseError("復号後データが配列ではありません");
  }

  return decoded.map(parseEntry);
}
