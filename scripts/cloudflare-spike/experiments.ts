/**
 * 実験の選択(Issue #160〈#21-B〉)。環境変数 `SPIKE_EXPERIMENTS` の解釈。
 *
 *  - `origin`: E0〜E3(400 の原因の切り分け。netkeiba へ 6 本。このほかに netkeiba へ出ないエコーが数本)
 *  - `reachability`: #159 第2ラウンドの到達性(5対象 × Worker・ランナー = 10 本)
 *  - `cpu`: CPU 上限の探索(netkeiba へは出ない)
 *
 * **フェイルクローズ**: 未設定・空・未知のトークンはエラーにする(誤って全実験を走らせない)。
 * `reachability` は 10 本ちょうどを使うので、`origin` と同時には選べない
 * (1回の実行の netkeiba への合計 10 本以内の守りを、選択の段階で固定する)。
 */

export type Experiment = "reachability" | "origin" | "cpu";

/** 実行の正規の順(netkeiba に出る実験を先に、CPU の探索は最後)。 */
const CANONICAL_ORDER: readonly Experiment[] = ["reachability", "origin", "cpu"];

export type ParseExperimentsResult =
  | { readonly ok: true; readonly experiments: readonly Experiment[] }
  | { readonly ok: false; readonly error: string };

export function parseExperiments(value: string | undefined): ParseExperimentsResult {
  if (value === undefined || value.trim() === "") {
    return {
      ok: false,
      error: "SPIKE_EXPERIMENTS が未設定、または空です(origin / reachability / cpu をカンマ区切りで指定してください)",
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
        error: `SPIKE_EXPERIMENTS に未知の実験があります: ${JSON.stringify(token)}(origin / reachability / cpu のいずれか)`,
      };
    }
    selected.add(token as Experiment);
  }
  if (selected.has("reachability") && selected.has("origin")) {
    return {
      ok: false,
      error:
        "reachability(netkeiba へ 10 本)と origin(6 本)は同時に選べません: 1回の実行の netkeiba への合計は 10 本以内です",
    };
  }
  return { ok: true, experiments: CANONICAL_ORDER.filter((e) => selected.has(e)) };
}
