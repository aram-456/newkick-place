"""네이버 플레이스 모바일 순위 체크 + 캡처 (GitHub Actions 에서 실행)
- 모바일 통합검색(m.search.naver.com) 플레이스 영역에서 광고를 뺀 순위를 셉니다.
- 캡처는 플레이스 영역만, 광고는 숨기고, 추적 업체는 빨간 테두리로 표시합니다.
환경변수: API_URL, INGEST_TOKEN, ONLY_IDS(쉼표), FORCE(1/0), SLOT, RUN_SOURCE
"""
import json, os, re, secrets, sys, time, urllib.parse, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright

API = os.environ.get("API_URL", "").rstrip("/")
TOKEN = os.environ.get("INGEST_TOKEN", "")
ONLY_IDS = os.environ.get("ONLY_IDS", "").strip()
FORCE = os.environ.get("FORCE", "0") in ("1", "true")
SLOT = os.environ.get("SLOT", "") or "schedule"
SOURCE = os.environ.get("RUN_SOURCE", "manual")
DEBUG = Path(__file__).parent / "debug"
DEBUG.mkdir(exist_ok=True)
UA_BOT = "newkick-place-bot/1.0 (+github-actions)"   # Cloudflare 는 urllib 기본 UA 를 막음


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def api(method, path, data=None, raw=None, ctype="application/json", tries=3):
    body = raw if raw is not None else (json.dumps(data).encode() if data is not None else None)
    for i in range(tries):
        try:
            req = urllib.request.Request(API + path, data=body, method=method, headers={
                "Authorization": "Bearer " + TOKEN, "content-type": ctype, "User-Agent": UA_BOT})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode() or "{}")
        except Exception as e:
            log("API 오류", method, path, e)
            if i == tries - 1:
                raise
            time.sleep(3 * (i + 1))


# 브라우저 안에서 실행: 플레이스 영역 찾기 -> 광고 숨김 -> 순위 계산 -> 대상 강조 -> 나머지 화면 숨김
JS_ANALYZE = r"""
(target) => {
  const headers = [...document.querySelectorAll('h2,h3')].filter(h => (h.innerText || '').trim().startsWith('플레이스'));
  let sec = document.querySelector('.place_section');
  if (!sec && headers.length) { sec = headers[0]; while (sec && sec.querySelectorAll('li').length < 2) sec = sec.parentElement; }
  if (!sec) return { error: 'no_section' };
  const idOf = a => ((a && a.href || '').match(/place\.naver\.com\/[a-z]+\/(\d{5,})/) || [])[1] || null;
  const lis = [...sec.querySelectorAll('li')].filter(li => li.querySelector('a[href*="place.naver.com"], a[href*="ader.naver.com"]') && !li.parentElement.closest('li'));
  let ads = 0; const list = []; let rank = null; let targetLi = null; let targetName = '';
  for (const li of lis) {
    const isAd = !!li.querySelector('a[href*="ader.naver.com"]') || [...li.querySelectorAll('span,em,i,a')].some(e => e.children.length === 0 && e.innerText.trim() === '광고');
    if (isAd) { ads++; li.style.setProperty('display', 'none', 'important'); continue; }
    const a = [...li.querySelectorAll('a[href*="place.naver.com"]')].find(x => !/\/photo/.test(x.href) && !x.classList.contains('place_thumb')) || li.querySelector('a[href*="place.naver.com"]');
    const id = idOf(a);
    let name = '';
    if (a) { const sp = [...a.querySelectorAll('span')].find(s => s.children.length === 0 && s.innerText.trim()); name = (sp ? sp.innerText : a.innerText).trim().split('\n')[0]; }
    list.push({ id, name });
    if (id === target && rank === null) { rank = list.length; targetLi = li; targetName = name; }
  }
  if (!list.length) return { error: 'no_items' };
  if (targetLi) {
    targetLi.style.setProperty('outline', '3px solid #ff3b30', 'important');
    targetLi.style.setProperty('outline-offset', '-3px', 'important');
    targetLi.style.setProperty('background', '#fff5f5', 'important');
  }
  // 플레이스 영역만 남기기 (좌측 여백 제거)
  let node = sec;
  while (node && node !== document.documentElement) {
    const p = node.parentElement; if (!p) break;
    [...p.children].forEach(c => { if (c !== node && !['SCRIPT', 'STYLE', 'LINK'].includes(c.tagName)) c.style.setProperty('display', 'none', 'important'); });
    for (const [k, v] of [['margin', '0'], ['padding', '0'], ['max-width', 'none'], ['min-width', '0'], ['transform', 'none']]) p.style.setProperty(k, v, 'important');
    node = p;
  }
  sec.style.setProperty('margin', '0', 'important');
  document.querySelectorAll('*').forEach(e => { const cs = getComputedStyle(e); if ((cs.position === 'fixed' || cs.position === 'sticky') && !sec.contains(e)) e.style.setProperty('display', 'none', 'important'); });
  window.scrollTo(0, 0);
  sec.setAttribute('data-nk-cap', '1');
  return { list, rank, ads, targetName, total: list.length };
}
"""


