/**
 * combo-odds-key — ワイド・三連複など「馬の組」で識別する券種のオッズキー生成と、
 * 正規化キーを介した値のMap化を担う葉モジュール(機能D-2b-A・Issue #32)。
 *
 * ## 依存の向き(boss着手前ゲート2026-08-06で確定)
 *
 * `buildComboOddsKey` はもともと `ev/combo-bet-allocation.ts`(機能D-2a・#14)に実体があった。
 * ワイド・3連複の組合せオッズパーサ(`scraper/parse-combo-odds.ts`・`scraper/parse-nar-combo-odds.ts`)
 * からも同じキー形式を使う必要が生じたが、`scraper/*` から `ev/combo-bet-allocation.ts` を
 * import すると **scraper → ev という逆向きの層依存**が生まれてしまう。
 *
 * 本リポジトリの既存の依存方向は「`scraper` は依存を持たない葉、`ev` が `scraper` に依存する」
 * (実測: `grep -rn 'from "../ev/' packages/core/src/scraper/` は0件。逆に
 * `ev/verify.ts` は `scraper/ids.js` を実行時importしている=ev→scraperの実行時エッジは既存。
 * `scraper/ids.ts` はimport文0件の葉モジュール)。したがって実体は本モジュール
 * (`scraper/` 配下の葉)に置き、`ev/combo-bet-allocation.ts` はここから re-export するだけにする
 * (案(a)採用。既存 `combo-bet-allocation.test.ts` が `../../src/ev/combo-bet-allocation.js` から
 * `buildComboOddsKey` を import しているため、re-exportで公開の見え方を変えない)。
 *
 * **実装は1つだけ。** `padStart(2,"0")` の連結ロジックを2箇所に複製しない。
 */

/** 馬番の上限(1〜18)。parse-odds.ts / parse-nar-odds.ts の MAX_UMABAN と同じ基準。 */
const MAX_UMABAN = 18;

/** 券種(ワイド・3連複)。買い目を構成する頭数(comboSize)が一意に決まる。 */
export type ComboBetType = "wide" | "trio";

/** 券種ごとの買い目構成頭数(ワイド=2、3連複=3)。中央・地方の両パーサが共有する。 */
export const COMBO_SIZE: Record<ComboBetType, number> = {
  wide: 2,
  trio: 3,
};

/**
 * 組合せオッズキー生成の唯一の正規化関数(#14からの移設。仕様・挙動は不変)。
 * netkeibaの実キー形式(ワイド"0102"・3連複"010203")に一致させる: 馬番昇順ソート後、
 * 2桁ゼロ埋めで連結する。呼び出し側にキー文字列を組み立てさせない。
 *
 * 注意: この関数自体は入力を**ソートして受理する**(昇順違反を拒否しない)。ソース側の
 * 並びが想定外(昇順違反)であることを検出したい場合は `validateComboUmabans` を別途使うこと
 * (この関数だけに頼ると、ソース側の異常を黙って「直して」しまう)。
 */
export function buildComboOddsKey(umabans: readonly number[]): string {
  return [...umabans]
    .sort((a, b) => a - b)
    .map((u) => String(u).padStart(2, "0"))
    .join("");
}

/**
 * 組合せオッズ1件の値(下限・上限・人気)。
 *
 * **注意: 3連複では `oddsMin` は「下限」ではなく単一値そのものを表す**(フィールド名だけを見て
 * 「下限」と誤読しないこと)。3連複はオッズが単一値で確定する券種であり、`oddsMax` は常に
 * `null` になる(中央JSON応答の2要素目"0.0"はダミーであり上限として採用しない)。
 * ワイドはレンジ(下限-上限)を持つ券種のため、`oddsMin`/`oddsMax` とも意味のある値を持つ。
 */
export interface ComboOddsCell {
  /** ワイド: オッズ下限。3連複: オッズ(単一値。「下限」ではない)。未確定・非数値は null。 */
  readonly oddsMin: number | null;
  /** ワイド: オッズ上限。3連複: 常に null(幅を持たない券種であることを型で表現)。 */
  readonly oddsMax: number | null;
  /** 人気。取得できない場合は null。 */
  readonly ninki: number | null;
}

