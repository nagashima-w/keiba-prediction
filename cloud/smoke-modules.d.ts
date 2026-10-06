// smoke 専用エントリ(smoke-worker.ts)が fixture の HTML を文字列として import するための宣言(wrangler の既定のモジュール規則: *.html は Text)。
declare module "*.html" {
  const content: string;
  export default content;
}
