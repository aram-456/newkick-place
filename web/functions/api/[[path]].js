// 플레이스 순위 관리 API (Cloudflare Pages Functions)
// 바인딩: DB(D1 newkick-place), AUTH(D1 naver-check, 상위노출 대시보드 계정 읽기 전용), CAPS(KV, 캡처)
// 비밀값: INGEST_TOKEN(체크 봇 / 타이머용), SESSION_SECRET(로그인 쿠키 서명), GH_TOKEN(지금 체크 버튼 -> GitHub 실행)
const KEEP_DAYS = 400;           // 캡처 보관 일수 (1년 + 여유)
const SESSION_DAYS = 30;
const enc = new TextEncoder();

const j = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const bad = (msg, status = 400) => j({ error: msg }, status);
const kst = (d = 0) => new Date(Date.now() + 9 * 3600e3 + d * 864e5).toISOString().slice(0, 10);
const nowKst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

function same(a, b) {
  a = String(a || ''); b = String(b || '');
  let r = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) r |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return r === 0 && a.length > 0;
}
async function hmac(secret, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
// 상위노출 대시보드와 같은 비밀번호 방식 (계정 공유)
async function hashPw(pw, saltHex, iter) {
  const salt = Uint8Array.from(saltHex.match(/../g), h => parseInt(h, 16));
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return hex(bits);
}
async function checkPw(pw, stored) {
  const [, iter, salt, h] = String(stored).split('$');
  if (!salt) return false;
  return same(await hashPw(pw, salt, +iter), h);
}
const STAFF = ['admin', 'editor'];
async function makeSession(env, u) {
  const p = b64u(enc.encode(JSON.stringify({ u: u.id, l: u.login, e: Date.now() + SESSION_DAYS * 864e5 })));
  return `${p}.${await hmac(env.SESSION_SECRET, p)}`;
}
async function readSession(req, env) {
  const m = (req.headers.get('cookie') || '').match(/(?:^|;\s*)ps=([^;]+)/);
  if (!m || !env.SESSION_SECRET) return null;
  const [p, sig] = m[1].split('.');
  if (!p || !sig || !same(sig, await hmac(env.SESSION_SECRET, p))) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(unb64u(p)));
    if (s.e < Date.now()) return null;
    const u = await env.AUTH.prepare('SELECT id, login, name, role, active FROM users WHERE id=?').bind(s.u).first();
    return u && u.active && STAFF.includes(u.role) ? u : null;   // 상위노출 쪽에서 비활성화하면 여기도 즉시 차단
  } catch { return null; }
}
const cookie = (v, age) => `ps=${v}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
async function logEv(env, req, login, action, detail) {
  try {
    await env.DB.prepare('INSERT INTO logs (login, action, detail, ip) VALUES (?,?,?,?)')
      .bind(login || null, action, detail == null ? null : String(detail).slice(0, 300), req.headers.get('cf-connecting-ip') || null).run();
  } catch {}
}

// ---------- 플레이스 링크 -> ID ----------
const idFromUrl = s => (String(s).match(/place(?:\.naver\.com)?\/(?:[a-z]+\/)?(\d{5,})/i) || String(s).match(/[?&](?:id|placeId)=(\d{5,})/) || [])[1] || null;
async function resolvePlace(link) {
  link = String(link || '').trim();
  if (/^\d{5,}$/.test(link)) return link;
  let id = idFromUrl(link);
  if (id) return id;
  let u = link;
  for (let i = 0; i < 4 && /^https?:\/\//.test(u); i++) {
    const r = await fetch(u, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' } });
    const loc = r.headers.get('location');
    if (!loc) break;
    u = new URL(loc, u).toString();
    id = idFromUrl(u);
    if (id) return id;
  }
  return null;
}

// ---------- GitHub 실행 ----------
async function dispatch(env, inputs) {
  if (!env.GH_TOKEN || !env.GH_REPO) return { ok: false, reason: 'GH_TOKEN 설정 전이에요' };
  const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/place-check.yml/dispatches`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.GH_TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'newkick-place', 'X-GitHub-Api-Version': '2022-11-28', 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs }),
  });
  return { ok: r.status === 204, reason: r.status === 204 ? '' : 'GitHub ' + r.status + ' ' + (await r.text()).slice(0, 120) };
}
const pending = async env => (await env.DB.prepare(
  `SELECT COUNT(*) n FROM items i JOIN companies c ON c.slug=i.company WHERE i.active=1 AND c.active=1
   AND NOT EXISTS (SELECT 1 FROM checks k WHERE k.item_id=i.id AND k.date=? AND k.in_top IS NOT NULL)`).bind(kst()).first()).n;