def wait_images(page, timeout=8000):
    try:
        page.wait_for_function("""() => [...document.querySelectorAll('[data-nk-cap] img')].filter(i => i.offsetParent).every(i => i.complete && i.naturalWidth > 0)""", timeout=timeout)
    except Exception:
        log("  일부 이미지가 늦게 떠서 그대로 캡처")


def check(page, it, date):
    kw, pid, top_n = it["keyword"], str(it["place_id"]), int(it.get("top_n") or 5)
    url = "https://m.search.naver.com/search.naver?where=m&sm=mtp_hty&query=" + urllib.parse.quote(kw)
    last_err = None
    for attempt in range(3):
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=45000)
            try:
                page.wait_for_selector(".place_section, h2:has-text('플레이스'), h3:has-text('플레이스')", timeout=15000)
            except Exception:
                pass
            # 지연 로딩 사진을 띄우기 위해 플레이스 영역을 한 번 지나감
            page.evaluate("""() => { const s = document.querySelector('.place_section'); if (s) s.scrollIntoView({block:'start'}); }""")
            page.wait_for_timeout(1200)
            page.evaluate("() => window.scrollBy(0, 600)")
            page.wait_for_timeout(800)
            res = page.evaluate(JS_ANALYZE, pid)
            if res.get("error"):
                raise RuntimeError(res["error"])
            wait_images(page)
            page.wait_for_timeout(500)
            key = f"cap/{date}/{it['id']}-{secrets.token_hex(6)}.jpg"
            img = page.locator("[data-nk-cap]").first.screenshot(type="jpeg", quality=82)
            api("PUT", "/api/ingest/cap?key=" + urllib.parse.quote(key, safe="/"), raw=img, ctype="image/jpeg")
            rank = res.get("rank")
            in_top = rank is not None and rank <= top_n
            return {"item_id": it["id"], "rank": rank, "in_top": in_top, "top_list": res["list"][:max(top_n, 5)],
                    "ads": res.get("ads", 0), "cap_key": key, "place_name": res.get("targetName") or "", "source": SOURCE}
        except Exception as e:
            last_err = str(e)[:200]
            log(f"  재시도 {attempt + 1}/3: {last_err}")
            try:
                page.screenshot(path=str(DEBUG / f"err_{it['id']}_{attempt}.png"), full_page=True)
            except Exception:
                pass
            time.sleep(4 + attempt * 4)
    return {"item_id": it["id"], "error": "체크 오류: " + (last_err or "알 수 없음"), "source": SOURCE}


def main():
    if not API or not TOKEN:
        sys.exit("API_URL / INGEST_TOKEN 이 필요합니다")
    q = {"force": "1" if FORCE else "0"}
    if ONLY_IDS:
        q["ids"] = ONLY_IDS
    data = api("GET", "/api/ingest/items?" + urllib.parse.urlencode(q))
    items, date = data["items"], data["date"]
    log(f"체크 대상 {len(items)}건 ({date})")
    if not items:
        api("POST", "/api/ingest/run", {"slot": SLOT, "status": "skip", "detail": "체크할 항목 없음"})
        return
    ok = err = 0
    with sync_playwright() as p:
        br = p.chromium.launch(args=["--disable-blink-features=AutomationControlled"])
        dev = p.devices["iPhone 13"]
        ctx = br.new_context(**dev, locale="ko-KR", timezone_id="Asia/Seoul")
        page = ctx.new_page()
        for it in items:
            log(f"- {it['company_name']} / {it['keyword']} (플레이스 {it['place_id']})")
            r = check(page, it, date)
            api("POST", "/api/ingest/result", r)
            if r.get("error"):
                err += 1
                log("  ", r["error"])
            else:
                ok += 1
                names = ", ".join(f"{i + 1}.{x['name']}" for i, x in enumerate(r["top_list"][:5]))
                log(f"  순위: {r['rank'] or '순위 밖'} (광고 {r['ads']}개 제외) | {names}")
            time.sleep(2)
        br.close()
    api("POST", "/api/ingest/run", {"slot": SLOT, "status": "failed" if err and not ok else "done", "detail": f"정상 {ok}건, 오류 {err}건"})
    if err:
        sys.exit(1)   # GitHub 이 실패 알림 메일을 보냄


if __name__ == "__main__":
    main()