/** 組合せ(馬番の組)とその値のペア。パーサがMap化する前の中間表現。 */
export interface ComboOddsEntry {
  /** 買い目を構成する馬番(順不同で良い。buildComboOddsCellMap内部でキー化時に正規化する)。 */
  readonly umabans: readonly number[];
  readonly cell: ComboOddsCell;
}

/** 組合せオッズの構造異常(馬番範囲外・重複組の値不一致等)を表す例外。 */
export class ComboOddsKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComboOddsKeyError";
  }
}

/**
 * 各馬番の値そのものを検証する(1〜18の整数範囲であること。**順序・重複・要素数は
 * 問わない**)。`validateComboUmabans`(公開API。長さ・昇順検証込み)と
 * `buildComboOddsCellMap`(自己防御。要素数・順序を知らない/問わない汎用Map化関数)の
 * 両方から共有される内部ヘルパー(受け入れ条件18・code-reviewer指摘4対応)。
 *
 * `Number.isInteger`でNaN/Infinity/小数を弾く(`u < 1 || u > MAX_UMABAN`だけだと
 * NaNとの比較は常にfalseになり素通りするため、整数性チェックを先に置く必要がある)。
 * `buildComboOddsKey([NaN,5])`が`"NaN05"`、`buildComboOddsKey([Infinity,5])`が
 * `"05Infinity"`、`buildComboOddsKey([1.5,2])`が`"1.502"`という**キー文字列そのものが
 * 破損する**実測(code-reviewer指摘4)を踏まえ、この破損パターンをここで止める。
 *
 * 昇順・重複の検証はここに含めない: `buildComboOddsCellMap`は`buildComboOddsKey`
 * (入力を自動でソートする)を介してキー化するため、入力順序が[1,2]でも[2,1]でも
 * 同じ組として正しく扱える(この性質自体がMap化関数の望ましい振る舞いであり、
 * `combo-odds-key.test.ts`「同じ組が複数回現れても値が完全一致すれば1件として
 * 受理すること」で固定済み)。昇順違反(例: 生キー"0201"のようなソース側の並びの
 * 想定外)を検出したい場面は`validateComboUmabans`を使うこと(生データの構造検証は
 * パーサ層〈`parse-combo-odds.ts`/`parse-nar-combo-odds.ts`〉の責務)。
 */
function validateComboUmabanRange(umabans: readonly number[]): void {
  for (const u of umabans) {
    if (!Number.isInteger(u) || u < 1 || u > MAX_UMABAN) {
      throw new ComboOddsKeyError(
        `馬番は1〜${MAX_UMABAN}の範囲である必要があります(umabans=${umabans.join(",")}, 不正な値=${u})`,
      );
    }
  }
}

/**
 * 馬番の組を検証する(構造の最低条件。throw側)。
 * - 要素数が comboSize と一致すること
 * - 各馬番が1〜18の範囲であること(`validateComboUmabanRange`)
 * - 厳密な昇順(重複なし)であること。`buildComboOddsKey` 自体は入力をソートして受理して
 *   しまうため、ソース側の並びが想定外(例: "0201"のような昇順違反)であることを検出するには
 *   この関数を別途呼ぶ必要がある
 */
export function validateComboUmabans(
  umabans: readonly number[],
  comboSize: number,
): void {
  if (umabans.length !== comboSize) {
    throw new ComboOddsKeyError(
      `組の要素数が券種と一致しません(期待: ${comboSize}, 実際: ${umabans.length}, umabans=${umabans.join(",")})`,
    );
  }
  validateComboUmabanRange(umabans);
  for (let i = 1; i < umabans.length; i++) {
    if (umabans[i]! <= umabans[i - 1]!) {
      throw new ComboOddsKeyError(
        `馬番の組は昇順・重複なしである必要があります(umabans=${umabans.join(",")})`,
      );
    }
  }
}

/** 2つのセル値が構造的に等しいか(重複組の許容判定に使う)。 */
function cellsEqual(a: ComboOddsCell, b: ComboOddsCell): boolean {
  return a.oddsMin === b.oddsMin && a.oddsMax === b.oddsMax && a.ninki === b.ninki;
}

