const express = require('express');
const cors = require('cors');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const Timetable = require('comcigan-parser');
const crypto = require('crypto');
const path = require('path'); // 웹 페이지 경로 바인딩을 위해 추가

const app = express();

// 🔄 [수정] Render 환경의 포트를 자동으로 감지하고, 없을 때만 26685를 사용합니다.
const PORT = process.env.PORT || 26685;

const NEIS_API_KEY = '7134e6ee67034ecca9e2126aba6089a6'; 
const KAKAO_JS_KEY = '5ebba637286876de21f738703d517089'; 

app.use(cors());
app.use(express.json());

// 📁 [웹 접속 오류 해결] HTML, CSS, JS 프론트엔드 정적 파일 연동 설정
app.use(express.static(path.join(__dirname)));

// 🔐 [서버 시작 시 무작위 일회용 마스터 인증코드 최초 발급]
let tempMasterCode = `GS-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

// [디버깅 미들웨어] 모든 API 요청의 헤더와 엔드포인트를 실시간 감시
app.use((req, res, next) => {
  console.log(`\n[▶ Request] ${req.method} ${decodeURIComponent(req.url)} | IP: ${req.ip}`);
  if (Object.keys(req.body).length > 0) {
    console.log(`    └─ Body Data:`, JSON.stringify(req.body));
  }
  next();
});

const timetable = new Timetable();

// SQLite 데이터베이스 연결 및 초기화 (WAL 모드 적용)
const db = new sqlite3.Database('./greenstep.db', (err) => {
  if (err) {
    console.error('❌ [DB 연결 오류]:', err.message);
  } else {
    console.log('✅ [DB 연결 성공] greenstep.db 파일 준비 완료');
    db.run('PRAGMA journal_mode = WAL;');
  }
});

// 🛠️ 테이블 생성 쿼리 정형화
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    device_id TEXT PRIMARY KEY, username TEXT, school TEXT, schul_code TEXT, atpt_code TEXT,
    school_kind TEXT, school_lat REAL, school_lng REAL, grade INTEGER, class_num INTEGER,
    steps_today INTEGER, steps_total INTEGER, is_commuted INTEGER, commute_time TEXT,
    level INTEGER, commute_count INTEGER, last_saved_date TEXT, updatedAt TEXT,
    last_read_noti_id INTEGER DEFAULT 0, is_admin INTEGER DEFAULT 0, is_muted INTEGER DEFAULT 0
  )`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_users_ranking ON users(schul_code, steps_total DESC);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_users_class ON users(schul_code, grade, class_num);`);

  db.run(`CREATE TABLE IF NOT EXISTS cheers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schul_code TEXT, grade INTEGER, class_num INTEGER,
    username TEXT, content TEXT, is_admin INTEGER DEFAULT 0, createdAt TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT, content TEXT, type TEXT, createdAt TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS feedbacks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT, username TEXT, school TEXT, schul_code TEXT,
    grade INTEGER, class_num INTEGER, title TEXT, content TEXT, createdAt TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
});

const dbGet = (query, params) => new Promise((resolve, reject) => {
  db.get(query, params, (err, row) => err ? reject(err) : resolve(row));
});
const dbRun = (query, params) => new Promise((resolve, reject) => {
  db.run(query, params, function(err) { err ? reject(err) : resolve(this); });
});
const dbAll = (query, params) => new Promise((resolve, reject) => {
  db.all(query, params, (err, rows) => err ? reject(err) : resolve(rows));
});

function getKstDateString() {
  const kstOffset = 9 * 60 * 60 * 1000;
  return new Date(Date.now() + kstOffset).toISOString().slice(0, 10).replace(/-/g, "");
}

function calculateLevel(totalSteps) {
  let level = 0;
  let cumulativeTarget = 2000;
  while (totalSteps >= cumulativeTarget) {
    level++;
    cumulativeTarget += 2000 * (level + 1);
  }
  return level;
}

/* =================================================================
    [🌐 브라우저 루트 접속 처리 라우터]
   ================================================================= */
app.get('/', (req, res) => {
  console.log(`[🌐 브라우저 접속] 누군가 메인 서버 웹 페이지 주소로 접속했습니다.`);
  res.sendFile(path.join(__dirname, 'index.html'), (err) => {
    if (err) {
      res.status(404).send("<h3>GreenStep Backend is Running!</h3><p>현재 폴더에 index.html 파일이 없어 기본 페이지를 띄웁니다.</p>");
    }
  });
});

