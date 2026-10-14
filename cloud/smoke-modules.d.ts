// smoke 専用エントリ(smoke-worker.ts)が fixture の HTML を文字列として import するための宣言(wrangler の既定のモジュール規則: *.html は Text)。
declare module "*.html" {
  const content: string;
  export default content;
}

// smoke 専用エントリが fixture の JSON(戦績・オッズ)を import するための宣言(esbuild の JSON ローダ。値はオブジェクトで、使う側が文字列に戻す)。
declare module "*.json" {
  const content: unknown;
  export default content;
}