/**
 * エントリ列を正規化キーでMap化する唯一の関数(受け入れ条件18)。**公開APIであり、
 * 呼び出し元が事前に検証済みであることを前提にしない**(code-reviewer指摘4対応)。
 * `ev/combo-bet-allocation.ts`の`validateCandidates`にも同種の教訓が残っている
 * (`AllocationCandidate.umabans`のJSDoc「`NaN<=NaN`は常にfalseなので昇順チェックだけでは
 * 素通りする」)。今回は「呼び出し元は既に検証済みだから関数自身は無防備でよい」という
 * 前提に依存せず、関数自身が防御する設計にした。
 *
 * 実測(本ファイル筆者、2026-08-07。C(18,3)=816組・500回試行の比較ベンチマーク):
 * 検証あり(現行実装)の中央値0.394ms・平均0.563ms・p95 0.686msに対し、検証なし
 * (修正前相当のローカル複製)は中央値0.388ms・平均0.557ms・p95 0.732ms。
 * 差は約1〜2%(0.005〜0.01ms)で測定ノイズの範囲に収まり、有意な性能劣化は無い
 * (呼び出し元が既に検証済みの既存2経路〈`parse-combo-odds.ts`・`parse-nar-combo-odds.ts`〉
 * での二重検証コストも同様に無視できる)。したがって「性能のため防御を省く」判断は
 * 不要と結論し、関数自身が常に防御する設計を採用した。
 *
 * 各エントリの `umabans` を `validateComboUmabanRange`(1〜18の整数範囲。NaN/Infinity/
 * 小数を弾く)で検証する(throw)。**要素数(comboSize)・昇順は検証しない**(この関数は
 * 券種非依存の汎用Map化関数であり期待する組の要素数を知らないこと、および
 * `buildComboOddsKey`自体が入力順序を自動で正規化する設計〈同じ組を順序違いでも1件に
 * 集約できる、というこの関数自身の望ましい性質〉と両立させるため)。要素数・昇順まで
 * 含めた構造検証が必要な場面(生データの構造検証)は呼び出し元が `validateComboUmabans`
 * を使うこと。
 *
 * 同じ組(正規化キーが同じ)が複数回登場した場合:
 * - 値(oddsMin/oddsMax/ninki)が完全一致するなら1件として受理する(冪等)
 * - 値が食い違う場合は**黙って後勝ちにせず**例外を投げる(取得元データの矛盾を握りつぶさない)
 */
export function buildComboOddsCellMap(
  entries: readonly ComboOddsEntry[],
): Map<string, ComboOddsCell> {
  const map = new Map<string, ComboOddsCell>();
  for (const { umabans, cell } of entries) {
    validateComboUmabanRange(umabans);
    const key = buildComboOddsKey(umabans);
    const existing = map.get(key);
    if (existing !== undefined) {
      if (!cellsEqual(existing, cell)) {
        throw new ComboOddsKeyError(
          `同じ組(${key})に異なる値が複数回現れました(黙って後勝ちにしない。` +
            `既存=${JSON.stringify(existing)}, 新規=${JSON.stringify(cell)})`,
        );
      }
      continue;
    }
    map.set(key, cell);
  }
  return map;
}

/**
 * 「ワイドは下限を採る」ルールを1箇所に閉じたMap化関数(受け入れ条件19)。
 *
 * `ev/combo-bet-allocation.ts` の `buildComboCandidates` が受け取る
 * `oddsByKey: ReadonlyMap<string, number | null>` と同じ形(キー→スカラー)にする。
 *
 * ワイドの下限採用は #14 `AllocationCandidate.odds` のJSDocに明記された契約
 * (「ワイドは最終配当が下限〜上限のレンジで確定する券種であり、下限を使うとEVを
 * 過小評価する方向に倒れるため、EVプラス判定・配分計算が楽観的にならない」保守的見積り)を
 * そのまま踏襲する。3連複は `oddsMax` が常に `null` で `oddsMin` が単一値そのものを表すため、
 * 「`oddsMin` を読む」という同じ規則でワイド・3連複を統一的に扱える(券種で分岐しない)。
 *
 * **呼び出し側が `.oddsMin` を直接読む形は禁止し、この関数を経由すること**
 * (下限採用ルールの実装箇所をここ1つに保つため)。
 */
export function toComboOddsScalarMap(
  cells: ReadonlyMap<string, ComboOddsCell>,
): Map<string, number | null> {
  const map = new Map<string, number | null>();
  for (const [key, cell] of cells) {
    map.set(key, cell.oddsMin);
  }
  return map;
}
