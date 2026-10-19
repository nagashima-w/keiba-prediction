/**
 * 環境変数(Worker の vars・secrets)で上書きする値の読み取り(純関数)。
 * Issue #394 で、移行機能の廃止に伴い `migration-core.ts` から移した(本体は変えていない)。検証の DO・書き出しの DO・結果の補完の DO が、上限を下げる上書きに使う。
 */

/**
 * 環境変数(Worker の vars・secrets)で上書きする値の読み取り。**1 以上の整数で、上限 `max` 以下の文字列だけ**採用し、それ以外(未設定・空・小数・負・上限超え)は無視して null。
 * 本番の既定を変える手段ではなく、**ローカルの測定・テストと、利用者が上限を下げたいとき**のため(上限を `max` で頭打ちにして、Free の枠を超える値は受け付けない)。
 */
export function parseLimitOverride(value: string | undefined, max: number): number | null {
  if (value === undefined || !/^[1-9][0-9]{0,8}$/.test(value.trim())) {
    return null;
  }
  const n = Number(value.trim());
  return n <= max ? n : null;
}
