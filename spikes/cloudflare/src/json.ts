/** JSON 応答を作る(Worker と Durable Object のハンドラ共通。依存を持たないので、Node のテストからも読める)。 */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
