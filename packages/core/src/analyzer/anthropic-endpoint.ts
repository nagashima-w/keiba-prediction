/**
 * Anthropic API の宛先(Issue #304)。SDK のクライアントを生成するとき、`baseURL` として固定で渡す。
 *
 * `@anthropic-ai/sdk` は `baseURL` を省略すると環境変数 `ANTHROPIC_BASE_URL`(`process.env`)を読む。
 * Worker は `nodejs_compat` で secret が `process.env` に入りうるため、その名前の secret を誤って登録すると、
 * API キーが別のホストへ送られる。宛先を固定すれば、環境変数があっても効かない。
 * SDK のクライアントを生成する箇所を足すときは必ずこの定数を渡すこと(`test/analyzer/anthropic-baseurl.test.ts` の静的ガードが検査する。
 * ガードは生成式のリテラルを走査するので、コメントにもその式を書かないこと)。
 */
export const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";
