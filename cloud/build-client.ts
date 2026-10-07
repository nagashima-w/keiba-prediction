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

export async function buildClientJs(options: { readonly minify?: boolean } = {}): Promise<string> {
  const result = await build({
    absWorkingDir: HERE,
    entryPoints: [path.join(CLIENT_DIR, "main.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2020",
    minify: options.minify ?? true,
    legalComments: "none",
    tsconfig: path.join(HERE, "tsconfig.client.json"),
    write: false,
    outfile: "client.js",
    logLevel: "silent",
  });
  const output = result.outputFiles[0];
  if (output === undefined) {
    throw new Error("esbuild の出力がありません");
  }
  return output.text;
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
