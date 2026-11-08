import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * リポジトリ直下の `fixtures/` 配下のファイルを UTF-8 のテキストとして読み込む(テスト共通。実ネットワークは使わない)。
 *
 * Issue #400 R-12b: 以前は多数のテストファイルが、本文が同じこの関数を各自で定義していた(`../` の段数だけが違った)。
 * 1つにまとめた。パスはこのファイルの位置(`packages/core/test/support/`)から4つ上で、ほかのテストが置かれる
 * `packages/core/test/<ディレクトリ>/` と同じ深さなので、以前の定義と同じ場所を指す。
 */
export function loadFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return readFileSync(fileURLToPath(url), "utf-8");
}

/**
 * `fixtures/` 配下の Shift_JIS のファイル(JRA 公式サイトの頁を取得したままのバイト列)を、
 * デコードした文字列として読み込む(Issue #672)。本番ではデコードは呼び出し側(`cloud/src/jra-http.ts`)の仕事で、
 * core のパーサは文字列だけを受ける。
 */
export function loadShiftJisFixture(name: string): string {
  const url = new URL(`../../../../fixtures/${name}`, import.meta.url);
  return new TextDecoder("shift_jis").decode(readFileSync(fileURLToPath(url)));
}