// ---------- 체크 봇 / 타이머 (INGEST_TOKEN) ----------
async function ingest(p, req, env, url) {
  const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.INGEST_TOKEN || !same(tok, env.INGEST_TOKEN)) return bad('토큰이 올바르지 않습니다', 401);
  const DB = env.DB;

  if (p === 'ingest/cron' && req.method === 'POST') {          // 오전 7시 타이머 (newkick-cron)
    const slot = url.searchParams.get('slot') || 'morning';
    const n = await pending(env);
    if (!n) { await DB.prepare('INSERT INTO runs (date, slot, status, detail, at) VALUES (?,?,?,?,?)').bind(kst(), 'cron:' + slot, 'skip', '오늘 체크 완료', nowKst()).run(); return j({ ok: true, skip: true }); }
    const d = await dispatch(env, { slot, ids: '', force: 'false' });
    await DB.prepare('INSERT INTO runs (date, slot, status, detail, at) VALUES (?,?,?,?,?)').bind(kst(), 'cron:' + slot, d.ok ? 'started' : 'failed', d.ok ? `대상 ${n}건` : d.reason, nowKst()).run();
    return j({ ok: d.ok, pending: n, reason: d.reason });
  }
  if (p === 'ingest/items') {                                   // 체크할 항목
    const ids = (url.searchParams.get('ids') || '').split(',').map(Number).filter(Boolean);
    const force = url.searchParams.get('force') === '1';
    let sql = `SELECT i.id, i.keyword, i.place_id, i.place_name, i.top_n, c.name company_name FROM items i JOIN companies c ON c.slug=i.company
      WHERE c.active=1`;
    const a = [];
    if (ids.length) sql += ` AND i.id IN (${ids.map(() => '?').join(',')})`, a.push(...ids);
    if (!(ids.length && force)) sql += ' AND i.active=1';   // 마감 항목도 번호 지정 + 강제 체크면 확인 가능 (보고용)
    if (!force) sql += ' AND NOT EXISTS (SELECT 1 FROM checks k WHERE k.item_id=i.id AND k.date=? AND k.in_top IS NOT NULL)', a.push(kst());
    const { results } = await DB.prepare(sql + ' ORDER BY i.id').bind(...a).all();
    return j({ date: kst(), items: results });
  }
  if (p === 'ingest/cap' && req.method === 'PUT') {
    const key = url.searchParams.get('key') || '';
    if (!/^cap\/\d{4}-\d{2}-\d{2}\/[\w-]+\.(jpg|png)$/.test(key)) return bad('잘못된 키');
    await env.CAPS.put(key, await req.arrayBuffer(), { expirationTtl: KEEP_DAYS * 86400, metadata: { ct: key.endsWith('png') ? 'image/png' : 'image/jpeg' } });
    return j({ ok: true });
  }
  if (p === 'ingest/result' && req.method === 'POST') {
    const b = await req.json();
    const d = kst();
    const ex = await DB.prepare('SELECT in_top FROM checks WHERE item_id=? AND date=?').bind(+b.item_id, d).first();
    if (ex && ex.in_top !== null && b.error) return j({ ok: true, kept: true });   // 오늘 정상 기록이 있으면 오류로 덮지 않음
    await DB.prepare(`INSERT INTO checks (item_id, date, rank, in_top, top_list, ads, cap_key, error, source, at) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(item_id, date) DO UPDATE SET rank=excluded.rank, in_top=excluded.in_top, top_list=excluded.top_list, ads=excluded.ads,
      cap_key=COALESCE(excluded.cap_key, checks.cap_key), error=excluded.error, source=excluded.source, at=excluded.at`)
      .bind(+b.item_id, d, b.rank ?? null, b.error ? null : (b.in_top ? 1 : 0), JSON.stringify(b.top_list || []), b.ads || 0, b.cap_key || null, b.error || null, b.source || null, nowKst()).run();
    if (b.place_name) await DB.prepare("UPDATE items SET place_name=? WHERE id=? AND (place_name IS NULL OR place_name='' OR place_name<>?)").bind(b.place_name, +b.item_id, b.place_name).run();
    // 목표 노출일(기본 25일)을 채우면 자동 마감
    let closed = false;
    if (!b.error && b.in_top) {
      const it = await DB.prepare('SELECT target, cycle_from FROM items WHERE id=?').bind(+b.item_id).first();
      const cnt = (await DB.prepare('SELECT COUNT(*) n FROM checks WHERE item_id=? AND in_top=1 AND date>=?').bind(+b.item_id, it?.cycle_from || '0000').first()).n;
      if (it && it.target && cnt >= it.target) {
        await DB.prepare("UPDATE items SET active=0, closed_at=?, close_kind='done' WHERE id=? AND active=1").bind(d, +b.item_id).run();
        closed = true;
      }
    }
    return j({ ok: true, closed });
  }
  if (p === 'ingest/run' && req.method === 'POST') {
    const b = await req.json();
    await DB.prepare('INSERT INTO runs (date, slot, status, detail, at) VALUES (?,?,?,?,?)').bind(kst(), b.slot || 'run', b.status || 'done', String(b.detail || '').slice(0, 300), nowKst()).run();
    return j({ ok: true });
  }
  return bad('없는 경로', 404);
}

