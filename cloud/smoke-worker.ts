/**
 * **ローカルの smoke 専用**のエントリ(Issue #162 段階2b)。本番の `wrangler.toml` の `main` ではない(smoke が生成する一時設定だけがこれを指す)。
 *
 * 目的: netkeiba へ出さずに、workerd と nodejs_compat の実環境で、
 *   Worker → DO(NetkeibaGate) → ソケットクライアント → HttpClient → cheerio(core のパーサ)
 * が fixture で通り、頭数が返ることを確かめる。DO の `connectFn()` を、**偽ソケット**(リクエストの Host とパスを見て、保存済みの
 * fixture を HTTP/1.1 の応答として返す)に差し替えたサブクラスを `NetkeibaGate` として export する。
 *
 * **本番のバンドルには入らない**: 本番のエントリ(`src/worker.ts`)はこのファイルを import しない。偽ソケットの印({@link SMOKE_FAKE_SOCKET_MARKER})が
 * 本番の dry-run のバンドルに無いことを `test/bundle-guard.test.ts` が固定している。
 */
import centralHtml from "../fixtures/shutuba_202603020211.html";
import narHtml from "../fixtures/nar_shutuba_202654071210.html";
import { NetkeibaGate as RealGate } from "./src/netkeiba-gate-do";
import type { ConnectFn, SocketLike } from "./src/socket-fetch";
import worker from "./src/worker";

/** 偽ソケットの印(本番のバンドルに入っていないことの検査に使う)。メインモジュールの export は Worker・DO のクラスだけにできるので、export しない。 */
const SMOKE_FAKE_SOCKET_MARKER = "keiba-smoke-fake-socket";

const encoder = new TextEncoder();

/** リクエストの Host とパスから、返す応答(ステータスと本文)を決める。 */
function route(host: string, path: string): { status: number; body: string } {
  const raceId = /[?&]race_id=(\d{12})(?:&|$)/.exec(path)?.[1] ?? "";
  if (host === "race.netkeiba.com" && path.startsWith("/race/shutuba.html") && raceId === "202603020211") {
    return { status: 200, body: centralHtml };
  }
  if (host === "nar.netkeiba.com" && path.startsWith("/race/shutuba.html") && raceId === "202654071210") {
    return { status: 200, body: narHtml };
  }
  // ブレーカーの確認用: この race_id は、netkeiba に拒否された(403)ことにする。
  if (host === "race.netkeiba.com" && raceId === "202605010101") {
    return { status: 403, body: "forbidden by fake socket" };
  }
  return { status: 404, body: "not found by fake socket" };
}

const fakeConnect: ConnectFn = () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  let requestText = "";
  let responded = false;
  const respond = (): void => {
    responded = true;
    const requestLine = /^GET (\S+) HTTP\/1\.1\r\n/.exec(requestText);
    const host = /\r\nHost: ([^\r\n]+)\r\n/.exec(requestText)?.[1] ?? "";
    const { status, body } = route(host, requestLine?.[1] ?? "");
    const bodyBytes = encoder.encode(body);
    const head = encoder.encode(
      `HTTP/1.1 ${status} X\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Length: ${bodyBytes.length}\r\nX-Smoke: ${SMOKE_FAKE_SOCKET_MARKER}\r\nConnection: close\r\n\r\n`,
    );
    controller.enqueue(head);
    // 小さな断片に分けて返す(読み取りのループを通す)。
    for (let offset = 0; offset < bodyBytes.length; offset += 16 * 1024) {
      controller.enqueue(bodyBytes.subarray(offset, offset + 16 * 1024));
    }
    controller.close();
  };
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      requestText += new TextDecoder().decode(chunk);
      if (!responded && requestText.includes("\r\n\r\n")) {
        respond();
      }
    },
  });
  const socket: SocketLike = {
    readable,
    writable,
    opened: Promise.resolve({}),
    close: async () => {},
  };
  return socket;
};

export class NetkeibaGate extends RealGate {
  protected override connectFn(): ConnectFn {
    return fakeConnect;
  }
}

export default worker;
