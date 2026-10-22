// 관리자 / 업체 화면 공통
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const md = d => +d.slice(5, 7) + '/' + +d.slice(8, 10);
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const wd = d => WD[new Date(d + 'T00:00:00Z').getUTCDay()];
function toast(msg, ms = 2600) { const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), ms); }
async function api(path, opt = {}) {
  const r = await fetch('/api/' + path, { ...opt, headers: { 'content-type': 'application/json', ...(opt.headers || {}) }, body: opt.body && typeof opt.body !== 'string' ? JSON.stringify(opt.body) : opt.body });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && !path.startsWith('login')) { location.href = '/?next=' + encodeURIComponent(location.pathname); throw new Error('로그인이 필요해요'); }
  if (!r.ok) throw new Error(d.error || '요청 실패 (' + r.status + ')');
  return d;
}
const rankText = c => !c ? '체크 전' : c.in_top === null || c.in_top === undefined ? '오류' : c.in_top ? c.rank + '위' : (c.top_n || 5) + '위 밖';

// 순위 추이 그래프 (위로 갈수록 상위). 순위 밖은 맨 아래 줄
function chart(checks, today, days, topN) {
  const narrow = window.innerWidth < 640;
  const W = narrow ? 270 : 640, H = narrow ? 150 : 170, L = narrow ? 30 : 34, R = narrow ? 14 : 24, T = 12, B = 26;
  const by = Object.fromEntries(checks.filter(c => c.in_top !== null && c.in_top !== undefined).map(c => [c.date, c]));
  const start = addDays(today, -(days - 1));
  const xs = i => L + (W - L - R) * (days === 1 ? 0.5 : i / (days - 1));
  const rows = topN + 1;
  const ys = r => T + (H - T - B) * ((Math.min(r, rows) - 1) / (rows - 1));
  let grid = '', pts = [], dots = '';
  for (let r = 1; r <= rows; r++) {
    grid += `<line x1="${L}" x2="${W - R}" y1="${ys(r)}" y2="${ys(r)}" stroke="${r === rows ? '#ffd9dc' : '#eef0f3'}" stroke-dasharray="${r === rows ? '4 4' : ''}"/>`;
    grid += `<text class="axis" x="${L - 8}" y="${ys(r) + 4}" text-anchor="end">${r === rows ? '밖' : r + '위'}</text>`;
  }
  const step = days > 20 ? 7 : days > 10 ? 3 : 1;
  for (let i = 0; i < days; i++) {
    const d = addDays(start, i);
    if ((days - 1 - i) % step === 0) grid += `<text class="axis" x="${xs(i)}" y="${H - 6}" text-anchor="middle">${md(d)}</text>`;
    const c = by[d];
    if (c) {
      const r = c.in_top ? c.rank : rows;
      pts.push([xs(i), ys(r)]);
      dots += `<circle cx="${xs(i)}" cy="${ys(r)}" r="${d === today ? 5 : 3.5}" fill="${c.in_top ? '#3182f6' : '#f04452'}" stroke="#fff" stroke-width="1.5"><title>${md(d)} ${c.in_top ? c.rank + '위' : '순위 밖'}</title></circle>`;
    }
  }
  const path = pts.length > 1 ? `<polyline points="${pts.map(p => p.join(',')).join(' ')}" fill="none" stroke="#3182f6" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" opacity=".85"/>` : '';
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="none" style="height:auto;aspect-ratio:${W}/${H}">${grid}${path}${dots}</svg>`;
}

// 일별 순위 칸 (최근 n일)
function dayChips(checks, today, n, topN, onClickName, from) {
  const by = Object.fromEntries(checks.map(c => [c.date, c]));
  let h = '';
  for (let i = n - 1; i >= 0; i--) {
    const d = addDays(today, -i), c = by[d];
    if (from && d < from) continue;
    const cls = !c ? '' : c.in_top === null || c.in_top === undefined ? 'err' : c.in_top ? 'ok' : 'out';
    const v = !c ? '-' : cls === 'err' ? '!' : c.in_top ? c.rank : '밖';
    const click = c && c.cap_key ? ` onclick="${onClickName}('${d}')"` : '';
    h += `<button class="dd ${cls} ${d === today ? 'today' : ''}"${click} title="${md(d)}(${wd(d)}) ${!c ? '기록 없음' : rankText({ ...c, top_n: topN })}"><i>${md(d)}</i><b>${v}</b></button>`;
  }
  return `<div class="days">${h}</div>`;
}

// 캡처 보기 (날짜 이동 가능)
let capCtx = null;
function openCap(title, list, date) {
  capCtx = { title, list: list.filter(c => c.cap_key), idx: 0 };
  capCtx.idx = Math.max(0, capCtx.list.findIndex(c => c.date === date));
  if (!capCtx.list.length) return toast('캡처가 없어요');
  if (date && capCtx.list[capCtx.idx]?.date !== date) capCtx.idx = capCtx.list.length - 1;
  drawCap();
  $('#cap').hidden = false;
}
function drawCap() {
  const c = capCtx.list[capCtx.idx];
  $('#capT').textContent = capCtx.title;
  $('#capS').textContent = `${md(c.date)}(${wd(c.date)}) ${c.at ? c.at.slice(11) + ' 체크' : ''} · ${c.in_top ? c.rank + '위' : '순위 밖'}`;
  $('#capI').innerHTML = `<img src="/api/cap/${c.cap_key}" alt="${esc(c.date)} 캡처">`;
  $('#capP').disabled = capCtx.idx <= 0; $('#capN').disabled = capCtx.idx >= capCtx.list.length - 1;
}
function capMove(d) { capCtx.idx = Math.min(Math.max(capCtx.idx + d, 0), capCtx.list.length - 1); drawCap(); }
const CAP_MODAL = `<div class="md" id="cap" hidden onclick="if(event.target===this)this.hidden=true"><div class="mb"><button class="x" onclick="$('#cap').hidden=true">닫기</button>
<h2 id="capT"></h2><div class="sub" id="capS"></div><div class="capw" id="capI"></div>
<div class="nav2"><button class="btn" id="capP" onclick="capMove(-1)">이전 날짜</button><button class="btn" id="capN" onclick="capMove(1)">다음 날짜</button></div></div></div>`;

// 진행 막대 (관리자·업체 화면 공통): 노출 n / 25일 · 남은 n일 · 시작일 · 마감 예정일
// 마감 예정일 = 남은 날을 매일 채운다고 가정한 예상일 (오늘 체크가 끝났으면 내일부터 계산)
function progHtml(i, checks, today) {
  const done = i.done || 0, target = i.target || 25, left = Math.max(0, target - done);
  const pct = Math.min(100, Math.round(done / target * 100));
  const checkedToday = (checks || []).some(c => c.date === today && c.in_top !== null && c.in_top !== undefined);
  let right;
  if (!i.active && i.closed_at) right = `${i.close_kind === 'done' ? '목표 달성' : ''} 마감 ${md(i.closed_at)}`;
  else if (!left) right = '목표 달성';
  else right = `남은 ${left}일 · ${i.cycle_from ? md(i.cycle_from) + ' 시작 · ' : ''}마감 예정 ${md(addDays(today, checkedToday ? left : left - 1))}`;
  return `<div class="prog"><div class="pt"><span>노출 <b>${done}</b> / ${target}일${i.round > 1 ? ` · ${i.round}회차` : ''}</span><span>${right}</span></div><div class="pb"><i style="width:${pct}%"></i></div></div>`;
}
// 오늘 상위 n개 (광고 제외) 목록 상자
function top5Html(i, ref, today, note, extra) {
  const list = ref && ref.top_list ? ref.top_list.slice(0, i.top_n) : [];
  const lis = list.map((x, k) => `<li class="${x.id === i.place_id ? 'me' : ''}"><b>${k + 1}</b><span>${esc(x.name || '이름 없음')}</span></li>`).join('');
  return `<div class="box"><div class="bt"><span>${ref ? (ref.date === today ? '오늘' : md(ref.date)) + ' 상위 ' + i.top_n + '개 (광고 제외)' : '상위 목록'}</span></div>
    ${lis ? `<ul class="top5">${lis}</ul>` : '<div class="sub">체크 후 표시돼요</div>'}${extra || ''}${note ? `<div class="g5">${note}</div>` : ''}</div>`;
}
const placeLink = i => i.place_url && /^https?:\/\//.test(i.place_url) ? i.place_url : `https://m.place.naver.com/place/${i.place_id}`;
