/**
 * 実験の選択(Issue #160〈#21-B〉)。環境変数 `SPIKE_EXPERIMENTS` の解釈。
 *
 *  - `origin`: E0〜E3(400 の原因の切り分け。netkeiba へ 6 本。このほかに netkeiba へ出ないエコーが数本)
 *  - `reachability`: #159 第2ラウンドの到達性(5対象 × Worker・ランナー = 10 本)
 *  - `socket-matrix`: #162 段階1。DO の中からのソケットで、取得先の網羅・gzip・再現性を測る(netkeiba へ 9 本。
 *    このほかに netkeiba へ出ない、Worker から DO を繰り返し呼ぶ試験がある)
 *  - `cpu`: CPU 上限の探索(netkeiba へは出ない)
 *
 * **フェイルクローズ**: 未設定・空・未知のトークンはエラーにする(誤って全実験を走らせない)。
 * netkeiba へ出る実験(reachability・origin・socket-matrix)は、**どの2つも同時には選べない**
 * (1回の実行の netkeiba への合計 10 本以内の守りを、選択の段階で固定する。本数は
 * {@link NETKEIBA_REQUESTS_BY_EXPERIMENT}。どの2つの和も 10 を超える)。
 */

export type Experiment = "reachability" | "origin" | "socket-matrix" | "cpu";

/** 実行の正規の順(netkeiba に出る実験を先に、CPU の探索は最後)。 */
const CANONICAL_ORDER: readonly Experiment[] = ["reachability", "origin", "socket-matrix", "cpu"];

/** netkeiba へ出る実験の、計画の本数(エコーなど netkeiba へ出ないものは含めない)。 */
export const NETKEIBA_REQUESTS_BY_EXPERIMENT: Readonly<Partial<Record<Experiment, number>>> = {
  reachability: 10,
  origin: 6,
  "socket-matrix": 9,
};

export type ParseExperimentsResult =
  | { readonly ok: true; readonly experiments: readonly Experiment[] }
  | { readonly ok: false; readonly error: string };

export function parseExperiments(value: string | undefined): ParseExperimentsResult {
  if (value === undefined || value.trim() === "") {
    return {
      ok: false,
      error: "SPIKE_EXPERIMENTS が未設定、または空です(origin / reachability / socket-matrix / cpu をカンマ区切りで指定してください)",
    };
  }
  const tokens = value.split(",").map((t) => t.trim());
  const selected = new Set<Experiment>();
  for (const token of tokens) {
    if (token === "") {
      return { ok: false, error: `SPIKE_EXPERIMENTS に空の要素があります: ${JSON.stringify(value)}` };
    }
    if (!(CANONICAL_ORDER as readonly string[]).includes(token)) {
      return {
        ok: false,
        error: `SPIKE_EXPERIMENTS に未知の実験があります: ${JSON.stringify(token)}(origin / reachability / socket-matrix / cpu のいずれか)`,
      };
    }
    selected.add(token as Experiment);
  }
  const netkeibaSelected = CANONICAL_ORDER.filter((e) => selected.has(e) && NETKEIBA_REQUESTS_BY_EXPERIMENT[e] !== undefined);
  if (netkeibaSelected.length > 1) {
    const total = netkeibaSelected.reduce((sum, e) => sum + (NETKEIBA_REQUESTS_BY_EXPERIMENT[e] ?? 0), 0);
    return {
      ok: false,
      error:
        `${netkeibaSelected.map((e) => `${e}(${NETKEIBA_REQUESTS_BY_EXPERIMENT[e]} 本)`).join(" と ")} は同時に選べません: ` +
        `netkeiba への合計が ${total} 本になり、1回の実行の上限 10 本を超えます`,
    };
  }
  return { ok: true, experiments: CANONICAL_ORDER.filter((e) => selected.has(e)) };
}