// ---------- 화면 데이터 ----------
async function adminData(env, days) {
  const DB = env.DB, since = kst(-days);
  const [co, it, ck, rn] = await Promise.all([
    DB.prepare('SELECT slug, name, memo, active FROM companies ORDER BY name').all(),
    DB.prepare(`SELECT i.*, (SELECT COUNT(*) FROM checks k WHERE k.item_id=i.id AND k.in_top=1 AND k.date>=COALESCE(i.cycle_from,'0000') AND k.date<=COALESCE(i.closed_at,'9999')) done
      FROM items i ORDER BY i.active DESC, i.company, i.id`).all(),
    DB.prepare('SELECT item_id, date, rank, in_top, top_list, ads, cap_key, error, source, at FROM checks WHERE date>=? ORDER BY date').bind(since).all(),
    DB.prepare('SELECT date, slot, status, detail, at FROM runs ORDER BY id DESC LIMIT 12').all(),
  ]);
  return { today: kst(), now: nowKst(), companies: co.results, items: it.results, checks: ck.results.map(c => ({ ...c, top_list: JSON.parse(c.top_list || '[]') })), runs: rn.results };
}
async function clientData(env, slug, days) {
  const DB = env.DB;
  const co = await DB.prepare('SELECT slug, name FROM companies WHERE slug=? AND active=1').bind(slug).first();
  if (!co) return null;
  const { results: items } = await DB.prepare('SELECT id, keyword, place_id, place_name, place_url, top_n, target, cycle_from, round, closed_at, close_kind, active FROM items WHERE company=? ORDER BY active DESC, id').bind(slug).all();
  const ids = items.map(i => i.id);
  const checks = ids.length ? (await DB.prepare(`SELECT item_id, date, rank, in_top, top_list, cap_key, at FROM checks WHERE date>=? AND in_top IS NOT NULL AND item_id IN (${ids.map(() => '?').join(',')}) ORDER BY date`)
    .bind(kst(-days), ...ids).all()).results : [];
  for (const c of checks) c.top_list = JSON.parse(c.top_list || '[]');
  // 회차별 노출일 수 (그래프 기간과 상관없이 전체 집계)
  for (const i of items) i.done = (await DB.prepare('SELECT COUNT(*) n FROM checks WHERE item_id=? AND in_top=1 AND date>=? AND date<=?').bind(i.id, i.cycle_from || '0000', i.closed_at || '9999').first()).n;   // 마감 후 확인 기록은 노출일에 더하지 않음
  return { today: kst(), company: co, items, checks };
}

