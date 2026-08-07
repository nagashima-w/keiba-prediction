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
 * ## 性能への影響(boss差し戻し・2026-08-07で再現手段を追加)
 *
 * 再現コマンド: `pnpm tsx scripts/bench-combo-odds-key.ts`(`scripts/bench-allocation.ts`
 * 〈#14〉と同じ流儀。決定的な入力・CIから呼ばない)。入力はC(18,3)=816組(頭数の上限
 * `MAX_UMABAN`=18と3連複のcomboSize=3から決まる、この関数が現実に受け取りうる最大規模)。
 * 実測(本ファイル筆者、2026-08-07、3回実行。壁時計計測のため実行毎にばらつくが、
 * 差の大きさの目安として3回とも記載する): 平均の差は+7.8%(0.0352ms)・+7.8%(0.0310ms)・
 * +5.8%(0.0229ms)で、いずれも**絶対値は1ミリ秒未満**。816組の全体処理時間が1ms未満である
 * 以上、この程度の相対差は呼び出し元(`parse-combo-odds.ts`・`parse-nar-combo-odds.ts`)が
 * 1レースあたり最大でも数回しか呼ばない現状の使われ方において実務上の影響は無いと判断する。
 *
 * 加えて構造的な根拠(数値ではなく入力の有界性に基づく議論): `validateComboUmabanRange`が
 * 行うのは「配列を1回走査し、各要素にNumber.isIntegerと2つの比較を行うだけ」であり、
 * 入力サイズが指数的・無制限に増える経路ではない(馬番は1〜18、組の要素数は2または3で
 * 固定、組合せ総数はC(18,3)=816が構造的な上限)。したがって将来呼び出し回数が増えても
 * (例: #33で地方3連複の軸馬別走査が入り1レースで最大16回パースする場合でも)、
 * 1回あたりのコストがO(816)の線形走査のまま変わらないため、性能懸念として扱う必要はない。
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

/**
 * 軸番号付きのオッズセルMap(地方3連複の軸馬別取得〈機能D-2b-B・Issue #33第3段〉が
 * `narTrioOddsAxisUrl`ごとに得る1軸分の結果)。
 */
export interface AxisComboOddsMap {
  /** 軸馬番(`narTrioOddsAxisUrl`のjikuに対応)。 */
  readonly axis: number;
  /** その軸から得たオッズセルMap(`parseNarComboOdds`の`available`結果)。 */
  readonly odds: ReadonlyMap<string, ComboOddsCell>;
}

/** 軸間の同一キー衝突1件(衝突に関与した全軸のセルを軸昇順で保持する)。 */
export interface ComboOddsCellConflictEntry {
  readonly axis: number;
  readonly cell: ComboOddsCell;
}

/**
 * 軸間衝突の種別。
 * - "numeric": 数値同士が食い違った(いずれの軸のoddsMinもnullではない)
 * - "nullWin": 片方以上がnull(未確定/取消の可能性)で、null側が採用された
 *
 * **限定(boss メタレビュー・提案1採用)**: この`kind`は**`oddsMin`の異同のみ**を表す
 * (Q1裁定「比較キーはoddsMin」に対応する分類であり、`oddsMax`/`ninki`は判定に関与しない)。
 * `oddsMin`が同値で`oddsMax`/`ninki`だけが相違する場合も`"numeric"`に分類される
 * (`hasNull`/`hasNumeric`は`oddsMin`だけを見て決まるため。実際の勝者選択自体はQ1裁定の
 * 規則4〈フィールドを混ぜない。勝った側のセルを丸ごと採用〉に従っており矛盾はない。
 * 誤りはラベルの精度のみ)。
 *
 * **現時点(2026-08-07)では到達不能**: 本関数の唯一の呼び出し元(地方3連複の軸走査。
 * `fetch-combo-odds.ts`)が扱うセルは`parse-nar-combo-odds.ts`のtrio分岐が生成するため、
 * `oddsMax`は常に`null`・`ninki`も常に`null`固定(実装上の不変)。したがって`oddsMin`以外の
 * フィールドだけが軸間で相違するケースは、現在のコードパスでは発生しない。
 *
 * **いつ顕在化するか**: `oddsMax`/`ninki`が意味を持つ券種(ワイド等)を軸走査に載せた瞬間
 * (券種拡張シリーズの#24〈馬連・馬単〉以降で、軸走査が必要な券種が増えた場合)。その時点で
 * `oddsMax`/`ninki`単独の相違を独立に分類する必要が生じたら、本関数(勝者選択ロジック自体)
 * ではなく、この`kind`分類の見直しを検討すること。
 */
export type ComboOddsCellConflictKind = "numeric" | "nullWin";

/** 軸間の同一キー衝突。 */
export interface ComboOddsCellConflict {
  readonly key: string;
  readonly kind: ComboOddsCellConflictKind;
  /** 衝突に関与した全軸のセル(軸番号昇順)。 */
  readonly entries: readonly ComboOddsCellConflictEntry[];
}

/** `mergeAxisComboOddsMaps` の戻り値。 */
export interface MergeAxisComboOddsResult {
  readonly odds: Map<string, ComboOddsCell>;
  readonly conflicts: ComboOddsCellConflict[];
}

/**
 * 保守側(oddsMinが小さい方。nullは任意の数値より保守的)のセルを丸ごと採用する2値比較。
 * 同値(oddsMinが等しい)場合は`a`を返す(呼び出し元が軸番号昇順に整列した配列を畳み込むため、
 * 結果は常に「軸番号が最も小さいエントリ」に決定的に収束する。入力`maps`配列自体の順序には
 * 依存しない)。
 */
function pickConservativeEntry(
  a: ComboOddsCellConflictEntry,
  b: ComboOddsCellConflictEntry,
): ComboOddsCellConflictEntry {
  const am = a.cell.oddsMin;
  const bm = b.cell.oddsMin;
  if (am === bm) return a;
  if (am === null) return a;
  if (bm === null) return b;
  return am <= bm ? a : b;
}

/**
 * 複数の軸から得たオッズセルMapを、キー(組合せ)単位でマージする(機能D-2b-B・Issue #33
 * 第3段・AC-1〜AC-3。boss裁定2026-08-07 Q1)。
 *
 * ## 衝突解決規則(Q1裁定。6項目)
 *
 * 1. 比較キーは `oddsMin`(`toComboOddsScalarMap` がEVに流す唯一の値)
 * 2. `null` は任意の数値より保守的(`null` < 任意の数値)。片方が `null` ならnull側のセルを採る
 * 3. 数値同士は**小さい方**のセルを採る
 * 4. **フィールドを混ぜない**。勝った側のセルを `oddsMin`/`oddsMax`/`ninki` ごと丸ごと採用する
 *    (どのスナップショットにも存在しなかった合成セルを作らない)
 * 5. 完全同値(`cellsEqual`)は衝突として計上しない(冪等)
 * 6. 衝突はthrowしない。呼び出し元(`fetch-combo-odds.ts`)が診断値に件数・サンプルを残す
 *
 * ## throwしない理由(#14 `resolveComboOdds` との対比)
 *
 * `buildComboOddsCellMap` の「同じ組に異なる値が複数回現れたらthrow」は**1つの文書は自己整合で
 * あるべき**という不変条件であり、別々の時刻の別々のHTTP応答をまたぐ軸間マージはその不変条件の
 * 外側にある。#14の`resolveComboOdds`が下した判断(「1組の異常値のために残りの健全な分類結果を
 * 失うのは誤り」)と同型で、軸間衝突はさらに規模が悪い(1組の0.1の差でC(18,3)=816組すべてが
 * 消える)。
 *
 * ## 「先勝ち/後勝ち」を採らない理由
 *
 * 呼び出し元の `RaceFetcher.fetchText` は `Promise<string>` しか返さず取得時刻もキャッシュ年齢も
 * 返さない。加えてオッズのキャッシュTTL(既定60秒)の内側に軸走査全体(**上限**は`MAX_UMABAN`-2=
 * 最大16軸×1.5秒≒最大約24秒〈**導出値**〉。16頭なら14軸≒21秒だが、これは上限ではなく一例)が
 * 収まりうるため、「ループ後半の軸の方が新しいスナップショットである」とは限らない。先勝ち/後勝ちは
 * 走査順という実装詳細に結果を依存させてしまうため、順序非依存な最小値採用を選んだ。
 *
 * ## 軸間衝突は2026-08-07時点で実物では未観測(AC-9)
 *
 * `nar_odds_b7_jiku1_202654071210.html`(2026-08-07取得)と`nar_odds_b7_jiku2_202654071210.html`
 * (2026-08-05取得、約2.2日前)を突き合わせたところ、重なり(軸1・軸2の両方に現れるトリオ)10件は
 * 1件も値が食い違わなかった(`combo-odds-key.test.ts`「実フィクスチャ」describe参照)。**この
 * 一致を「軸間で値は動かない」ことの証拠にしてはならない**: 対象レースは既に終了しており確定
 * オッズが凍結されているため、そもそもこのフィクスチャでは衝突が原理的に再現できない(取得時刻が
 * 2.2日離れているのに完全一致した理由そのものが「確定済みだから」)。したがって本関数の衝突解決
 * ロジックのテストは合成データでのみ書ける(`combo-odds-key.test.ts`「衝突の解決規則」describe)。
 * 観測していない現象(発売中レースでの軸間衝突の実例)を「観測した」と誤読しないこと。
 *
 * @param maps 軸ごとのオッズセルMap(`odds`は成功した軸のみを渡すこと。失敗軸は呼び出し元で除外する)
 */
export function mergeAxisComboOddsMaps(
  maps: readonly AxisComboOddsMap[],
): MergeAxisComboOddsResult {
  const byKey = new Map<string, ComboOddsCellConflictEntry[]>();
  for (const { axis, odds } of maps) {
    for (const [key, cell] of odds) {
      const list = byKey.get(key);
      if (list) {
        list.push({ axis, cell });
      } else {
        byKey.set(key, [{ axis, cell }]);
      }
    }
  }

  const merged = new Map<string, ComboOddsCell>();
  const conflicts: ComboOddsCellConflict[] = [];

  for (const [key, rawEntries] of byKey) {
    // 軸番号昇順に整列してから畳み込む: 入力`maps`配列の並び順(呼び出し元がどの順でawaitしたか)
    // に結果が依存しないようにするための正規化(順序非依存。#33第3段AC-3)。
    const entries = [...rawEntries].sort((a, b) => a.axis - b.axis);
    const first = entries[0]!;
    const allEqual = entries.every((e) => cellsEqual(e.cell, first.cell));
    if (allEqual) {
      merged.set(key, first.cell);
      continue;
    }
    let winner = first;
    for (const entry of entries.slice(1)) {
      winner = pickConservativeEntry(winner, entry);
    }
    merged.set(key, winner.cell);
    const hasNull = entries.some((e) => e.cell.oddsMin === null);
    const hasNumeric = entries.some((e) => e.cell.oddsMin !== null);
    conflicts.push({
      key,
      kind: hasNull && hasNumeric ? "nullWin" : "numeric",
      entries,
    });
  }

  return { odds: merged, conflicts };
}
