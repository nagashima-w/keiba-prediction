// wrangler の既定ルールにより、.html は文字列(Text モジュール)として取り込まれる。
declare module "*.html" {
  const content: string;
  export default content;
}

// core の scrape-race.ts は(型だけ)import する cache.ts が better-sqlite3 を import している。Worker では
// 実行時には使われず(バンドラは型 import を消す)、CI には @types/better-sqlite3 も無いため、型検査のためだけの
// 最小の宣言を置く。
declare module "better-sqlite3" {
  namespace Database {
    type Database = any;
  }
  const Database: any;
  export default Database;
}