// ---------- 라우터 ----------
export async function onRequest({ request: req, env }) {
  const url = new URL(req.url);
  const p = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  const m = req.method;
  try {
    if (p.startsWith('ingest/')) return await ingest(p, req, env, url);

    if (p === 'login' && m === 'POST') {
      const b = await req.json().catch(() => ({}));
      const login = String(b.login || '').trim();
      const u = await env.AUTH.prepare('SELECT * FROM users WHERE login=? AND active=1').bind(login).first();
      if (!u || !STAFF.includes(u.role) || !(await checkPw(String(b.password || ''), u.pw))) {
        await logEv(env, req, login.slice(0, 60), 'login_fail', null);
        await new Promise(r => setTimeout(r, 800));
        return bad(u && !STAFF.includes(u.role) ? '관리자 계정만 사용할 수 있어요' : '아이디 또는 비밀번호가 맞지 않습니다', 401);
      }
      await logEv(env, req, u.login, 'login', null);
      return j({ ok: true }, 200, { 'set-cookie': cookie(await makeSession(env, u), SESSION_DAYS * 86400) });
    }
    if (p === 'logout') return j({ ok: true }, 200, { 'set-cookie': cookie('', 0) });

    // 업체 화면: 로그인 없이 주소(/c/업체주소)로 열람
    if (p === 'data' && m === 'GET') {
      const d = await clientData(env, url.searchParams.get('c') || '', 62);
      return d ? j(d) : bad('없는 업체예요', 404);
    }
    if (p.startsWith('cap/') && m === 'GET') {
      const key = decodeURIComponent(p.slice(4));
      const o = await env.CAPS.getWithMetadata(key, 'arrayBuffer');
      if (!o || !o.value) return new Response('not found', { status: 404 });
      return new Response(o.value, { headers: { 'content-type': o.metadata?.ct || 'image/jpeg', 'cache-control': 'public, max-age=86400' } });
    }

    const me = await readSession(req, env);
    if (!me) return bad('로그인이 필요합니다', 401);
    if (p === 'me') return j({ login: me.login, name: me.name, role: me.role });

    if (p === 'admin/data' && m === 'GET') return j(await adminData(env, Math.min(+url.searchParams.get('days') || 62, 400)));

    if (p === 'admin/items' && m === 'POST') {           // 신규 등록 (업체 없으면 같이 만듦)
      const b = await req.json();
      const name = String(b.company_name || '').trim(), keyword = String(b.keyword || '').trim();
      if (!name || !keyword) return bad('업체명과 키워드를 입력해 주세요');
      const pid = await resolvePlace(b.link);
      if (!pid) return bad('플레이스 링크에서 업체 ID를 찾지 못했어요. 링크를 다시 확인해 주세요');
      let co = await env.DB.prepare('SELECT slug FROM companies WHERE name=?').bind(name).first();
      if (!co) {
        const slug = String(b.slug || '').trim().toLowerCase();
        if (!/^[a-z0-9-]{2,30}$/.test(slug)) return bad('업체 주소는 영문 소문자·숫자·- 로 2~30자 입력해 주세요');
        if (await env.DB.prepare('SELECT 1 FROM companies WHERE slug=?').bind(slug).first()) return bad('이미 쓰고 있는 업체 주소예요');
        await env.DB.prepare('INSERT INTO companies (slug, name) VALUES (?,?)').bind(slug, name).run();
        co = { slug };
      }
      const dup = await env.DB.prepare('SELECT id FROM items WHERE company=? AND keyword=? AND place_id=? AND active=1').bind(co.slug, keyword, pid).first();
      if (dup) return bad('이미 추적 중인 키워드예요');
      const start = /^\d{4}-\d{2}-\d{2}$/.test(b.start || '') ? b.start : kst();
      const r = await env.DB.prepare('INSERT INTO items (company, keyword, place_id, place_name, place_url, top_n, target, cycle_from) VALUES (?,?,?,?,?,?,?,?) RETURNING id')
        .bind(co.slug, keyword, pid, String(b.place_name || '').trim(), String(b.link || '').trim(), Math.min(Math.max(+b.top_n || 5, 1), 10),
          Math.min(Math.max(+b.target || 25, 1), 365), start).first();
      await logEv(env, req, me.login, 'item_add', `${name} / ${keyword} / ${pid}`);
      let run = null;
      if (b.check_now) run = await dispatch(env, { slot: 'manual', ids: String(r.id), force: 'true' });
      return j({ ok: true, id: r.id, place_id: pid, slug: co.slug, run });
    }
    const im = p.match(/^admin\/items\/(\d+)$/);
    if (im && m === 'PATCH') {
      const b = await req.json(), id = +im[1];
      if (b.keyword !== undefined) await env.DB.prepare('UPDATE items SET keyword=? WHERE id=?').bind(String(b.keyword).trim(), id).run();
      if (b.memo !== undefined) await env.DB.prepare('UPDATE items SET memo=? WHERE id=?').bind(String(b.memo).slice(0, 500), id).run();
      if (b.target !== undefined) await env.DB.prepare('UPDATE items SET target=? WHERE id=?').bind(Math.min(Math.max(+b.target || 25, 1), 365), id).run();
      if (b.start !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(b.start)) await env.DB.prepare('UPDATE items SET cycle_from=? WHERE id=?').bind(b.start, id).run();
      if (b.active === 0 || b.active === false) await env.DB.prepare("UPDATE items SET active=0, closed_at=?, close_kind='manual' WHERE id=?").bind(kst(), id).run();
      if (b.active === 1 || b.active === true) await env.DB.prepare('UPDATE items SET active=1, closed_at=NULL, close_kind=NULL WHERE id=?').bind(id).run();
      if (b.extend) await env.DB.prepare('UPDATE items SET active=1, closed_at=NULL, close_kind=NULL, cycle_from=?, round=COALESCE(round,1)+1, target=? WHERE id=?')
        .bind(kst(), Math.min(Math.max(+b.target || 25, 1), 365), id).run();
      if (b.link) {
        const pid = await resolvePlace(b.link);
        if (!pid) return bad('플레이스 링크에서 업체 ID를 찾지 못했어요');
        await env.DB.prepare("UPDATE items SET place_id=?, place_url=?, place_name='' WHERE id=?").bind(pid, String(b.link).trim(), id).run();
      }
      await logEv(env, req, me.login, 'item_edit', id + ' ' + JSON.stringify(b).slice(0, 200));
      return j({ ok: true });
    }
    if (im && m === 'DELETE') {
      const id = +im[1];
      const { results } = await env.DB.prepare('SELECT cap_key FROM checks WHERE item_id=? AND cap_key IS NOT NULL').bind(id).all();
      for (const c of results) await env.CAPS.delete(c.cap_key).catch(() => {});
      await env.DB.batch([env.DB.prepare('DELETE FROM checks WHERE item_id=?').bind(id), env.DB.prepare('DELETE FROM items WHERE id=?').bind(id)]);
      await logEv(env, req, me.login, 'item_delete', id);
      return j({ ok: true });
    }
    if (p === 'admin/run' && m === 'POST') {              // 지금 체크
      const b = await req.json().catch(() => ({}));
      const ids = (b.ids || []).map(Number).filter(Boolean).join(',');
      const d = await dispatch(env, { slot: 'manual', ids, force: b.force === false ? 'false' : 'true' });
      await env.DB.prepare('INSERT INTO runs (date, slot, status, detail, at) VALUES (?,?,?,?,?)').bind(kst(), 'manual:' + me.login, d.ok ? 'started' : 'failed', d.ok ? (ids ? '항목 ' + ids : '전체') : d.reason, nowKst()).run();
      return d.ok ? j({ ok: true }) : bad(d.reason, 500);
    }
    if (p === 'admin/companies' && m === 'PATCH') {
      const b = await req.json();
      if (b.memo !== undefined) await env.DB.prepare('UPDATE companies SET memo=? WHERE slug=?').bind(String(b.memo).slice(0, 500), b.slug).run();
      if (b.active !== undefined) await env.DB.prepare('UPDATE companies SET active=? WHERE slug=?').bind(b.active ? 1 : 0, b.slug).run();
      return j({ ok: true });
    }
    return bad('없는 경로', 404);
  } catch (e) {
    return bad('서버 오류: ' + (e && e.message || e), 500);
  }
}