/* =================================================================
    [🔐 관리자 일회용 마스터 인증 로그인 API]
   ================================================================= */
app.post('/api/admin/login', async (req, res) => {
  const { admin_name, password } = req.body;
  console.log(`[🔐 로그인 시도] 계정명: ${admin_name || '미지정'} | 시도한 비번: ${password}`);

  if (!password) {
    console.log(`    └─ [결과 실패] 패스워드 파라미터가 누락되었습니다.`);
    return res.status(400).json({ success: false, error: "데이터 누락" });
  }

  if (!tempMasterCode) {
    console.log(`    └─ [결과 실패] 이미 소진된 마스터 코드 접근입니다.`);
    return res.status(401).json({ 
      success: false, 
      error: "USED_CODE", 
      message: "❌ 이미 사용된 코드입니다. 터미널 창에 새로 뜬 비밀번호를 확인해 주세요." 
    });
  }

  if (password === tempMasterCode) {
    tempMasterCode = `GS-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    console.log(`\n=================================================`);
    console.log(` 🔑 [보안] 관리자 로그인 성공으로 인증코드가 자동 갱신되었습니다.`);
    console.log(` 다음 로그인용 일회용 비밀번호: ${tempMasterCode} `);
    console.log(`=================================================\n`);

    return res.json({ 
      success: true, 
      message: "일회용 코드가 인증되었습니다. 다음 로그인은 터미널의 새 코드를 사용하세요." 
    });
  }

  console.log(`[⚠️ 로그인 실패] 잘못된 마스터 코드가 입력됨: ${password}`);
  return res.status(401).json({ 
    success: false, 
    error: "INVALID_CODE", 
    message: "❌ 일회용 비밀번호가 일치하지 않습니다. 다시 입력해 주세요." 
  });
});

/* =================================================================
    [SSE - 실시간 알림 스트림]
   ================================================================= */
let clients = [];
app.get('/api/notifications/stream', (req, res) => {
  req.socket.setTimeout(0);
  req.socket.setKeepAlive(true);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); 
  res.flushHeaders();
  
  clients.push(res);
  console.log(`[📡 SSE 스트림 연결] 새로운 클라이언트 스트림 구독 시작 (총 커넥션: ${clients.length}개)`);
  
  res.write(`data: ${JSON.stringify({ type: 'CONNECTED', message: '알림 서버 연결됨' })}\n\n`);
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    clients = clients.filter(client => client !== res);
    console.log(`[📡 SSE 스트림 해제] 클라이언트 연결 종료 (남은 커넥션: ${clients.length}개)`);
  });
});

/* =================================================================
    [유저 동기화 & 사칭 방지 프로필 검증 API]
   ================================================================= */
app.post('/api/user/validate-profile', async (req, res) => {
  const { device_id, username, schul_code, grade, class_num } = req.body;
  console.log(`[🔍 프로필 검증] 이름: ${username} | 학교코드: ${schul_code} | 반: ${grade}-${class_num}`);
  try {
    const decodedId = decodeURIComponent(device_id);
    const dupUser = await dbGet(
      `SELECT device_id FROM users WHERE schul_code = ? AND grade = ? AND class_num = ? AND username = ? AND device_id != ? AND device_id != ?`,
      [schul_code, grade, class_num, username, device_id, decodedId]
    );
    if (dupUser) {
      console.log(`    └─ [❌ 사칭 경고] 중복 기기 식별값 검출됨: ${dupUser.device_id}`);
      return res.status(403).json({ 
        success: false, 
        error: "IMPERSONATION_DETECTED",
        message: "🚨 이미 다른 기기에서 등록된 학생 이름과 학반입니다. 사칭 방지를 위해 등록할 수 없습니다. 본인이 맞다면 관리자에게 문의하세요."
      });
    }
    console.log(`    └─ [✅ 검증 통과] 등록 가능한 고유 정보입니다.`);
    res.json({ success: true });
  } catch (err) {
    console.error(`    └─ [💥 에러]:`, err.message);
    res.status(500).json({ success: false, error: "검증 실패" });
  }
});

app.get('/api/user/:device_id', async (req, res) => {
  const rawId = req.params.device_id;
  const decodedId = decodeURIComponent(rawId);
  console.log(`[👤 유저 단건조회] ID: ${decodedId}`);
  try {
    const user = await dbGet('SELECT * FROM users WHERE device_id = ? OR device_id = ?', [rawId, decodedId]);
    
    if (!user) {
      console.log(`    └─ [🔎 조회결과 없음] 신규 등록이 필요합니다.`);
      return res.status(404).json({ error: '유저 없음', requested_id: decodedId });
    }
    
    const currentTodayStr = getKstDateString();
    const isSameDay = user.last_saved_date === currentTodayStr;

    console.log(`    └─ [🎉 유저 확인 완료] 이름: ${user.username} | 누적 걸음수: ${user.steps_total}`);
    res.json({
      success: true,
      user: {
        ...user,
        steps_today: isSameDay ? (user.steps_today || 0) : 0,
        is_commuted: isSameDay ? (user.is_commuted === 1) : false,
        commute_time: isSameDay ? (user.commute_time || '') : '',
        level: calculateLevel(user.steps_total || 0)
      }
    });
  } catch (error) {
    console.error(`    └─ [💥 에러]:`, error.message);
    res.status(500).json({ error: '유저 조회 실패' });
  }
});

// 알림 API
app.get('/api/notifications/unread/:device_id', async (req, res) => {
  const decodedId = decodeURIComponent(req.params.device_id);
  console.log(`[🔔 안읽은 알림 확인] ID: ${decodedId}`);
  try {
    const user = await dbGet('SELECT last_read_noti_id FROM users WHERE device_id = ? OR device_id = ?', [req.params.device_id, decodedId]);
    const lastId = user ? (user.last_read_noti_id || 0) : 0;
    const unreadList = await dbAll('SELECT * FROM notifications WHERE id > ? ORDER BY id ASC', [lastId]);
    console.log(`    └─ 안읽은 알림 개수: ${unreadList.length}개 (마지막 확인 ID: ${lastId})`);
    res.json({ success: true, list: unreadList });
  } catch (error) { res.status(500).json({ error: '알림 조회 실패' }); }
});

app.post('/api/notifications/read', async (req, res) => {
  const { device_id, noti_id } = req.body;
  console.log(`[🔔 알림 읽음 처리] ID: ${device_id} | 알림번호: ${noti_id}`);
  if (!device_id || !noti_id) return res.status(400).json({ error: '데이터 누락' });
  try {
    const decodedId = decodeURIComponent(device_id);
    await dbRun('UPDATE users SET last_read_noti_id = MAX(COALESCE(last_read_noti_id, 0), ?) WHERE device_id = ? OR device_id = ?', [noti_id, device_id, decodedId]);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: '읽음 처리 실패' }); }
});

/* [방명록(전체 학교 응원 한마디) & 날씨 API] */
app.get('/api/cheers', async (req, res) => {
  const { schul_code } = req.query;
  console.log(`[💬 방명록 조회] 학교코드: ${schul_code}`);
  try {
    const rows = await dbAll(`SELECT username, grade, class_num, content, is_admin, createdAt FROM cheers WHERE schul_code = ? OR schul_code = 'ALL' ORDER BY id DESC LIMIT 50`, [schul_code]);
    res.json({ success: true, list: rows });
  } catch (error) { res.status(500).json({ error: '방명록 조회 실패' }); }
});

app.post('/api/cheers', async (req, res) => {
  const { schul_code, grade, class_num, username, content } = req.body;
  console.log(`[💬 방명록 쓰기] [${schul_code}] ${grade}-${class_num} ${username}: ${content}`);
  if (!schul_code || !grade || !class_num || !username || !content) return res.status(400).json({ error: '데이터 누락' });
  try {
    const adminKeywords = ['운영자', '관리자', '선생님', '개발자', 'GreenStep'];
    
    const user = await dbGet(`SELECT is_admin, is_muted FROM users WHERE username = ? AND schul_code = ?`, [username, schul_code]);
    const dbAdminFlag = user && user.is_admin === 1;
    const isMuted = user && user.is_muted === 1;
    const isAdmin = (dbAdminFlag || adminKeywords.some(kw => username.includes(kw))) ? 1 : 0;

    if (isMuted && !isAdmin) {
      console.log(`    └─ [⛔ 차단 필터] 뮤트 상태인 유저의 작성 시도가 제지되었습니다.`);
      return res.status(403).json({ error: '귀하는 관리자에 의해 서비스 이용 수칙 위반으로 채팅 작성이 제한(잠금)되었습니다.' });
    }

    const nowKst = new Date(Date.now() + (9 * 60 * 60 * 1000)).toISOString().replace('T', ' ').substring(0, 19);
    await dbRun(`INSERT INTO cheers (schul_code, grade, class_num, username, content, is_admin, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`, [schul_code, grade, class_num, username, content.trim(), isAdmin, nowKst]);
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: '방명록 등록 실패' }); }
});

app.get('/api/weather', async (req, res) => {
  const { lat, lng } = req.query;
  console.log(`[☀️ 외부 날씨 연동] 좌표 Lat: ${lat}, Lng: ${lng}`);
  const targetLat = lat || 37.5665, targetLng = lng || 126.9780;
  try {
    const response = await axios.get(`https://api.open-meteo.com/v1/forecast?latitude=${targetLat}&longitude=${targetLng}&current_weather=true&timezone=Asia/Seoul`);
    const code = response.data.current_weather.weathercode;
    let comment = "걸어서 등교하기 딱 좋은 날씨예요! 🏃", statusText = "맑음";
    if (code >= 1 && code <= 3) { statusText = "구름 조금"; comment = "선선해서 걷기 좋은 날씨예요 ☁️"; }
    else if (code >= 51 && code <= 67) { statusText = "비"; comment = "우산 챙기시고 차 조심해서 등교해요 ☔"; }
    res.json({ success: true, temp: response.data.current_weather.temperature, wind: response.data.current_weather.windspeed, status: statusText, message: comment });
  } catch (error) { res.json({ success: true, temp: 18.5, wind: 1.2, status: "맑음", message: "오늘도 활기차게 걸어볼까요? 👣" }); }
});

/* [NEIS API] */
app.get('/api/neis/school', async (req, res) => {
  console.log(`[🏫 교육청 학교검색] 검색어: ${req.query.name}`);
  try {
    const response = await axios.get('https://open.neis.go.kr/hub/schoolInfo', { params: { KEY: NEIS_API_KEY, Type: 'json', SCHUL_NM: req.query.name } });
    res.json({ rows: response.data.schoolInfo ? response.data.schoolInfo[1].row : [] });
  } catch (error) { res.status(500).json({ error: 'NEIS 학교 검색 실패' }); }
});

app.get('/api/neis/classes', async (req, res) => {
  console.log(`[🏫 교육청 반목록] 학교코드: ${req.query.schul_code} | 학년: ${req.query.grade}`);
  try {
    const response = await axios.get('https://open.neis.go.kr/hub/classInfo', { params: { KEY: NEIS_API_KEY, Type: 'json', ATPT_OFCDC_SC_CODE: req.query.atpt_code, SD_SCHUL_CODE: req.query.schul_code, GRADE: req.query.grade, AY: req.query.year || new Date().getFullYear() } });
    res.json({ classList: response.data.classInfo ? response.data.classInfo[1].row.map(item => item.CLASS_NM) : [] });
  } catch (error) { res.status(500).json({ error: 'NEIS 반 목록 로드 실패' }); }
});

app.get('/api/neis/meal', async (req, res) => {
  console.log(`[🍱 교육청 급식정보] 학교코드: ${req.query.schul_code}`);
  try {
    const response = await axios.get('https://open.neis.go.kr/hub/mealServiceDietInfo', { params: { KEY: NEIS_API_KEY, Type: 'json', ATPT_OFCDC_SC_CODE: req.query.atpt_code, SD_SCHUL_CODE: req.query.schul_code, MLSV_YMD: req.query.date || getKstDateString() } });
    if (!response.data.mealServiceDietInfo) return res.json({ dishList: [], calories: "0 kcal" });
    const row = response.data.mealServiceDietInfo[1].row[0];
    res.json({ dishList: row.DDISH_NM.replace(/\(\d+(\.\d+)?\)/g, "").split(/<br\s*\/?>/i).map(v => v.trim()).filter(v => v.length > 0), calories: row.CAL_INFO || "0 kcal" });
  } catch (error) { res.json({ dishList: [], calories: "0 kcal" }); }
});

/* =================================================================
    [걸음 데이터 저장 & 프로필 실시간 역동기화 완료 완료]
   ================================================================= */
app.post('/api/steps', async (req, res) => {
  const data = req.body;
  if (!data.device_id) return res.status(400).json({ error: 'device_id가 누락' });
  const decodedId = decodeURIComponent(data.device_id);
  const currentTodayStr = getKstDateString();

  console.log(`[👣 걸음수 동기화] ID: ${decodedId} | 오늘걸음: ${data.steps_today} | 누적걸음: ${data.steps_total}`);

  try {
    let existing = await dbGet('SELECT * FROM users WHERE device_id = ? OR device_id = ?', [data.device_id, decodedId]);
    if (!existing) {
      existing = await dbGet('SELECT * FROM users WHERE schul_code = ? AND username = ?', [data.schul_code, data.username]);
    }

    let finalUsername = data.username;
    let finalGrade = data.grade;
    let finalClass = data.class_num;

    if (existing) {
      finalUsername = existing.username || data.username;
      finalGrade = existing.grade !== undefined ? existing.grade : data.grade;
      finalClass = existing.class_num !== undefined ? existing.class_num : data.class_num;
    }

    const dupUser = await dbGet(
      `SELECT device_id FROM users WHERE schul_code = ? AND grade = ? AND class_num = ? AND username = ? AND device_id != ? AND device_id != ?`,
      [data.schul_code, finalGrade, finalClass, finalUsername, data.device_id, decodedId]
    );
    if (dupUser) {
      console.log(`    └─ [❌ 사칭 차단] 실시간 동기화 거부됨 (${finalUsername})`);
      return res.status(403).json({ error: "IMPERSONATION_DETECTED", message: "🚨 이미 다른 기기에서 등록된 이름입니다. 사칭 방지를 위해 저장할 수 없습니다." });
    }

    const calculatedLevel = calculateLevel(data.steps_total || 0);
    let stepsTodayCalculated = data.steps_today || 0;
    let isCommutedCalculated = data.is_commuted || false;
    let commuteTimeCalculated = data.commute_time || '';
    let prevCommuteCount = existing ? (existing.commute_count || 0) : 0;
    const prevLevel = existing ? (existing.level || 0) : 0;
    const finalLevel = Math.max(prevLevel, calculatedLevel);

    if (existing && existing.last_saved_date !== currentTodayStr) {
      stepsTodayCalculated = 0; isCommutedCalculated = false; commuteTimeCalculated = '';
    }
    const newCommuteCount = Math.max(prevCommuteCount, parseInt(data.commute_count || 0, 10));

    if (existing) {
      await dbRun(`UPDATE users SET device_id=?, username=?, school=?, schul_code=?, atpt_code=?, school_kind=?, school_lat=?, school_lng=?, grade=?, class_num=?, steps_today=?, steps_total=?, is_commuted=?, commute_time=?, level=?, commute_count=?, last_saved_date=?, updatedAt=? WHERE device_id=?`,
        [decodedId, finalUsername, data.school, data.schul_code, data.atpt_code, data.school_kind, data.school_lat, data.school_lng, finalGrade, finalClass, stepsTodayCalculated, data.steps_total, isCommutedCalculated ? 1 : 0, commuteTimeCalculated, finalLevel, newCommuteCount, currentTodayStr, new Date().toISOString(), existing.device_id]);
      console.log(`    └─ [DB UPDATE] 기존 유저 정보 업데이트 성골`);
    } else {
      await dbRun(`INSERT INTO users (device_id, username, school, schul_code, atpt_code, school_kind, school_lat, school_lng, grade, class_num, steps_today, steps_total, is_commuted, commute_time, level, commute_count, last_saved_date, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [decodedId, finalUsername, data.school, data.schul_code, data.atpt_code, data.school_kind, data.school_lat, data.school_lng, finalGrade, finalClass, stepsTodayCalculated, data.steps_total, isCommutedCalculated ? 1 : 0, commuteTimeCalculated, finalLevel, newCommuteCount, currentTodayStr, new Date().toISOString()]);
      console.log(`    └─ [DB INSERT] 신규 유저 생성 성공`);
    }

    res.json({ 
      success: true, 
      server_date: currentTodayStr, 
      levelUp: finalLevel > prevLevel, 
      prevLevel, 
      currentLevel: finalLevel, 
      steps_today: stepsTodayCalculated, 
      steps_total: data.steps_total,
      sync_user: {
        username: finalUsername,
        grade: finalGrade,
        class_num: finalClass
      }
    });
  } catch (error) {
    console.error(`    └─ [💥 DB 처리 실패]:`, error);
    res.status(500).json({ error: '서버 데이터베이스 처리 실패' });
  }
});

/* 랭킹 로직 */
function formatRankList(list) {
  const currentTodayStr = getKstDateString();
  return list.map(u => {
    let safeId = u.device_id;
    try { safeId = decodeURIComponent(u.device_id); } catch(e) {}
    
    return {
      device_id: safeId, 
      username: u.username, grade: u.grade, class_num: u.class_num,
      steps_today: u.last_saved_date === currentTodayStr ? (u.steps_today || 0) : 0, 
      steps_total: u.steps_total || 0, level: u.level || calculateLevel(u.steps_total || 0), 
      commute_count: u.commute_count || 0,
      is_commuted: u.last_saved_date === currentTodayStr ? (u.is_commuted === 1) : false
    };
  });
}

app.get('/api/ranking/school/:schul_code', async (req, res) => {
  try { res.json(formatRankList(await dbAll('SELECT * FROM users WHERE schul_code = ? ORDER BY steps_total DESC, steps_today DESC LIMIT 100', [req.params.schul_code]))); } 
  catch (e) { res.status(500).json({ error: '조회 실패' }); }
});

app.get('/api/ranking/grade/:schul_code/:grade', async (req, res) => {
  try { res.json(formatRankList(await dbAll('SELECT * FROM users WHERE schul_code = ? AND CAST(grade AS TEXT) = CAST(? AS TEXT) ORDER BY steps_total DESC, steps_today DESC LIMIT 100', [req.params.schul_code, req.params.grade]))); } 
  catch (e) { res.status(500).json({ error: '조회 실패' }); }
});

app.get('/api/ranking/class/:schul_code/:grade/:class_num', async (req, res) => {
  try { res.json(formatRankList(await dbAll('SELECT * FROM users WHERE schul_code = ? AND CAST(grade AS TEXT) = CAST(? AS TEXT) AND CAST(class_num AS TEXT) = CAST(? AS TEXT) ORDER BY steps_total DESC, steps_today DESC LIMIT 100', [req.params.schul_code, req.params.grade, req.params.class_num]))); } 
  catch (e) { res.status(500).json({ error: '조회 실패' }); }
});

app.get('/api/my-rank/:schul_code/:device_id', async (req, res) => {
  try {
    const rawId = req.params.device_id;
    let decodedId = rawId;
    try { decodedId = decodeURIComponent(rawId); } catch(e) {}

    const sortedSchoolList = await dbAll('SELECT device_id FROM users WHERE schul_code = ? ORDER BY steps_total DESC, steps_today DESC', [req.params.schul_code]);
    
    const myIndex = sortedSchoolList.findIndex(u => {
      let dbId = u.device_id;
      try { dbId = decodeURIComponent(u.device_id); } catch(e) {}
      return dbId === rawId || dbId === decodedId;
    });
    
    res.json({ rank: myIndex === -1 ? null : myIndex + 1, total: sortedSchoolList.length });
  } catch (e) { res.status(500).json({ error: '내 순위 조회 실패' }); }
});

app.post('/api/admin/notify', async (req, res) => {
  const { title, content, type } = req.body;
  console.log(`[📢 알림 방송 발송] 제목: ${title} | 내용: ${content}`);
  try {
    const nowKst = new Date(Date.now() + (9 * 60 * 60 * 1000)).toISOString().replace('T', ' ').substring(0, 19);
    await dbRun('INSERT INTO notifications (title, content, type, createdAt) VALUES (?, ?, ?, ?)', [title, content, type || 'ADMIN_NOTICE', nowKst]);
    const payload = JSON.stringify({ type: 'NOTIFICATION', title, content, notiType: type });
    clients.forEach(client => client.write(`data: ${payload}\n\n`));
    res.json({ success: true });
  } catch (error) { res.status(500).json({ error: '알림 발송 실패' }); }
});

app.post(['/api/feedback', '/api/admin/feedback'], async (req, res) => {
  const { username, school, schul_code, grade, class_num, title, content } = req.body;
  console.log(`[📩 피드백 인입] [${school}] ${username}: ${content}`);
  if (!content) return res.status(400).json({ error: '피드백 내용이 없습니다.' });
  try {
    const derivedDeviceId = `USR_${schul_code || 'UNKNOWN'}_${grade || 0}_${class_num || 0}_${encodeURIComponent(username || '')}`;
    const nowKst = new Date(Date.now() + (9 * 60 * 60 * 1000)).toISOString().replace('T', ' ').substring(0, 19);
    await dbRun(
      `INSERT INTO feedbacks (device_id, username, school, schul_code, grade, class_num, title, content, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [derivedDeviceId, username || '익명', school || '', schul_code || '', grade || null, class_num || null, title || '일반 제보', content.trim(), nowKst]
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: '피드백 저장 실패' });
  }
});


/* =================================================================
    🛠️ 관리자 전용 API 라우터 
   ================================================================= */

app.get('/api/admin/users', async (req, res) => {
  const nameQuery = req.query.name || '';
  console.log(`[🛠️ 관리자] 유저 전체조회 쿼리: "${nameQuery}"`);
  try {
    const rows = await dbAll('SELECT * FROM users WHERE username LIKE ? ORDER BY steps_total DESC', [`%${nameQuery}%`]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: '유저 데이터베이스 조회 실패' });
  }
});

app.get('/api/admin/cheers', async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM cheers ORDER BY id DESC LIMIT 100');
    res.json({ success: true, list: rows });
  } catch (e) {
    res.status(500).json({ error: '전체 방명록 조회 실패' });
  }
});

