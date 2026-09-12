import { existsSync } from "node:fs";
import path from "node:path";

/**
 * packaged実行時のbetter-sqlite3ネイティブバインディング(.node)の絶対パスを解決する(Issue #60-B)。
 *
 * 背景: bindings パッケージは呼び出し元のスタックトレースからモジュールルートを推測して .node を
 * 探すが、packaged(asar化)実行ではこの推測が崩れて `Could not locate the bindings file` になりうる
 * (実機バグ報告)。electron-builder の asarUnpack により、実体は常に
 * `<resourcesPath>/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node`
 * に展開される(electron-builder.yml)ため、この絶対パスを推測に頼らず明示的に組み立てる。
 *
 * 解決規則:
 * - 非packaged(開発・vitest): undefined(従来どおり bindings パッケージに解決を任せる。挙動不変)
 * - packaged かつ resourcesPath 未定義(実運用のpackaged実行では発生しないが、テスト環境等での防御):
 *   undefined(壊れずに従来経路へフォールバック)
 * - packaged かつ resourcesPath 定義済み: 上記の絶対パス(path.join で組み立てる。手書き結合はしない
 *   ため、実行環境のパス区切り文字に関わらず正しく組み立つ)
 *
 * この関数は electron に依存しない(isPackaged/resourcesPath を呼び出し側から値で受け取るだけ)。
 *
 * 注(帰属を正確に記録する): `app.asar.unpacked/node_modules/better-sqlite3/build/Release/
 * better_sqlite3.node` という相対パスはハードコードであり、将来 pnpm のネスト構造等でこの階層が
 * 変わると即例外になる(bindings パッケージの多段探索なら発見できていたケースでも失敗しうる)。
 * この懸念は code-reviewer が一次レビューの【提案・対応任意】として指摘したもので、
 * これは「新しい壊れ方」ではなく「既存の壊れ方(実機バグ報告の`Could not locate the bindings file`)を
 * 診断メッセージ付きの即時失敗に変えただけ」であるとして、対応を任意としJSDocへ記録する判断は
 * オーケストレーター(プロジェクトマネジメント役)が行った。boss は2026-08-22のメタレビューで
 * この内容(対応任意という判断・下記#62への参照)を検証のうえ支持している。
 * レイアウト変化そのものへの構造的な備え(CIで`.node`の実配置を機械検査し、変わったらCIが止まる
 * ようにする)は #62(オーケストレーターが起票)のスコープとして別途対応する。
 *
 * 注(Issue #62 での抽出): 本関数はもともと `packages/app/src/main/ipc.ts` に定義されていたが、
 * #62(配布 exe のスモークテスト)の判定核(`scripts/artifact-gate.ts`)が「本番と同一の関数」を
 * 直接呼んで検証できるよう、electron 非依存のこの独立モジュールへ抽出した(挙動不変。
 * `ipc.ts` は本モジュールを re-export するのみ)。検査スクリプトがパス規則を再実装すると、
 * 本番の規則が変わったときに検査だけ通り続けてしまうため、`ipc.ts`・`scripts/artifact-gate.ts`の
 * 両方から同じ実体を参照する構造にすることが本抽出の目的そのものである。
 */
export function resolveNativeBindingPath(input: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string | undefined;
}): string | undefined {
  if (!input.isPackaged || input.resourcesPath === undefined) {
    return undefined;
  }
  return path.join(
    input.resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "better-sqlite3",
    "build",
    "Release",
    "better_sqlite3.node",
  );
}

/**
 * resolveNativeBindingPath の戻り値がファイルとして実在するか確認し、実在すればそのまま返す
 * (Issue #60-B 受け入れ条件3)。
 *
 * 存在しなければ、原因特定に必要な4要素(期待した絶対パス・fs.existsSyncの結果・
 * process.resourcesPath・app.isPackaged)をすべて含む日本語エラーを投げ、bindings パッケージの
 * わかりにくいエラー(冒頭の実機バグ報告のような13経路の列挙)で落ちる前に検知できるようにする。
 * 非packaged(resolveNativeBindingPathの戻り値がundefined)ならそのままundefinedを返す
 * (検証不要。pipeline-deps.ts側がbindingsへ解決を委ねる)。
 *
 * 注(boss提案・対応見送りの記録): `better_sqlite3.node`という名のディレクトリが存在する病的ケースでは
 * existsSyncがtrueを返し診断をすり抜ける(statSync(...).isFile()の方が「ファイルとして実在する」という
 * 主張に忠実、というboss指摘)。ただし下の日本語エラーメッセージは受け入れ条件3で合意した文言どおり
 * `fs.existsSync`の結果を名指しで報告しており、判定をstatSyncへ差し替えると、メッセージのラベルが
 * 実際に実行した関数と一致しなくなる(受け入れ条件のメッセージ文言を変えるか、ラベルと実装を
 * 一致させないかの二択になる)。実害はほぼ無い病的ケース(boss談)のためにその再合意コストを払う
 * 積極的な理由が無いと判断し、今回は見送った(2026-08-22)。
 *
 * この関数も electron に依存しない(Issue #62 での抽出。上記 resolveNativeBindingPath 参照)。
 * `scripts/artifact-gate.ts` はこの関数をそのまま呼んで検証する(パス規則の再実装をしない)。
 */
export function resolveVerifiedNativeBindingPath(input: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string | undefined;
}): string | undefined {
  const resolved = resolveNativeBindingPath(input);
  if (resolved === undefined) {
    return undefined;
  }
  const exists = existsSync(resolved);
  if (!exists) {
    throw new Error(
      "better-sqlite3のネイティブバインディング(.node)が見つかりません。" +
        `期待した絶対パス: ${resolved} / ` +
        `fs.existsSync: ${exists} / ` +
        `process.resourcesPath: ${input.resourcesPath} / ` +
        `app.isPackaged: ${input.isPackaged}`,
    );
  }
  return resolved;
}
