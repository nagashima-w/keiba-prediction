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

// --- src を読むテスト(Issue #717) ---
// #680 で `cloud/src/race-day-do.ts` の配線を変えたところ、それを readFileSync で読む bundle-guard が CI で落ちた
// (src の変更は import のつながりに現れるが、文字列で読むテストは `vitest list --changed` に選ばれない)。
// 選び方は (B): src(cloud と core)のどれかが変わったら、ソースを読む 5 本を全部足す(単独の実測で合計約 79 秒。並列ならそれ未満)。
// ファイル単位の対応表(A)にしないのは、bundle-guard が src の約 15 ファイルを読んで全体をバンドルし、
// result-backfill-state が src の全体を走査するため、対応表が新しいファイルの追加で古くなるから。
// 限界: 一覧の検査(verify-related-integration.test.ts)は文字列の検索なので、src を別名の関数や変数だけを経由して読むテストは拾えない
// (#701 と同じ)。`cloud/client/` はトリガーに含めない。生成物 `cloud/src/client-bundle.generated.ts` は src の中なので含まれる。

/** トリガー: cloud/src と packages/core/src の .ts。 */
export function isSourceFile(file) {
  return /^(cloud|packages\/core)\/src\/.+\.ts$/.test(file);
}

/** cloud/src・packages/core/src のソースを本文として読む、またはバンドルの入口に文字列で書くインテグレーションのテスト。 */
export const SOURCE_READERS = [
  "test/bundle-guard.integration.test.ts",
  "test/race-day-jockey-names.integration.test.ts",
  "test/race-day-trainer-names.integration.test.ts",
  "test/result-backfill-state.integration.test.ts",
  "test/result-repository-bundle.integration.test.ts",
];

/** changedAll(削除も含む、絞る前の差分)にトリガーがあれば一覧(設定側と src 側の和集合、重複なし)、無ければ空。 */
export function pickExtraTargets(changedAll) {
  const out = [];
  if (changedAll.some(isTriggerFile)) out.push(...ALWAYS_RELATED);
  if (changedAll.some(isSourceFile)) out.push(...SOURCE_READERS);
  return [...new Set(out)];
}

/** import で選ばれたもの・変えたテスト自身・トリガーで足すものを合わせ、インテグレーションのテストだけを重複なく並べる。 */
export function buildTargets({ affected, direct, changedAll }) {
  const all = [...affected, ...direct, ...pickExtraTargets(changedAll)];
  return [...new Set(all)].filter((f) => f.endsWith(".integration.test.ts")).sort();
}