delete app.delete('/api/admin/cheers/:id', async (req, res) => {
  console.log(`[🛠️ 관리자] 방명록 피드 삭제 요구 ID: ${req.params.id}`);
  try {
    await dbRun('DELETE FROM cheers WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '방명록 삭제 실패' });
  }
});

app.post('/api/admin/cheers', async (req, res) => {
  const { content, is_admin, username } = req.body;
  try {
    const nowKst = new Date(Date.now() + (9 * 60 * 60 * 1000)).toISOString().replace('T', ' ').substring(0, 19);
    await dbRun(`INSERT INTO cheers (schul_code, grade, class_num, username, content, is_admin, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['ALL', 0, 0, username || '운영자', content.trim(), is_admin ? 1 : 0, nowKst]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '운영자 방명록 등록 실패' });
  }
});

app.get('/api/admin/feedback', async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM feedbacks ORDER BY id DESC LIMIT 100');
    res.json({ success: true, list: rows });
  } catch (e) {
    res.status(500).json({ error: '피드백 목록 조회 실패' });
  }
});

app.delete('/api/admin/feedback/:id', async (req, res) => {
  console.log(`[🛠️ 관리자] 제보 피드백 삭제 요구 ID: ${req.params.id}`);
  try {
    await dbRun('DELETE FROM feedbacks WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '피드백 삭제 실패' });
  }
});

app.post('/api/admin/modify-steps', async (req, res) => {
  const { username, steps, schul_code } = req.body;
  console.log(`[🛠️ 관리자 강제 조작] 유저: ${username} -> 걸음수 변경: ${steps}`);
  try {
    await dbRun('UPDATE users SET steps_today = ? WHERE username = ? AND schul_code = ?', [steps, username, schul_code]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '걸음 수 수정 조작 실패' });
  }
});

app.post('/api/admin/modify-level', async (req, res) => {
  const { username, level, schul_code } = req.body;
  console.log(`[🛠️ 관리자 강제 조작] 유저: ${username} -> 레벨 변경: ${level}`);
  try {
    await dbRun('UPDATE users SET level = ? WHERE username = ? AND schul_code = ?', [level, username, schul_code]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '레벨 데이터 수정 조작 실패' });
  }
});

app.post('/api/admin/modify-profile', async (req, res) => {
  const { 
    current_username, 
    schul_code, 
    new_username, 
    new_grade, 
    new_class, 
    grade, 
    class_num 
  } = req.body;

  if (!current_username || !schul_code) {
    return res.status(400).json({ error: '식별 데이터(이름, 학교코드) 누락' });
  }

  const finalGrade = parseInt(new_grade !== undefined ? new_grade : grade, 10);
  const finalClass = parseInt(new_class !== undefined ? new_class : class_num, 10);
  const finalUsername = new_username ? new_username.trim() : current_username;

  try {
    const targetUser = await dbGet('SELECT device_id FROM users WHERE username = ? AND schul_code = ?', [current_username, schul_code]);
    if (!targetUser) {
      return res.status(404).json({ error: '프로필을 변경할 타겟 유저를 찾을 수 없습니다.' });
    }

    const nowIso = new Date().toISOString();
    await dbRun(
      `UPDATE users SET username = ?, grade = ?, class_num = ?, updatedAt = ? WHERE username = ? AND schul_code = ?`,
      [finalUsername, finalGrade, finalClass, nowIso, current_username, schul_code]
    );

    console.log(`[👤 프로필 변경 완료] 학교코드: ${schul_code} | 기존이름: ${current_username} -> 변경이름: ${finalUsername} (${finalGrade}학년 ${finalClass}반)`);
    res.json({ success: true });
  } catch (e) {
    console.error('❌ [관리자 프로필 수정 에러]:', e.message);
    res.status(500).json({ error: '서버 내부 DB 갱신 연동 실패' });
  }
});

app.post('/api/admin/toggle-role', async (req, res) => {
  const { username, schul_code } = req.body;
  try {
    const user = await dbGet(`SELECT is_admin FROM users WHERE username = ? AND schul_code = ?`, [username, schul_code]);
    if (!user) return res.status(404).json({ error: '해당 유저를 찾을 수 없습니다.' });

    const newStatus = user.is_admin ? 0 : 1;
    await dbRun(`UPDATE users SET is_admin = ? WHERE username = ? AND schul_code = ?`, [newStatus, username, schul_code]);
    console.log(`[🛠️ 관리자 권한 토글] 대상: ${username} -> 결과 어드민 여부: ${newStatus === 1}`);
    res.json({ success: true, is_admin: newStatus === 1 });
  } catch (e) {
    res.status(500).json({ error: '운영자 권한 변경 실패' });
  }
});

app.post('/api/admin/toggle-mute', async (req, res) => {
  const { username, schul_code } = req.body;
  try {
    const user = await dbGet(`SELECT is_muted FROM users WHERE username = ? AND schul_code = ?`, [username, schul_code]);
    if (!user) return res.status(404).json({ error: '해당 사용자를 조회할 수 없습니다.' });

    const newMuteStatus = user.is_muted ? 0 : 1;
    await dbRun(`UPDATE users SET is_muted = ? WHERE username = ? AND schul_code = ?`, [newMuteStatus, username, schul_code]);
    console.log(`[🛠️ 채팅 차단 토글] 대상: ${username} -> 뮤트 여부: ${newMuteStatus === 1}`);
    res.json({ success: true, is_muted: newMuteStatus === 1 });
  } catch (e) {
    res.status(500).json({ error: '개별 채팅 권한 토글 제어 실패' });
  }
});

app.get('/api/admin/banned-users', async (req, res) => {
  try {
    const rows = await dbAll('SELECT username, school, grade, class_num, schul_code, is_muted FROM users WHERE is_muted = 1 ORDER BY username ASC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: '잠금 상태 사용자 명단 조회 실패' });
  }
});

app.post('/api/admin/unban', async (req, res) => {
  const { username, schul_code } = req.body;
  try {
    await dbRun(`UPDATE users SET is_muted = 0 WHERE username = ? AND schul_code = ?`, [username, schul_code]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: '개별 권한 해제 실패' });
  }
});

/* =================================================================
    서버 구동부 (Render 환경 변수 자동 연동 반영)
   ================================================================= */
app.listen(PORT, '0.0.0.0', () => {
  // 🔄 Render가 발급해 준 전용 외부 URL 환경 변수를 가져옵니다. 없을 경우 로컬 호스트로 주소를 만듭니다.
  const currentRunningUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

  console.log(`=================================================`);
  console.log(` 등교 유도 앱 GreenStep 백엔드 서버 가동 중 `);
  console.log(` 외부 접속 주소: ${currentRunningUrl} `);
  console.log(`-------------------------------------------------`);
  console.log(` 🔐 [실시간 보안 관리자 인증코드 발급 안내] `);
  console.log(` 오늘의 최초 로그인 일회용 비밀번호: ${tempMasterCode} `);
  console.log(` (로그인 성공 시 실시간으로 새 비밀번호가 자동 갱신됩니다)`);
  console.log(`=================================================`);
});
