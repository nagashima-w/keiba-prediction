/**
 * smoke の E(workerd の runAnalysis の出力 = exe 側の golden)の、許容つき比較(Issue #258)。
 *
 * ## なぜ SHA-256 の完全一致をやめたか
 * `Math.log`・`Math.exp`(と、指数が整数 3 以上の `**`)は、Node(V8 12.4)と workerd で、同じ引数に最後の 1 ビットだけ違う結果を返すことがある。
 * Node 22 と workerd で、`Math.log`・`Math.exp` の結果が最後の 1 ビット違う引数がある(Issue #275 の本文に、当時の実測。食い違いの標本ではすべて workerd の方が正しい丸めだった)。
 * 同じ引数・同じ加算の順序でも、この差だけで出力の SHA-256 は変わる(Node の `Math.log`・`Math.exp` を workerd の結果の表に差し替えるだけで、
 * Node の出力の SHA-256 が workerd のものとビット単位で一致した)。利用者に見える差ではない(実測の最大の相対誤差 2.4e-15)。
 *
 * ## 比較の規則
 * - 数値: 両方とも**整数値**(`Number.isInteger`)なら完全一致(配分額・馬番・件数など)。そうでなければ、同じ値か、
 *   `|a − b| ≤ {@link FLOAT_RELATIVE_TOLERANCE} × max(|a|, |b|)`(相対誤差)なら一致とみなす。絶対誤差の下駄は付けない
 *   (0 と極小の値の食い違いが将来出たら、赤として気づけるようにするため)。
 * - 文字列・真偽・null: 完全一致。型の違い(数値と文字列・null と数値など)は不一致。
 * - オブジェクト: 項目の集合も**順序**も完全一致。配列: 長さが完全一致で、要素ごとに再帰して比べる。
 *
 * 検出力: 許容 1e-12 より大きいずれ(例: 1 頭の prior が 1e-6 ずれる)は赤になる。見逃すのは相対 1e-12 以下の差だけである。
 */

/** 浮動小数点の値の相対誤差の許容。実測の最大(2.4e-15)の約 400 倍。 */
export const FLOAT_RELATIVE_TOLERANCE = 1e-12;

/** 報告する不一致の行数の上限(件数は {@link CompareResult.mismatchCount} に全数が入る)。 */
const MAX_REPORTED_MISMATCHES = 20;

export interface CompareResult {
  /** 不一致が 0 件か。 */
  readonly ok: boolean;
  /** 不一致の説明(経路・期待値・実測値)。上限 {@link MAX_REPORTED_MISMATCHES} 行。 */
  readonly mismatches: readonly string[];
  /** 不一致の全件数(`mismatches` は上限で切るため、これが全数)。 */
  readonly mismatchCount: number;
  /** 許容内の差があった(完全には一致しなかったが一致とみなした)浮動小数点の値の件数。 */
  readonly floatDiffCount: number;
  /** 許容内の差のうち、最大の相対誤差(差が無ければ 0)。 */
  readonly maxRelativeError: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  const text = JSON.stringify(value);
  const shown = text === undefined ? String(value) : text;
  return shown.length > 80 ? `${shown.slice(0, 80)}…` : shown;
}

/**
 * actual を expected と、浮動小数点だけ許容つきで比べる(規則はファイル先頭)。
 * 経路の表記は `$.result.rows[14].prior` の形(ルートは `$`)。
 */
export function compareWithFloatTolerance(actual: unknown, expected: unknown): CompareResult {
  const mismatches: string[] = [];
  let mismatchCount = 0;
  let floatDiffCount = 0;
  let maxRelativeError = 0;

  const fail = (path: string, detail: string): void => {
    mismatchCount += 1;
    if (mismatches.length < MAX_REPORTED_MISMATCHES) {
      mismatches.push(`${path}: ${detail}`);
    }
  };

  const walk = (a: unknown, e: unknown, path: string): void => {
    if (typeof a === "number" && typeof e === "number") {
      if (Object.is(a, e) || a === e) {
        return;
      }
      if (Number.isFinite(a) && Number.isFinite(e) && !(Number.isInteger(a) && Number.isInteger(e))) {
        const relative = Math.abs(a - e) / Math.max(Math.abs(a), Math.abs(e));
        if (relative <= FLOAT_RELATIVE_TOLERANCE) {
          floatDiffCount += 1;
          maxRelativeError = Math.max(maxRelativeError, relative);
          return;
        }
        fail(path, `数値が許容(相対 ${FLOAT_RELATIVE_TOLERANCE})を超えて違う(期待 ${e} / 実測 ${a} / 相対誤差 ${relative})`);
        return;
      }
      fail(path, `数値が違う(期待 ${e} / 実測 ${a}。整数値どうし・非有限値は完全一致)`);
      return;
    }
    if (Array.isArray(a) || Array.isArray(e)) {
      if (!Array.isArray(a) || !Array.isArray(e)) {
        fail(path, `配列とそれ以外の取り違え(期待 ${describeValue(e)} / 実測 ${describeValue(a)})`);
        return;
      }
      if (a.length !== e.length) {
        fail(path, `配列の長さが違う(期待 ${e.length} / 実測 ${a.length})`);
        return;
      }
      for (let i = 0; i < e.length; i += 1) {
        walk(a[i], e[i], `${path}[${i}]`);
      }
      return;
    }
    if (isPlainObject(a) && isPlainObject(e)) {
      const aKeys = Object.keys(a);
      const eKeys = Object.keys(e);
      const missing = eKeys.filter((k) => !(k in a));
      const extra = aKeys.filter((k) => !(k in e));
      if (missing.length > 0 || extra.length > 0) {
        fail(path, `項目の集合が違う(欠けている: ${missing.join(",") || "なし"} / 余分: ${extra.join(",") || "なし"})`);
        return;
      }
      if (aKeys.some((k, i) => k !== eKeys[i])) {
        fail(path, `項目の順序が違う(期待 ${eKeys.join(",")} / 実測 ${aKeys.join(",")})`);
        return;
      }
      for (const key of eKeys) {
        walk(a[key], e[key], `${path}.${key}`);
      }
      return;
    }
    if (a !== e) {
      fail(path, `値が違う(期待 ${describeValue(e)} / 実測 ${describeValue(a)})`);
    }
  };

  walk(actual, expected, "$");
  return { ok: mismatchCount === 0, mismatches, mismatchCount, floatDiffCount, maxRelativeError };
}
