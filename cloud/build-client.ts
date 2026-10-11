/**
 * スマホ画面のクライアント(client/main.ts)を、ブラウザ向けの 1 ファイル(IIFE)にバンドルし、Worker が配る文字列の TS(src/client-bundle.generated.ts)にする(Issue #184)。
 *
 * 使い方(cloud/ で): `pnpm run build:client`(生成物を書き換える)。生成物はコミットする(typecheck・test・deploy:dry・smoke・CI が同じものを使う。
 * 前例: scripts/gen-cloud-d1-migration.ts の生成物と、そのドリフトのテスト)。`test/client-bundle.test.ts` が、再ビルドとコミット済みの一致を固定している。
 *
 * **minify: true は必須**: 外すと `// client/…`・`// ../…` のパスコメントが入り、出力が cwd・OS で変わる(ドリフトの検査が環境依存になる)。
 * esbuild は 0.28.2 に固定(出力の決定性のため。package.json の //deps)。日本語は esbuild の既定の `\u` エスケープに任せる(エンコーディングの事故を避ける)。
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CLIENT_DIR = path.join(HERE, "client");
export const GENERATED_PATH = path.join(HERE, "src", "client-bundle.generated.ts");

/**
 * exe の renderer(`allocation-proposal-view` ほか。Issue #185 で配分の表示を流用する)が import する core のサブパス(`@keiba/core/ev/...`)は、
 * `tsconfig.client.json` の `paths` で実ファイルへ向ける。**esbuild は tsconfig の paths を読む**ので、型検査(tsc)とバンドル(esbuild)の解決が 1 か所で揃う
 * (別に esbuild の `alias` を持たない。二重に持つとズレる)。CI(cloud/ だけをインストールし、各 package の node_modules が無い配置)でも解決できる
 * (実測: alias なし・paths ありで、生成物がバイト単位で同一。paths も外すと `Could not resolve "@keiba/core/ev/combo-bet-allocation"` で失敗する)。
 * **バレル `@keiba/core` は paths に無い**(better-sqlite3 を巻き込むので、import されたら解決に失敗して落ちる)。
 * renderer の閉包が新しいサブパスを import しても `@keiba/core/*` で解決されるが、閉包に入ってはいけないもの(node_modules・バレル・better-sqlite3 に依存するモジュール)は
 * `test/client-bundle.test.ts` の metafile の検査が拾う。
 */
async function runBuild(options: { readonly minify: boolean }) {
  return build({
    absWorkingDir: HERE,
    entryPoints: [path.join(CLIENT_DIR, "main.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: options.minify,
    legalComments: "none",
    tsconfig: path.join(HERE, "tsconfig.client.json"),
    metafile: true,
    write: false,
    outfile: "client.js",
    logLevel: "silent",
  });
}

export async function buildClientJs(options: { readonly minify?: boolean } = {}): Promise<string> {
  const result = await runBuild({ minify: options.minify ?? true });
  const output = result.outputFiles[0];
  if (output === undefined) {
    throw new Error("esbuild の出力がありません");
  }
  return output.text;
}

/** バンドルに入った入力ファイル(cloud/ からの相対パス。`/` 区切り)。閉包の検査(node_modules・バレルなどが入っていないこと)に使う。 */
export async function listBundledInputs(): Promise<string[]> {
  const result = await runBuild({ minify: true });
  return Object.keys(result.metafile.inputs).sort();
}

/** 生成する TS モジュールの全文(LF)。 */
export function renderGeneratedModule(js: string): string {
  return `// ★生成物。手で編集しない。再生成: cloud/ で \`pnpm run build:client\`(build-client.ts)。
// cloud/client/ のクライアント(スマホ画面)を esbuild で 1 ファイルにしたもの。Worker が \`GET /app.js\` で、認証の後ろで配る(Issue #184)。
// test/client-bundle.test.ts が、今のソースから再ビルドした出力との一致を固定している。
export const CLIENT_JS: string = ${JSON.stringify(js)};
`;
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  const js = await buildClientJs();
  writeFileSync(GENERATED_PATH, renderGeneratedModule(js));
  console.log(`生成しました: ${path.relative(HERE, GENERATED_PATH)}(${Buffer.byteLength(js)} バイト)`);
}
