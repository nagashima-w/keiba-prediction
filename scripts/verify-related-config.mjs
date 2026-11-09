// 「関係するインテグレーション」(scripts/verify-related-integration.mjs)の選び方の補強(Issue #701)。
//
// `vitest list --changed` は import の依存しかたどらない。cloud/wrangler.toml・cloud/migrations/・cloud/smoke*.ts を
// import せず readFileSync・wrangler の実行で読むテストは、それらを変えても選ばれない(#698 で 3 本が漏れ、CI で初めて落ちた)。
// そこで、トリガーのファイルが差分にあるときは、下の固定の一覧を `vitest list` の結果に足す。
//
// 一覧に入れたもの: これらのファイルを**直接**読むテスト(10 本)。入れないもの: local-bindings.ts 経由で migration を当てるだけの
// 約 75 本(migration を変えると間接的には全部影響を受けるが、毎回流すと重いので CI に任せる)。
// 一覧が古くならないことは scripts/test/verify-related-integration.test.ts が検査する
// (cloud/test の *.integration.test.ts を検索し、読んでいるのに一覧に無いものを赤にする)。
// パスは cloud/ からの相対(vitest list の出力・verify-related-integration.mjs の `direct` と同じ形)。

/** トリガー: 差分にこれらがあれば ALWAYS_RELATED を足す。 */
export function isTriggerFile(file) {
  return (
    file === "cloud/wrangler.toml" ||
    file.startsWith("cloud/migrations/") ||
    /^cloud\/smoke[^/]*\.ts$/.test(file)
  );
}

/** 設定・migration・smoke を直接読むインテグレーションのテスト。 */
export const ALWAYS_RELATED = [
  "test/bundle-guard.integration.test.ts",
  "test/d1-schema.integration.test.ts",
  "test/local-bindings-template.integration.test.ts",
  "test/r2-binding.integration.test.ts",
  "test/race-archive-runs-index.integration.test.ts",
  "test/result-backfill-state.integration.test.ts",
  "test/result-repository-bundle.integration.test.ts",
  "test/targets-api.integration.test.ts",
  "test/targets-repository.integration.test.ts",
  "test/verify-pending-index.integration.test.ts",
];

/** changedAll(削除も含む、絞る前の差分)にトリガーがあれば一覧、無ければ空。 */
export function pickExtraTargets(changedAll) {
  return changedAll.some(isTriggerFile) ? [...ALWAYS_RELATED] : [];
}

/** import で選ばれたもの・変えたテスト自身・トリガーで足すものを合わせ、インテグレーションのテストだけを重複なく並べる。 */
export function buildTargets({ affected, direct, changedAll }) {
  const all = [...affected, ...direct, ...pickExtraTargets(changedAll)];
  return [...new Set(all)].filter((f) => f.endsWith(".integration.test.ts")).sort();
}
