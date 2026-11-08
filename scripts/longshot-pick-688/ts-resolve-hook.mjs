// .js で書かれた相対 import を、同じ名前の .ts へ解決する(Node の型の除去だけで本番の TS を動かすための道具)。
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (e) {
    if (specifier.startsWith(".") && specifier.endsWith(".js")) {
      return nextResolve(specifier.slice(0, -3) + ".ts", context);
    }
    throw e;
  }
}
