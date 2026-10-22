// 업체별 주소: /c/<업체주소> -> 업체 화면(dash.html)
export async function onRequest({ request, env }) {
  let res = await env.ASSETS.fetch(new Request(new URL('/dash', request.url), { headers: request.headers }));
  if (res.status >= 300 && res.status < 400 && res.headers.get('location'))
    res = await env.ASSETS.fetch(new Request(new URL(res.headers.get('location'), request.url), { headers: request.headers }));
  return new Response(res.body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
}
