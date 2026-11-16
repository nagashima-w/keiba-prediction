/**
 * Issue #762: スモーク(smoke.ts)の「流す設定の組を選ぶ」引数の解釈。
 *
 * `--only=A,B,...` で設定の ID を選ぶ。引数なしは、知っている設定の全部(今までと同じ)。
 * 不明な設定・空の指定・知らない引数は例外にする(何も流さないまま成功する事故を避ける)。
 * CI(deploy-cloud.yml の smoke ジョブ)は、設定を 3 つの組に分け、matrix で並行に流す。
 * 組が全設定をちょうど 1 回ずつ覆うことは、scripts/test/cloud-deploy-workflow.test.ts が固定している。
 */
export function parseSmokeSelection(argv: readonly string[], known: readonly string[]): ReadonlySet<string> {
  let only: string | null = null;
  for (const arg of argv) {
    if (arg === "--") continue;
    if (arg.startsWith("--only=")) {
      if (only !== null) throw new Error("--only は 1 回だけ指定できます");
      only = arg.slice("--only=".length);
      continue;
    }
    throw new Error(`知らない引数です: ${arg}(使えるのは --only=A,B,...)`);
  }
  if (only === null) return new Set(known);
  const ids = only
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (ids.length === 0) throw new Error("--only に設定の ID がありません");
  const unknown = ids.filter((id) => !known.includes(id));
  if (unknown.length > 0) throw new Error(`知らない設定です: ${unknown.join(",")}(あるのは ${known.join(",")})`);
  return new Set(ids);
}
