/**
 * nar-trifecta-axis — 地方(NAR)三連単の軸馬別取得(Issue #283)で叩くべき軸馬番の集合を導出する葉モジュール。
 *
 * ## 契約
 * 地方三連単の軸(`jiku=k`)は「1着を k に固定した全順列」を返す(3連複の「k を含む」とは違う。
 * `docs/trifecta-odds-investigation.md` §3.2)。どの馬番も1着になりうるため、全組合せ
 * n×P(n-1,2)=P(n,3) を得るには**出走馬番の全数(n本)**を叩く必要がある(§3.3。
 * 3連複の `deriveNarTrioAxisUmabans` は n-2 本で足りるが、三連単では足りない)。
 *
 * 軸は「出走している馬番」でなければならない。取消等で馬番が飛ぶ(非連番の)場合に
 * 「1..n」をリテラルに作ると、存在しない馬番を軸に指定してしまう
 * (`deriveNarTrioAxisUmabans` と同じ理由)。
 */

/**
 * 出走馬番の集合(順不同・重複ありうる)から、地方三連単の軸馬別取得で叩くべき軸馬番の
 * 配列を導出する。
 *
 * 契約: 重複を排除し昇順に整列して返す。重複排除後の頭数が3未満なら(三連単の組合せ自体が
 * 成立しないため)軸0件(空配列)を返す。
 *
 * @param startingUmabans 出走馬番の集合(順不同・重複ありうる)
 * @returns 軸馬番の配列(昇順。n<3のときは空配列)
 */
export function deriveNarTrifectaAxisUmabans(startingUmabans: readonly number[]): number[] {
  const uniqueSorted = [...new Set(startingUmabans)].sort((a, b) => a - b);
  return uniqueSorted.length < 3 ? [] : uniqueSorted;
}
