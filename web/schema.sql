-- 플레이스 순위 관리 DB (Cloudflare D1 / SQLite)
-- 배포 때마다 다시 실행되므로 CREATE ... IF NOT EXISTS 만 사용 (ALTER TABLE 금지)

CREATE TABLE IF NOT EXISTS companies (
  slug        TEXT PRIMARY KEY,            -- 업체 화면 주소용 영문 ID (예: hallym)
  name        TEXT NOT NULL UNIQUE,        -- 업체명 (예: 한림병원)
  memo        TEXT DEFAULT '',             -- 관리자만 보는 메모
  active      INTEGER DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- 추적 항목: 키워드 1개 + 추적할 플레이스 1개
CREATE TABLE IF NOT EXISTS items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company     TEXT NOT NULL REFERENCES companies(slug),
  keyword     TEXT NOT NULL,
  place_id    TEXT NOT NULL,               -- 네이버 플레이스 ID (예: 13177934)
  place_name  TEXT DEFAULT '',             -- 플레이스 이름 (체크 때 자동 갱신)
  place_url   TEXT DEFAULT '',             -- 등록할 때 넣은 링크
  top_n       INTEGER DEFAULT 5,           -- 몇 위까지 볼지 (모바일 기본 노출 5개)
  target      INTEGER DEFAULT 25,          -- 노출(top_n 안) 목표 일수. 채우면 자동 마감
  cycle_from  TEXT,                        -- 이 날짜부터의 노출일만 집계 (연장 시 새 회차 시작일)
  round       INTEGER DEFAULT 1,           -- 회차 (연장하면 2, 3 ...)
  closed_at   TEXT,                        -- 마감일
  close_kind  TEXT,                        -- done = 목표 달성 마감 / manual = 수동 마감
  memo        TEXT DEFAULT '',
  active      INTEGER DEFAULT 1,           -- 0 = 마감 (체크 안 함)
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_items_co ON items(company, active);

-- 하루 1건 (같은 날 다시 체크하면 덮어씀)
CREATE TABLE IF NOT EXISTS checks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id     INTEGER NOT NULL REFERENCES items(id),
  date        TEXT NOT NULL,               -- YYYY-MM-DD (한국 시간)
  rank        INTEGER,                     -- 광고 제외 순위, NULL = 순위 밖 / 오류
  in_top      INTEGER,                     -- 1 = top_n 안, 0 = 밖, NULL = 오류
  top_list    TEXT DEFAULT '[]',           -- 광고 제외 상위 목록 [{id,name}]
  ads         INTEGER DEFAULT 0,           -- 숨긴 광고 수
  cap_key     TEXT,                        -- 캡처 KV 키
  error       TEXT,
  source      TEXT,                        -- cron / manual / github-schedule
  at          TEXT,                        -- 체크 시각 (KST, YYYY-MM-DD HH:MM)
  UNIQUE(item_id, date)
);
CREATE INDEX IF NOT EXISTS idx_checks_date ON checks(date);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT NOT NULL,
  slot        TEXT,                        -- morning / manual
  status      TEXT,                        -- started / done / failed
  detail      TEXT,
  at          TEXT
);

CREATE TABLE IF NOT EXISTS logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  login       TEXT,
  action      TEXT,
  detail      TEXT,
  ip          TEXT,
  at          TEXT DEFAULT (datetime('now'))
);

-- 2026-11-15: GitHub 사용량 차단으로 체크 누락 -> 11/14 결과로 채우고 1회차 목표(25일) 달성 마감 (한 번만 적용, 다시 실행해도 변화 없음)
INSERT OR IGNORE INTO checks (item_id, date, rank, in_top, top_list, ads, cap_key, error, source, at)
  SELECT item_id, '2026-11-15', rank, in_top, top_list, ads, cap_key, error, 'fill:2026-11-14', at FROM checks WHERE item_id=1 AND date='2026-11-14';
UPDATE items SET active=0, closed_at='2026-11-15', close_kind='done'
  WHERE id=1 AND active=1 AND closed_at IS NULL AND cycle_from='2026-10-22'
  AND (SELECT COUNT(*) FROM checks WHERE item_id=1 AND in_top=1 AND date>='2026-10-22') >= target;

-- 2026-11-16: 한림병원 인천종합병원 2회차 시작 (1회차 기록은 마감 항목으로 보관). 오늘 체크 결과를 2회차 첫 기록으로 연결 (한 번만 적용)
INSERT INTO items (company, keyword, place_id, place_name, place_url, top_n, target, cycle_from, round, memo)
  SELECT company, keyword, place_id, place_name, place_url, top_n, target, '2026-11-16', 2, '' FROM items
  WHERE id=1 AND active=0 AND NOT EXISTS (SELECT 1 FROM items x WHERE x.company=items.company AND x.keyword=items.keyword AND x.round=2);
INSERT OR IGNORE INTO checks (item_id, date, rank, in_top, top_list, ads, cap_key, error, source, at)
  SELECT (SELECT x.id FROM items x WHERE x.company='hallym' AND x.round=2 AND x.cycle_from='2026-11-16' ORDER BY x.id LIMIT 1), date, rank, in_top, top_list, ads, cap_key, error, source, at
  FROM checks WHERE item_id=1 AND date='2026-11-16'
  AND EXISTS (SELECT 1 FROM items x WHERE x.company='hallym' AND x.round=2 AND x.cycle_from='2026-11-16');

-- 2026-11-20: 오투성형외과 수원성형외과 11/19 3위 노출 시작 기록 (11/20 캡처를 같이 사용, 한 번만 적용)
INSERT OR IGNORE INTO checks (item_id, date, rank, in_top, top_list, ads, cap_key, error, source, at)
  SELECT item_id, '2026-11-19', 3, 1, top_list, ads, cap_key, NULL, 'fill:2026-11-20', '2026-11-19 ' || substr(at, 12) FROM checks
  WHERE item_id=3 AND date='2026-11-20' AND in_top=1 AND cap_key IS NOT NULL
  AND EXISTS (SELECT 1 FROM items WHERE id=3 AND company='o2ps' AND keyword='수원성형외과' AND cycle_from='2026-11-19');
