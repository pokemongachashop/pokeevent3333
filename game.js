/* =============================================================================
 * Pika Survival (피카 서바이벌) — game.js
 *
 * 하나의 파일 안에 아래 논리 모듈이 순서대로 들어 있습니다.
 *   1. 설정            2. 유틸리티         3. 캐릭터 데이터·렌더링   4. 아이템
 *   5. 맵·발판 데이터   6. 로컬 DB(연습)    7. 네트워크·인증          8. 방 상태·리스너
 *   9. 방 생성·참가·퇴장 10. 진행 로직(관리자 시작·붕괴·아이템·판정)  11. 입력
 *  12. 경기 화면(Phaser)  13. UI(메인·대기실·결과)                   14. 부팅
 *
 * 보안 참고: 브라우저 클라이언트가 직접 데이터베이스에 쓰는 구조이므로
 * 위치·탈락·우승 판정을 완전히 신뢰할 수 없고, 완벽한 동시성 제어와 치트 방지를
 * 보장하지 않습니다. 권위 있는 판정이 필요하면 별도 서버나 Cloud Functions가 필요합니다.
 * ========================================================================== */
(function () {
  'use strict';

  /* ===================================================================
   * 1. 설정
   * =================================================================== */

  // Firebase 콘솔 > 프로젝트 설정 > 일반 > 내 앱(웹 앱)의 SDK 설정값을 붙여 넣으세요.
  // 이 값은 웹 클라이언트용 "공개" 설정입니다. 데이터 보호는 Realtime Database 보안 규칙이 담당합니다.
  // 관리자 비밀키나 서비스 계정 키는 절대 이곳에 넣지 마세요.
  const FIREBASE_CONFIG = {
    apiKey: '',
    authDomain: '',
    databaseURL: '', // 예: https://프로젝트ID-default-rtdb.asia-southeast1.firebasedatabase.app
    projectId: '',
    storageBucket: '',
    messagingSenderId: '',
    appId: '',
  };

  // 관리자 계정 이메일. Firebase 콘솔 > Authentication > 사용자에서 이 이메일로 계정을 만들고 비밀번호를 정하세요.
  // 게임 화면에서는 비밀번호만 입력합니다. 보안 규칙(README 6번)에 적힌 이메일도 같은 값으로 바꿔야 합니다.
  // 방 만들기·맵 선택·경기 시작·재경기는 이 계정으로 로그인한 관리자만 할 수 있습니다.
  const ADMIN_EMAIL = 'admin@pika-survival.app';

  const CFG = {
    maxPlayers: 20,
    minPlayers: 2,
    nicknameMax: 12,
    codeLength: 6,
    countdownMs: 3500,
    matchMaxMs: 210000,      // 경기 최대 3분 30초. 시간 종료 시 생존자 공동 우승
    endConfirmMs: 600,       // 거의 동시에 떨어진 탈락을 모으기 위한 종료 대기 시간
    tieWindowMs: 300,        // 이 시간 안에 탈락한 플레이어는 같은 순위
    net: {
      sendIntervalMs: 120,   // 위치 전송 주기(100~200ms 사이에서 조정)
      minMoveDist: 2,        // 이보다 적게 움직이면 전송 생략
      interpDelayMs: 200,    // 원격 플레이어 보간 지연
      heartbeatMs: 10000,
      staleMs: 30000,        // 이 시간 동안 하트비트가 없으면 연결 끊김으로 간주
      requestTimeoutMs: 10000,
    },
    presence: { lobbyRemoveMs: 45000, matchDropMs: 8000 },
    player: {
      radius: 22, speed: 250, accel: 1900, decel: 2300, airControl: 0.8,
      jumpVz: 520, gravity: 1500, coyoteMs: 90, jumpBufferMs: 120,
      footTol: 6, fallMs: 800, knockDecay: 5.5, rescueMargin: 26,
    },
    collapse: {
      graceMs: 15000,         // 0~15초 적응 시간
      warnMs: 2600,           // 경고 후 붕괴까지
      keepMin: 2,             // 일반 단계에서 남겨 둘 붕괴 가능 발판 수
      jitter: 220,            // 외곽 우선 선택에 섞는 무작위성
      suddenDeathMs: 180000,  // 최종 단계: 중앙 안전 구역만 남김
      stages: [
        { from: 15000, every: 6500, count: 1, label: '붕괴 1단계' },
        { from: 60000, every: 5000, count: 2, label: '붕괴 2단계' },
        { from: 110000, every: 4000, count: 2, label: '붕괴 3단계' },
        { from: 150000, every: 3200, count: 3, label: '붕괴 4단계' },
      ],
    },
    items: {
      firstMs: 7000, everyMs: 6000, maxActive: 4, ttlMs: 18000,
      pickupRadius: 38, useCooldownMs: 1200,
      weights: { speed: 25, jump: 22, shield: 14, float: 20, shock: 19 },
    },
    world: { w: 1400, h: 950, cx: 700, cy: 475 },
    visual: { platformDepth: 22, charSize: 66, texSize: 128, itemTex: 96 },
  };

  const CX = CFG.world.cx;
  const CY = CFG.world.cy;

  const PLAYER_COLORS = [
    '#ff6b6b', '#ffd166', '#06d6a0', '#4cc9f0', '#b197fc', '#ff9f43', '#f783ac', '#69db7c', '#74c0fc', '#ffe066',
    '#e599f7', '#63e6be', '#ffa8a8', '#a9e34b', '#91a7ff', '#ffc078', '#66d9e8', '#faa2c1', '#c0eb75', '#d0bfff',
  ];

  /* ===================================================================
   * 2. 유틸리티
   * =================================================================== */
  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const str = (v, d = '') => (typeof v === 'string' ? v : d);
  const clone = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
  const hexNum = (h) => parseInt(String(h).slice(1, 7), 16);
  const toArr = (v) => (Array.isArray(v) ? v.filter((x) => x != null) : v && typeof v === 'object' ? Object.values(v) : []);

  class UserError extends Error {}

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const r = clamp((n >> 16) + amt, 0, 255);
    const g = clamp(((n >> 8) & 255) + amt, 0, 255);
    const b = clamp((n & 255) + amt, 0, 255);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtTime(ms) {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }
  function fmtSec(ms) { return `${(Math.max(0, ms) / 1000).toFixed(1)}초`; }
  function cleanNickname(s) {
    return String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, CFG.nicknameMax);
  }
  function randomId(n) {
    const A = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    const buf = new Uint32Array(n);
    crypto.getRandomValues(buf);
    for (let i = 0; i < n; i++) out += A[buf[i] % A.length];
    return out;
  }
  function genRoomCode() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const buf = new Uint32Array(CFG.codeLength);
    crypto.getRandomValues(buf);
    let out = '';
    for (let i = 0; i < CFG.codeLength; i++) out += A[buf[i] % A.length];
    return out;
  }
  function withTimeout(promise, ms, msg) {
    let t;
    return Promise.race([
      promise,
      new Promise((_, rej) => { t = setTimeout(() => rej(new UserError(msg)), ms); }),
    ]).finally(() => clearTimeout(t));
  }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function logError(ctx, err) {
    // 인증 토큰 같은 민감 정보는 출력하지 않고 원인 파악에 필요한 코드·메시지만 남깁니다.
    const detail = err ? (err.code ? `${err.code}: ${err.message || ''}` : err.message || String(err)) : '';
    console.error(`[PikaSurvival] ${ctx}`, detail);
  }
  function friendly(err) {
    if (!err) return '알 수 없는 오류가 발생했습니다.';
    if (err instanceof UserError) return err.message;
    const code = String(err.code || err.message || '').toLowerCase();
    if (code.includes('wrong-password') || code.includes('invalid-credential') || code.includes('invalid-login') || code.includes('user-not-found')) return '관리자 비밀번호가 올바르지 않습니다.';
    if (code.includes('too-many-requests')) return '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.';
    if (code.includes('permission')) return '권한이 거부되었습니다. Firebase 보안 규칙과 익명 로그인 설정을 확인하세요.';
    if (code.includes('operation-not-allowed')) return 'Firebase 콘솔에서 익명 로그인이 꺼져 있습니다. Authentication에서 익명 로그인을 사용 설정하세요.';
    if (code.includes('network')) return '네트워크 연결을 확인해 주세요.';
    if (code.includes('api-key') || code.includes('invalid-api')) return 'Firebase API 키가 올바르지 않습니다. game.js의 설정값을 확인하세요.';
    if (code.includes('disconnect')) return '서버와의 연결이 끊겼습니다.';
    return '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';
  }

  function toast(msg, kind = 'info', ms = 2600) {
    const box = $('toasts');
    if (!box) return;
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.textContent = msg;
    box.appendChild(el);
    while (box.children.length > 4) box.firstChild.remove();
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, ms);
  }
  function showFatal(msg) {
    $('fatal-msg').textContent = msg;
    $('fatal').hidden = false;
  }

  /* ===================================================================
   * 3. 캐릭터 데이터·렌더링
   * ---------------------------------------------------------------
   * imageUrl: 직접 사용할 권리가 있는 이미지 URL을 넣으면 그 이미지를 씁니다.
   *           비워 두거나 로딩에 실패하면 아래 look 설정으로 그린 임시 마스코트를 씁니다.
   *           임시 마스코트는 포켓몬 공식 디자인을 따라 그린 것이 아닌 범용 도형 캐릭터입니다.
   * 모든 캐릭터는 같은 속도·점프력·충돌 크기를 갖습니다(외형만 다름).
   * =================================================================== */
  const CHARACTERS = [
    { id: 'pikachu', name: '피카츄', imageUrl: '', look: { body: '#7fd8be', accent: '#ff8fa3', ears: 'round', tail: 'puff', extra: 'leaf' } },
    { id: 'eevee', name: '이브이', imageUrl: '', look: { body: '#ff9b85', accent: '#ffd36e', ears: 'tall', tail: 'curl', extra: 'none' } },
    { id: 'jigglypuff', name: '푸린', imageUrl: '', look: { body: '#8ec5ff', accent: '#ff9fc7', ears: 'none', tail: 'none', extra: 'antenna' } },
    { id: 'piplup', name: '팽도리', imageUrl: '', look: { body: '#b9a7f5', accent: '#ffd166', ears: 'cat', tail: 'ball', extra: 'star' } },
    { id: 'psyduck', name: '고라파덕', imageUrl: '', look: { body: '#b8e07a', accent: '#ff8fa3', ears: 'round', tail: 'none', extra: 'bow' } },
    { id: 'snorlax', name: '잠만보', imageUrl: '', look: { body: '#ffc49b', accent: '#f2789f', ears: 'tall', tail: 'puff', extra: 'none' } },
    { id: 'pawmi', name: '빠모', imageUrl: '', look: { body: '#5cc6c6', accent: '#ffe28a', ears: 'cat', tail: 'curl', extra: 'horn' } },
    { id: 'togepi', name: '토게피', imageUrl: '', look: { body: '#f7a1c4', accent: '#7fd8be', ears: 'none', tail: 'ball', extra: 'leaf' } },
    { id: 'rowlet', name: '나몰빼미', imageUrl: '', look: { body: '#e6c88f', accent: '#ff9b85', ears: 'round', tail: 'puff', extra: 'antenna' } },
    { id: 'fuecoco', name: '뜨아거', imageUrl: '', look: { body: '#9aa9c9', accent: '#ffb3c6', ears: 'cat', tail: 'none', extra: 'bow' } },
    { id: 'gengar', name: '팬텀', imageUrl: '', look: { body: '#f6dd6b', accent: '#ff8f6b', ears: 'tall', tail: 'ball', extra: 'star' } },
    { id: 'mimikyu', name: '따라큐', imageUrl: '', look: { body: '#ffb347', accent: '#b9a7f5', ears: 'none', tail: 'curl', extra: 'horn' } },
  ].map((c) => ({
    ...c,
    selectable: true,
    size: 1,                                  // 표시 배율(충돌 크기에는 영향 없음)
    preview: { mood: 'happy' },               // 선택 화면 미리 보기 표정
    anim: { bob: 1, runBounce: 5 },           // 애니메이션 세기
  }));
  const CHAR_IDS = CHARACTERS.map((c) => c.id);
  const DEFAULT_CHAR = 'pikachu';
  const MOODS = ['normal', 'happy', 'hurt'];
  const charById = (id) => CHARACTERS.find((c) => c.id === id) || CHARACTERS[0];

  function ellipsePath(ctx, x, y, rx, ry, rot = 0) {
    ctx.beginPath();
    ctx.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), rot, 0, Math.PI * 2);
  }
  function fillStroke(ctx, fill) { ctx.fillStyle = fill; ctx.fill(); ctx.stroke(); }
  function starPath(ctx, x, y, R, r) {
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const rr = i % 2 ? r : R;
      ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
  }

  function drawCreature(ctx, look, S, mood) {
    const body = look.body;
    const acc = look.accent;
    const line = shade(body, -95);
    const cx = S * 0.5, cy = S * 0.6, rx = S * 0.31, ry = S * 0.28;
    const LW = S * 0.034;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = LW;
    ctx.strokeStyle = line;

    // 꼬리
    if (look.tail === 'puff') {
      ellipsePath(ctx, cx + rx * 0.98, cy + ry * 0.12, S * 0.11, S * 0.1);
      fillStroke(ctx, shade(body, 28));
    } else if (look.tail === 'curl') {
      ctx.beginPath();
      ctx.moveTo(cx + rx * 0.8, cy + ry * 0.35);
      ctx.quadraticCurveTo(cx + rx * 1.55, cy + ry * 0.3, cx + rx * 1.3, cy - ry * 0.45);
      ctx.lineWidth = S * 0.075; ctx.strokeStyle = line; ctx.stroke();
      ctx.lineWidth = S * 0.04; ctx.strokeStyle = shade(body, 12); ctx.stroke();
      ctx.lineWidth = LW; ctx.strokeStyle = line;
    } else if (look.tail === 'ball') {
      ctx.beginPath();
      ctx.moveTo(cx + rx * 0.85, cy + ry * 0.2);
      ctx.lineTo(cx + rx * 1.2, cy - ry * 0.1);
      ctx.stroke();
      ellipsePath(ctx, cx + rx * 1.25, cy - ry * 0.18, S * 0.06, S * 0.06);
      fillStroke(ctx, acc);
    }

    // 귀
    for (const s of [-1, 1]) {
      if (look.ears === 'round') {
        ellipsePath(ctx, cx + s * rx * 0.62, cy - ry * 0.9, S * 0.095, S * 0.095);
        fillStroke(ctx, body);
        ellipsePath(ctx, cx + s * rx * 0.62, cy - ry * 0.9, S * 0.05, S * 0.05);
        ctx.globalAlpha = 0.7; ctx.fillStyle = acc; ctx.fill(); ctx.globalAlpha = 1;
      } else if (look.ears === 'tall') {
        ellipsePath(ctx, cx + s * rx * 0.48, cy - ry * 1.12, S * 0.06, S * 0.15, s * 0.32);
        fillStroke(ctx, body);
        ellipsePath(ctx, cx + s * rx * 0.48, cy - ry * 1.1, S * 0.028, S * 0.09, s * 0.32);
        ctx.globalAlpha = 0.65; ctx.fillStyle = acc; ctx.fill(); ctx.globalAlpha = 1;
      } else if (look.ears === 'cat') {
        ctx.beginPath();
        ctx.moveTo(cx + s * rx * 0.92, cy - ry * 0.45);
        ctx.lineTo(cx + s * rx * 0.7, cy - ry * 1.3);
        ctx.lineTo(cx + s * rx * 0.22, cy - ry * 0.86);
        ctx.closePath();
        fillStroke(ctx, body);
      }
    }

    // 발
    for (const s of [-1, 1]) {
      ellipsePath(ctx, cx + s * rx * 0.45, cy + ry * 0.93, S * 0.075, S * 0.045);
      fillStroke(ctx, shade(body, -18));
    }

    // 몸통
    ellipsePath(ctx, cx, cy, rx, ry);
    fillStroke(ctx, body);
    const g = ctx.createRadialGradient(cx - rx * 0.35, cy - ry * 0.45, S * 0.02, cx, cy, rx * 1.1);
    g.addColorStop(0, 'rgba(255,255,255,0.5)');
    g.addColorStop(0.5, 'rgba(255,255,255,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.12)');
    ellipsePath(ctx, cx, cy, rx - LW / 2, ry - LW / 2);
    ctx.fillStyle = g; ctx.fill();

    // 배
    ellipsePath(ctx, cx, cy + ry * 0.4, rx * 0.52, ry * 0.42);
    ctx.globalAlpha = 0.85; ctx.fillStyle = shade(body, 55); ctx.fill(); ctx.globalAlpha = 1;

    // 머리 장식
    if (look.extra === 'leaf') {
      ctx.beginPath();
      ctx.moveTo(cx, cy - ry * 0.95);
      ctx.quadraticCurveTo(cx + S * 0.13, cy - ry * 1.45, cx + S * 0.02, cy - ry * 1.55);
      ctx.quadraticCurveTo(cx - S * 0.07, cy - ry * 1.2, cx, cy - ry * 0.95);
      fillStroke(ctx, '#62c370');
    } else if (look.extra === 'antenna') {
      ctx.beginPath();
      ctx.moveTo(cx, cy - ry * 0.97);
      ctx.lineTo(cx + S * 0.05, cy - ry * 1.42);
      ctx.stroke();
      ellipsePath(ctx, cx + S * 0.05, cy - ry * 1.47, S * 0.045, S * 0.045);
      fillStroke(ctx, acc);
    } else if (look.extra === 'star') {
      starPath(ctx, cx + rx * 0.42, cy - ry * 0.8, S * 0.075, S * 0.035);
      fillStroke(ctx, acc);
    } else if (look.extra === 'bow') {
      const kx = cx - rx * 0.42, ky = cy - ry * 0.84;
      for (const s of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(kx, ky);
        ctx.lineTo(kx + s * S * 0.11, ky - S * 0.06);
        ctx.lineTo(kx + s * S * 0.1, ky + S * 0.07);
        ctx.closePath();
        fillStroke(ctx, acc);
      }
      ellipsePath(ctx, kx, ky, S * 0.025, S * 0.025);
      fillStroke(ctx, shade(acc, -30));
    } else if (look.extra === 'horn') {
      ctx.beginPath();
      ctx.moveTo(cx - S * 0.045, cy - ry * 0.95);
      ctx.lineTo(cx, cy - ry * 1.4);
      ctx.lineTo(cx + S * 0.045, cy - ry * 0.95);
      ctx.closePath();
      fillStroke(ctx, '#fff3c4');
    }

    // 얼굴
    const ey = cy - ry * 0.1;
    const ex = rx * 0.36;
    const ink = '#2b2340';
    ctx.strokeStyle = ink;
    for (const s of [-1, 1]) {
      const x = cx + s * ex;
      if (mood === 'happy') {
        ctx.lineWidth = S * 0.03;
        ctx.beginPath();
        ctx.arc(x, ey + S * 0.018, S * 0.036, Math.PI * 1.12, Math.PI * 1.88);
        ctx.stroke();
      } else if (mood === 'hurt') {
        ctx.lineWidth = S * 0.028;
        ctx.beginPath();
        ctx.moveTo(x - s * S * 0.03, ey - S * 0.03);
        ctx.lineTo(x + s * S * 0.03, ey);
        ctx.lineTo(x - s * S * 0.03, ey + S * 0.03);
        ctx.stroke();
      } else {
        ellipsePath(ctx, x, ey, S * 0.04, S * 0.052);
        ctx.fillStyle = ink; ctx.fill();
        ellipsePath(ctx, x - S * 0.012, ey - S * 0.02, S * 0.014, S * 0.014);
        ctx.fillStyle = '#ffffff'; ctx.fill();
      }
      ellipsePath(ctx, cx + s * rx * 0.62, cy + ry * 0.2, S * 0.055, S * 0.035);
      ctx.globalAlpha = 0.55; ctx.fillStyle = acc; ctx.fill(); ctx.globalAlpha = 1;
    }
    const my = cy + ry * 0.14;
    ctx.lineWidth = S * 0.022;
    if (mood === 'happy') {
      ctx.beginPath();
      ctx.moveTo(cx - S * 0.042, my - S * 0.006);
      ctx.quadraticCurveTo(cx, my + S * 0.075, cx + S * 0.042, my - S * 0.006);
      ctx.closePath();
      ctx.fillStyle = '#b9475a'; ctx.fill(); ctx.stroke();
    } else if (mood === 'hurt') {
      ellipsePath(ctx, cx, my + S * 0.012, S * 0.022, S * 0.026);
      ctx.fillStyle = '#b9475a'; ctx.fill(); ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(cx - S * 0.035, my);
      ctx.quadraticCurveTo(cx - S * 0.0175, my + S * 0.03, cx, my);
      ctx.quadraticCurveTo(cx + S * 0.0175, my + S * 0.03, cx + S * 0.035, my);
      ctx.stroke();
    }
    ctx.restore();
  }

  const charCanvasCache = new Map();
  const charUrlCache = new Map();
  function charCanvas(id, mood = 'normal') {
    const key = `${id}:${mood}`;
    if (charCanvasCache.has(key)) return charCanvasCache.get(key);
    const S = CFG.visual.texSize;
    const c = document.createElement('canvas');
    c.width = S; c.height = S;
    drawCreature(c.getContext('2d'), charById(id).look, S, mood);
    charCanvasCache.set(key, c);
    return c;
  }
  function charDataUrl(id, mood = 'normal') {
    const key = `${id}:${mood}`;
    if (!charUrlCache.has(key)) charUrlCache.set(key, charCanvas(id, mood).toDataURL('image/png'));
    return charUrlCache.get(key);
  }
  // 이미지 URL이 있으면 우선 사용하고, 실패하면 대체 렌더링으로 바꿉니다.
  function charImg(id, mood = 'normal', cls = '') {
    const c = charById(id);
    const img = new Image();
    img.alt = c.name;
    img.draggable = false;
    if (cls) img.className = cls;
    const fallback = charDataUrl(c.id, mood);
    if (c.imageUrl) {
      img.onerror = () => { img.onerror = null; img.src = fallback; };
      img.src = c.imageUrl;
    } else {
      img.src = fallback;
    }
    return img;
  }

  /* ===================================================================
   * 4. 아이템
   * =================================================================== */
  const ITEMS = {
    speed: { name: '속도 부스트', color: '#ff9f43', durMs: 6000, mul: 1.45, code: 'S' },
    jump: { name: '점프 강화', color: '#38b6e8', durMs: 7000, mul: 1.28, code: 'J' },
    shield: { name: '보호막', color: '#7b6cf6', durMs: 9000, code: 'H' },  // 1회 낙하 방지 또는 시간 만료
    float: { name: '공중 체공', color: '#3cc48a', durMs: 5000, gravMul: 0.35, code: 'F' },
    shock: { name: '충격파', color: '#ff5d73', radius: 190, force: 760, hop: 300 },
  };
  const ITEM_TYPES = Object.keys(ITEMS);
  const EFFECT_TYPES = ['speed', 'jump', 'shield', 'float'];

  function drawItemIcon(ctx, type, S) {
    const def = ITEMS[type];
    const c = S / 2, r = S * 0.42, u = S * 0.12;
    ctx.save();
    ctx.clearRect(0, 0, S, S);
    ctx.beginPath(); ctx.arc(c, c + S * 0.02, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fill();
    ctx.beginPath(); ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.fillStyle = def.color; ctx.fill();
    ctx.lineWidth = S * 0.06; ctx.strokeStyle = '#ffffff'; ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff';
    ctx.lineWidth = S * 0.08; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    if (type === 'speed') {
      for (const dx of [-u * 0.8, u * 0.7]) {
        ctx.moveTo(c + dx - u * 0.6, c - u * 1.2);
        ctx.lineTo(c + dx + u * 0.6, c);
        ctx.lineTo(c + dx - u * 0.6, c + u * 1.2);
      }
      ctx.stroke();
    } else if (type === 'jump') {
      ctx.moveTo(c, c + u * 1.5); ctx.lineTo(c, c - u * 1.3);
      ctx.moveTo(c - u * 1.1, c - u * 0.2); ctx.lineTo(c, c - u * 1.4); ctx.lineTo(c + u * 1.1, c - u * 0.2);
      ctx.stroke();
    } else if (type === 'shield') {
      ctx.moveTo(c, c - u * 1.6);
      ctx.lineTo(c + u * 1.3, c - u * 1.0);
      ctx.quadraticCurveTo(c + u * 1.2, c + u * 1.0, c, c + u * 1.7);
      ctx.quadraticCurveTo(c - u * 1.2, c + u * 1.0, c - u * 1.3, c - u * 1.0);
      ctx.closePath();
      ctx.fill();
    } else if (type === 'float') {
      ctx.ellipse(c, c - u * 0.4, u * 1.05, u * 1.3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.lineWidth = S * 0.04;
      ctx.moveTo(c, c + u * 0.9);
      ctx.quadraticCurveTo(c - u * 0.6, c + u * 1.3, c, c + u * 1.8);
      ctx.stroke();
    } else if (type === 'shock') {
      ctx.arc(c, c, u * 0.45, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = S * 0.055;
      ctx.beginPath(); ctx.arc(c, c, u * 1.0, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(c, c, u * 1.6, -0.6, 0.6); ctx.stroke();
      ctx.beginPath(); ctx.arc(c, c, u * 1.6, Math.PI - 0.6, Math.PI + 0.6); ctx.stroke();
    }
    ctx.restore();
  }
  const itemCanvasCache = new Map();
  function itemCanvas(type) {
    if (!itemCanvasCache.has(type)) {
      const S = CFG.visual.itemTex;
      const c = document.createElement('canvas');
      c.width = S; c.height = S;
      drawItemIcon(c.getContext('2d'), type, S);
      itemCanvasCache.set(type, c);
    }
    return itemCanvasCache.get(type);
  }
  function pickItemType() {
    const w = CFG.items.weights;
    const total = ITEM_TYPES.reduce((s, t) => s + (w[t] || 0), 0);
    let r = Math.random() * total;
    for (const t of ITEM_TYPES) { r -= w[t] || 0; if (r <= 0) return t; }
    return 'speed';
  }

  /* ===================================================================
   * 5. 맵·발판 데이터
   * ---------------------------------------------------------------
   * 발판: { id, shape:'rect'|'circle', x, y, w, h | r, collapsible, color?, prio? }
   * collapsible=false 인 발판은 최종 안전 구역(붕괴하지 않음).
   * physics: accel/decel/maxMul 로 맵별 이동감(얼음 미끄러짐 등)을 조정합니다.
   * =================================================================== */
  const rect = (id, x, y, w, h, collapsible = true, extra = {}) => ({ id, shape: 'rect', x, y, w, h, collapsible, ...extra });
  const circ = (id, x, y, r, collapsible = true, extra = {}) => ({ id, shape: 'circle', x, y, r, collapsible, ...extra });

  function buildMeadow() {
    const P = [], spots = [];
    const cols = 7, rows = 5, s = 140, g = 8;
    const ox = CX - ((cols - 1) * (s + g)) / 2;
    const oy = CY - ((rows - 1) * (s + g)) / 2;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const core = r === 2 && c === 3;
        const x = ox + c * (s + g), y = oy + r * (s + g);
        P.push(rect(`m${r}${c}`, x, y, s, s, !core));
        if (!core) spots.push({ x, y });
      }
    }
    return { platforms: P, itemSpots: spots };
  }
  function buildIce() {
    const P = [circ('i0', CX, CY, 150, false)];
    const spots = [{ x: CX - 80, y: CY }, { x: CX + 80, y: CY }];
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3;
      const x = Math.round(CX + Math.cos(a) * 300), y = Math.round(CY + Math.sin(a) * 300);
      P.push(circ(`i1${k}`, x, y, 95));
      spots.push({ x, y });
    }
    [[1260, 475, 85], [140, 475, 85], [1150, 215, 80], [1150, 735, 80], [250, 215, 80], [250, 735, 80]].forEach(([x, y, r], k) => {
      P.push(circ(`i2${k}`, x, y, r));
      spots.push({ x, y });
    });
    return { platforms: P, itemSpots: spots };
  }
  function buildCloud() {
    const P = [], spots = [];
    const ys = [155, 315, 475, 635, 795];
    ys.forEach((y, ri) => {
      const xs = ri % 2 === 0 ? [300, 500, 700, 900, 1100] : [200, 400, 600, 800, 1000, 1200];
      xs.forEach((x, ci) => {
        const core = ri === 2 && x === 700;
        P.push(circ(`c${ri}${ci}`, x, y, core ? 110 : 70, !core));
        if (!core) spots.push({ x, y });
      });
    });
    return { platforms: P, itemSpots: spots };
  }
  function buildToy() {
    const pal = ['#ff6b6b', '#ffd166', '#4ecdc4', '#5c7cfa', '#ff9f43', '#b197fc'];
    const B = { prio: 120, bridge: true }; // 통로는 조금 더 일찍 무너짐
    const P = [
      rect('tC', 700, 475, 300, 240, false, { color: pal[1] }),
      rect('tN', 700, 150, 220, 120, true, { color: pal[2] }),
      rect('tS', 700, 800, 220, 120, true, { color: pal[3] }),
      rect('tW', 230, 475, 200, 220, true, { color: pal[0] }),
      rect('tE', 1170, 475, 200, 220, true, { color: pal[4] }),
      rect('bN', 700, 282.5, 60, 145, true, { color: pal[5], ...B }),
      rect('bS', 700, 667.5, 60, 145, true, { color: pal[5], ...B }),
      rect('bW', 440, 475, 220, 60, true, { color: pal[5], ...B }),
      rect('bE', 960, 475, 220, 60, true, { color: pal[5], ...B }),
      rect('kNW', 300, 200, 200, 150, true, { color: pal[3] }),
      rect('kNE', 1100, 200, 200, 150, true, { color: pal[0] }),
      rect('kSW', 300, 750, 200, 150, true, { color: pal[4] }),
      rect('kSE', 1100, 750, 200, 150, true, { color: pal[2] }),
      rect('bNW1', 495, 170, 190, 50, true, { color: pal[1], ...B }),
      rect('bNE1', 905, 170, 190, 50, true, { color: pal[1], ...B }),
      rect('bSW1', 495, 780, 190, 50, true, { color: pal[1], ...B }),
      rect('bSE1', 905, 780, 190, 50, true, { color: pal[1], ...B }),
      rect('bNW2', 280, 320, 50, 90, true, { color: pal[1], ...B }),
      rect('bNE2', 1120, 320, 50, 90, true, { color: pal[1], ...B }),
      rect('bSW2', 280, 630, 50, 90, true, { color: pal[1], ...B }),
      rect('bSE2', 1120, 630, 50, 90, true, { color: pal[1], ...B }),
      rect('s1', 480, 330, 70, 70, true, { color: pal[2] }),
      rect('s2', 920, 330, 70, 70, true, { color: pal[0] }),
      rect('s3', 480, 620, 70, 70, true, { color: pal[3] }),
      rect('s4', 920, 620, 70, 70, true, { color: pal[4] }),
    ];
    const spots = ['tN', 'tS', 'tW', 'tE', 'kNW', 'kNE', 'kSW', 'kSE', 's1', 's2', 's3', 's4']
      .map((id) => P.find((p) => p.id === id)).map((p) => ({ x: p.x, y: p.y }));
    return { platforms: P, itemSpots: spots };
  }

  const MAP_DEFS = {
    meadow: {
      name: '초원 발판', desc: '넓은 정사각형 발판 · 입문용',
      theme: { void: '#7cc4f0', top: '#8bd06a', top2: '#a3dd82', side: '#9c6b45', edge: '#6aae4d', style: 'grass' },
      physics: { accel: 1900, decel: 2300, maxMul: 1 },
      build: buildMeadow,
    },
    ice: {
      name: '얼음 섬', desc: '미끄러운 얼음 · 방향 전환 주의',
      theme: { void: '#1f4f7c', top: '#e3f5ff', top2: '#c4e7fb', side: '#6fb2d9', edge: '#a6d9f3', style: 'ice' },
      physics: { accel: 520, decel: 230, maxMul: 1.08 },
      build: buildIce,
    },
    cloud: {
      name: '구름 위 경기장', desc: '작은 구름 · 점프 타이밍 중요',
      theme: { void: '#8fb0ff', top: '#ffffff', top2: '#eef2ff', side: '#c3cdee', edge: '#dfe6fb', style: 'cloud' },
      physics: { accel: 1700, decel: 2000, maxMul: 1 },
      build: buildCloud,
    },
    toy: {
      name: '장난감 블록', desc: '좁은 통로 · 여러 갈래 아이템 길',
      theme: { void: '#2c2550', top: '#ffd166', top2: '#ffffff', side: '#8a6a2a', edge: '#ffffff', style: 'toy' },
      physics: { accel: 1900, decel: 2300, maxMul: 1 },
      build: buildToy,
    },
  };
  const MAP_LIST = Object.keys(MAP_DEFS);
  const mapCache = {};
  function getMap(id) {
    const d = MAP_DEFS[id];
    if (!d) return null;
    if (!mapCache[id]) {
      const b = d.build();
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of b.platforms) {
        const hw = p.shape === 'circle' ? p.r : p.w / 2;
        const hh = p.shape === 'circle' ? p.r : p.h / 2;
        x0 = Math.min(x0, p.x - hw); x1 = Math.max(x1, p.x + hw);
        y0 = Math.min(y0, p.y - hh); y1 = Math.max(y1, p.y + hh + CFG.visual.platformDepth);
      }
      const pad = 60;
      mapCache[id] = {
        id, ...d, platforms: b.platforms, itemSpots: b.itemSpots,
        byId: new Map(b.platforms.map((p) => [p.id, p])),
        bounds: { x: x0 - pad, y: y0 - pad - 40, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 + 40 },
      };
    }
    return mapCache[id];
  }
  function platformContains(p, x, y, tol = 0) {
    if (p.shape === 'circle') {
      const dx = x - p.x, dy = y - p.y, r = p.r + tol;
      return dx * dx + dy * dy <= r * r;
    }
    return Math.abs(x - p.x) <= p.w / 2 + tol && Math.abs(y - p.y) <= p.h / 2 + tol;
  }
  const platformSize = (p) => (p.shape === 'circle' ? p.r * 2 : Math.min(p.w, p.h));
  function pointInPlatform(p, k) {
    if (k === 0) return { x: Math.round(p.x), y: Math.round(p.y) };
    const a = k * 2.39996;
    const rad = Math.max(0, platformSize(p) / 2 - 34) * (k % 2 ? 1 : 0.6);
    return { x: Math.round(p.x + Math.cos(a) * rad), y: Math.round(p.y + Math.sin(a) * rad) };
  }
  function computeSpawns(map, n) {
    const big = map.platforms.filter((p) => platformSize(p) >= 110);
    const order = big.slice().sort(() => Math.random() - 0.5);
    const out = [];
    for (let i = 0; i < n; i++) out.push(pointInPlatform(order[i % order.length], Math.floor(i / order.length)));
    return out;
  }

  /* 붕괴 정보(웨이브)는 진행 담당만 기록하고, 모든 클라이언트가 같은 기록으로 발판 상태를 계산합니다. */
  let waveCache = { ver: -1, mid: null, map: new Map(), sd: false, last: -Infinity };
  function waveInfo(mid) {
    if (waveCache.ver === room.wavesVer && waveCache.mid === mid) return waveCache;
    const m = new Map();
    let sd = false, last = -Infinity;
    for (const w of Object.values(room.waves)) {
      if (!w || w.mid !== mid) continue;
      const at = num(w.at, NaN);
      if (!Number.isFinite(at)) continue;
      if (w.sd) sd = true;
      last = Math.max(last, at);
      for (const id of toArr(w.ids)) {
        if (typeof id !== 'string') continue;
        m.set(id, m.has(id) ? Math.min(m.get(id), at) : at);
      }
    }
    waveCache = { ver: room.wavesVer, mid, map: m, sd, last };
    return waveCache;
  }
  function platformState(pid, wi, now) {
    const at = wi.map.get(pid);
    if (at === undefined || now < at) return 'normal';
    if (now < at + CFG.collapse.warnMs) return 'warn';
    return 'gone';
  }
  function stageInfo(elapsed) {
    if (elapsed < CFG.collapse.graceMs) return { idx: 0, label: '적응 시간', stage: null };
    if (elapsed >= CFG.collapse.suddenDeathMs) return { idx: 99, label: '최종 단계', stage: null };
    let idx = 0, stage = CFG.collapse.stages[0];
    CFG.collapse.stages.forEach((s, i) => { if (elapsed >= s.from) { idx = i + 1; stage = s; } });
    return { idx, label: stage.label, stage };
  }

  /* ===================================================================
   * 6. 로컬 DB (혼자 연습하기 모드 전용)
   * ---------------------------------------------------------------
   * Firebase Realtime Database의 사용 부분과 같은 인터페이스를 메모리에서 흉내 냅니다.
   * 온라인 멀티플레이를 대체하지 않으며, 같은 게임 코드를 오프라인에서 실행하기 위한 것입니다.
   * =================================================================== */
  const splitPath = (p) => String(p || '').split('/').filter(Boolean);
  function normalizeValue(v) {
    if (v === undefined || v === null) return null;
    if (typeof v === 'object' && !Array.isArray(v) && v['.sv'] === 'timestamp') return Date.now();
    if (typeof v === 'object') {
      const out = Array.isArray(v) ? [] : {};
      for (const [k, val] of Object.entries(v)) {
        const n = normalizeValue(val);
        if (n !== null) out[k] = n;
      }
      return Object.keys(out).length ? out : null;
    }
    return v;
  }
  function makeSnap(key, val) {
    const v = val === undefined ? null : val;
    return { key, val: () => clone(v), exists: () => v !== null };
  }
  class LocalDB {
    constructor() { this.root = {}; this.subs = []; this.seq = 0; }
    ref(path) { return new LocalRef(this, splitPath(path)); }
    get(parts) {
      let n = this.root;
      for (const k of parts) {
        if (n === null || typeof n !== 'object' || !(k in n)) return null;
        n = n[k];
      }
      return n === undefined ? null : n;
    }
    apply(parts, value) {
      const v = normalizeValue(value);
      if (!parts.length) { this.root = v && typeof v === 'object' ? clone(v) : {}; return; }
      let n = this.root;
      const stack = [];
      for (let i = 0; i < parts.length - 1; i++) {
        const k = parts[i];
        if (n[k] === null || typeof n[k] !== 'object') { if (v === null) return; n[k] = {}; }
        stack.push([n, k]);
        n = n[k];
      }
      const last = parts[parts.length - 1];
      if (v === null) delete n[last]; else n[last] = clone(v);
      for (let i = stack.length - 1; i >= 0; i--) {
        const [p, k] = stack[i];
        if (p[k] && typeof p[k] === 'object' && !Object.keys(p[k]).length) delete p[k]; else break;
      }
    }
    write(ops) {
      const pairs = this.subs.map((s) => ({ s, before: clone(this.get(s.parts)) }));
      ops.forEach(([parts, v]) => this.apply(parts, v));
      for (const { s, before } of pairs) {
        if (!this.subs.includes(s)) continue;
        const after = this.get(s.parts);
        if (JSON.stringify(before) === JSON.stringify(after)) continue;
        this.dispatch(s, before, after);
      }
    }
    dispatch(s, before, after) {
      try {
        if (s.ev === 'value') { s.cb(makeSnap(s.parts[s.parts.length - 1] || null, after)); return; }
        const b = before && typeof before === 'object' ? before : {};
        const a = after && typeof after === 'object' ? after : {};
        if (s.ev === 'child_added') Object.keys(a).sort().forEach((k) => { if (!(k in b)) s.cb(makeSnap(k, a[k])); });
        if (s.ev === 'child_changed') Object.keys(a).sort().forEach((k) => { if (k in b && JSON.stringify(a[k]) !== JSON.stringify(b[k])) s.cb(makeSnap(k, a[k])); });
        if (s.ev === 'child_removed') Object.keys(b).sort().forEach((k) => { if (!(k in a)) s.cb(makeSnap(k, b[k])); });
      } catch (e) { logError('local listener', e); }
    }
    subscribe(parts, ev, cb) {
      if (parts[0] === '.info') {
        const v = parts[1] === 'connected' ? true : parts[1] === 'serverTimeOffset' ? 0 : null;
        queueMicrotask(() => cb(makeSnap(parts[1], v)));
        return;
      }
      const s = { parts, ev, cb };
      this.subs.push(s);
      queueMicrotask(() => {
        if (!this.subs.includes(s)) return;
        const cur = this.get(parts);
        if (ev === 'value') s.cb(makeSnap(parts[parts.length - 1] || null, cur));
        else if (ev === 'child_added' && cur && typeof cur === 'object') Object.keys(cur).sort().forEach((k) => s.cb(makeSnap(k, cur[k])));
      });
    }
    unsubscribe(parts, ev, cb) {
      const key = parts.join('/');
      this.subs = this.subs.filter((s) => !(s.parts.join('/') === key && (!ev || s.ev === ev) && (!cb || s.cb === cb)));
    }
    pushKey() {
      this.seq += 1;
      return '-' + Date.now().toString(36).padStart(9, '0') + this.seq.toString(36).padStart(4, '0') + randomId(4);
    }
  }
  class LocalRef {
    constructor(db, parts) { this.db = db; this.parts = parts; this.key = parts.length ? parts[parts.length - 1] : null; }
    child(p) { return new LocalRef(this.db, this.parts.concat(splitPath(p))); }
    push(val) {
      const r = this.child(this.db.pushKey());
      const p = val === undefined ? Promise.resolve() : r.set(val);
      r.then = p.then.bind(p);
      r.catch = p.catch.bind(p);
      return r;
    }
    set(v) { this.db.write([[this.parts, v]]); return Promise.resolve(); }
    update(obj) {
      this.db.write(Object.entries(obj).map(([k, v]) => [this.parts.concat(splitPath(k)), v]));
      return Promise.resolve();
    }
    remove() { return this.set(null); }
    once() { return Promise.resolve(makeSnap(this.key, clone(this.db.get(this.parts)))); }
    on(ev, cb) { this.db.subscribe(this.parts, ev, cb); return cb; }
    off(ev, cb) { this.db.unsubscribe(this.parts, ev, cb); }
    transaction(fn) {
      const cur = clone(this.db.get(this.parts));
      const res = fn(cur);
      if (res === undefined) return Promise.resolve({ committed: false, snapshot: makeSnap(this.key, cur) });
      this.set(res);
      return Promise.resolve({ committed: true, snapshot: makeSnap(this.key, clone(this.db.get(this.parts))) });
    }
    onDisconnect() {
      const ok = () => Promise.resolve();
      return { set: ok, update: ok, remove: ok, cancel: ok };
    }
  }

  /* ===================================================================
   * 7. 네트워크·인증
   * =================================================================== */
  const Net = {
    mode: 'none',          // 'firebase' | 'local'
    db: null, uid: null, offset: 0, connected: false,
    fb: null, fbUid: null, fbOffset: 0, isAdminAccount: false, fbConnected: false, fbReady: false, fbEverConnected: false,
    ref(p) { return this.db.ref(p); },
    now() { return Date.now() + this.offset; },
    serverTs() { return this.mode === 'firebase' ? firebase.database.ServerValue.TIMESTAMP : Date.now(); },
    useFirebase() {
      this.mode = 'firebase'; this.db = this.fb.db; this.uid = this.fbUid;
      this.offset = this.fbOffset; this.connected = this.fbConnected;
    },
    useLocal() {
      this.mode = 'local'; this.db = new LocalDB(); this.uid = 'local-' + randomId(8);
      this.offset = 0; this.connected = true;
    },
  };

  function configReady() {
    return !!(FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.databaseURL && FIREBASE_CONFIG.projectId);
  }
  function setFbStatus(kind, text) {
    const el = $('fb-status');
    el.className = `pill pill-${kind}`;
    el.textContent = text;
  }
  async function initFirebase() {
    if (!window.firebase || !firebase.database || !firebase.auth) {
      setFbStatus('bad', 'Firebase SDK 로드 실패');
      return false;
    }
    if (!configReady()) {
      setFbStatus('bad', 'Firebase 설정 필요');
      showMainError('온라인 플레이를 하려면 game.js 맨 위 FIREBASE_CONFIG에 프로젝트 설정값을 입력하세요. "혼자 연습하기"는 바로 이용할 수 있어요.');
      return false;
    }
    setFbStatus('wait', 'Firebase 연결 중…');
    try {
      if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      const auth = firebase.auth();
      const db = firebase.database();
      Net.fb = { auth, db };
      // 탭마다 다른 익명 사용자, 같은 탭 새로고침 시 같은 사용자(재접속 시 중복 방지)
      await auth.setPersistence(firebase.auth.Auth.Persistence.SESSION);
      const current = await withTimeout(new Promise((res) => {
        const off = auth.onAuthStateChanged((u) => { off(); res(u); });
      }), CFG.net.requestTimeoutMs, 'Firebase 로그인 응답이 없습니다.');
      const user = current || (await withTimeout(auth.signInAnonymously(), CFG.net.requestTimeoutMs, 'Firebase 로그인 응답이 없습니다.')).user;
      setAuthUser(user);
      db.ref('.info/serverTimeOffset').on('value', (s) => {
        Net.fbOffset = num(s.val(), 0);
        if (Net.mode === 'firebase') Net.offset = Net.fbOffset;
      });
      db.ref('.info/connected').on('value', (s) => onFbConnected(!!s.val()));
      Net.fbReady = true;
      Net.useFirebase();
      setTimeout(() => { if (!Net.fbConnected) setFbStatus('wait', 'Firebase 연결 지연 중…'); }, 8000);
      return true;
    } catch (e) {
      logError('firebase init', e);
      setFbStatus('bad', 'Firebase 연결 실패');
      showMainError(friendly(e));
      return false;
    }
  }
  function setAuthUser(user) {
    Net.fbUid = user.uid;
    Net.isAdminAccount = !user.isAnonymous && String(user.email || '').toLowerCase() === ADMIN_EMAIL.toLowerCase();
    if (Net.mode === 'firebase') Net.uid = user.uid;
    renderAdminUi();
  }
  async function adminLogin() {
    if (App.busy || App.code) return;
    hideMainError();
    const pw = $('admin-password').value;
    try {
      if (!Net.fbReady) throw new UserError('Firebase가 준비되지 않았습니다. 설정과 연결 상태를 확인하세요.');
      if (!pw) throw new UserError('관리자 비밀번호를 입력해 주세요.');
      setBusy(true);
      const cred = await withTimeout(Net.fb.auth.signInWithEmailAndPassword(ADMIN_EMAIL, pw), CFG.net.requestTimeoutMs, '로그인 응답이 없습니다.');
      Net.useFirebase();
      setAuthUser(cred.user);
      $('admin-password').value = '';
      if (!Net.isAdminAccount) throw new UserError('관리자 계정이 아닙니다.');
      toast('관리자로 로그인했습니다. 이제 방을 만들 수 있어요.', 'ok');
    } catch (e) {
      logError('admin login', e);
      const code = String(e && e.code || '');
      showMainError(code.includes('operation-not-allowed')
        ? 'Firebase 콘솔 Authentication에서 이메일/비밀번호 로그인을 사용 설정하세요.'
        : friendly(e));
    } finally {
      setBusy(false);
    }
  }
  async function adminLogout() {
    if (App.busy || App.code || !Net.fbReady) return;
    setBusy(true);
    try {
      await Net.fb.auth.signOut();
      const cred = await withTimeout(Net.fb.auth.signInAnonymously(), CFG.net.requestTimeoutMs, 'Firebase 로그인 응답이 없습니다.');
      Net.useFirebase();
      setAuthUser(cred.user);
      toast('관리자에서 로그아웃했습니다.', 'info');
    } catch (e) {
      logError('admin logout', e);
      showMainError(friendly(e));
    } finally {
      setBusy(false);
    }
  }
  function onFbConnected(c) {
    Net.fbConnected = c;
    if (c) Net.fbEverConnected = true;
    if (c) setFbStatus('ok', 'Firebase 연결됨');
    else if (Net.fbEverConnected) setFbStatus('bad', 'Firebase 연결 끊김');
    if (Net.mode !== 'firebase') return;
    Net.connected = c;
    $('net-banner').hidden = c || !App.code || !Net.fbEverConnected;
    if (c && App.code) refreshPresence();
    renderConnPills();
  }

  /* ===================================================================
   * 8. 방 상태·리스너
   * =================================================================== */
  const App = {
    screen: 'main', code: null, nickname: '', sid: randomId(10),
    busy: false, leaving: false, starting: false, finishing: false,
    match: null, viewOverride: null, subs: [], timers: [],
    prevHostId: null, endPendingAt: 0, hostItemAt: 0, hostFxCleanAt: 0, badMetaSince: 0,
    offlineSince: {}, takenSeen: {}, electingAt: 0, menuOpen: false, playersSeenSelf: false,
    settings: { names: true, lowfx: false },
    stats: { posOut: 0, posIn: 0, outRate: 0, inRate: 0 },
  };
  const room = {
    info: null, players: {}, meta: null, result: null,
    waves: {}, wavesVer: 0, items: {}, fxQueue: [], elim: {}, pos: {}, lastPick: {},
    infoLoaded: false, playersLoaded: false,
  };
  function resetRoomState() {
    Object.assign(room, {
      info: null, players: {}, meta: null, result: null, waves: {}, wavesVer: room.wavesVer + 1,
      items: {}, fxQueue: [], elim: {}, pos: {}, lastPick: {}, infoLoaded: false, playersLoaded: false,
    });
  }
  const roomPath = (sub) => (sub ? `rooms/${App.code}/${sub}` : `rooms/${App.code}`);
  const roomRef = (sub) => Net.ref(roomPath(sub));
  // 관리자(adminId): 방 생성·맵 선택·경기 시작·재경기 권한
  // 진행 담당(hostId): 붕괴·아이템·판정 기록. 평소엔 관리자이고, 경기 중 관리자 연결이 끊기면 참가자가 대신 맡음
  const isHost = () => !!(room.info && room.info.hostId === Net.uid);
  const isRoomAdmin = () => !!(room.info && room.info.adminId === Net.uid);

  function listen(ref, ev, cb) {
    const wrapped = (snap) => {
      try { cb(snap); } catch (e) { logError(`listener ${ev}`, e); }
    };
    ref.on(ev, wrapped, (err) => { logError(`listen ${ev}`, err); toast(friendly(err), 'error'); });
    App.subs.push({ ref, ev, cb: wrapped });
  }
  function detachAll() {
    for (const s of App.subs) { try { s.ref.off(s.ev, s.cb); } catch (e) { /* 무시 */ } }
    App.subs = [];
  }

  function sanitizeInfo(v) {
    if (!v || typeof v !== 'object') return null;
    return {
      adminId: str(v.adminId), hostId: str(v.hostId), status: ['lobby', 'countdown', 'playing', 'results'].includes(v.status) ? v.status : 'lobby',
      mapId: MAP_DEFS[v.mapId] || v.mapId === 'random' ? v.mapId : 'meadow',
      maxPlayers: clamp(num(v.maxPlayers, CFG.maxPlayers), 2, CFG.maxPlayers),
      createdAt: num(v.createdAt), matchId: str(v.matchId),
    };
  }
  function sanitizePlayers(v) {
    const out = {};
    if (!v || typeof v !== 'object') return out;
    for (const [id, p] of Object.entries(v)) {
      if (!p || typeof p !== 'object' || typeof p.nickname !== 'string') continue;
      out[id] = {
        id, nickname: cleanNickname(p.nickname) || '플레이어',
        characterId: CHAR_IDS.includes(p.characterId) ? p.characterId : DEFAULT_CHAR,
        ready: p.ready === true, online: p.online !== false, spectator: p.spectator === true,
        joinedAt: num(p.joinedAt), lastSeen: num(p.lastSeen), sid: str(p.sid),
      };
    }
    return out;
  }
  function sanitizeMeta(v) {
    if (!v || typeof v !== 'object' || typeof v.id !== 'string' || !MAP_DEFS[v.mapId] || !v.roster) return null;
    const roster = {};
    for (const [id, r] of Object.entries(v.roster)) {
      if (!r || typeof r !== 'object') continue;
      roster[id] = {
        sx: clamp(num(r.sx, CX), 0, CFG.world.w), sy: clamp(num(r.sy, CY), 0, CFG.world.h),
        c: CHAR_IDS.includes(r.c) ? r.c : DEFAULT_CHAR, n: cleanNickname(r.n) || '플레이어',
      };
    }
    if (!Object.keys(roster).length) return null;
    return { id: v.id, mapId: v.mapId, startAt: num(v.startAt, Date.now()), roster };
  }
  function sanitizeResult(v) {
    if (!v || typeof v !== 'object' || typeof v.mid !== 'string') return null;
    const ranking = toArr(v.ranking).filter((e) => e && typeof e.id === 'string').map((e) => ({
      id: e.id, n: cleanNickname(e.n) || '플레이어', c: CHAR_IDS.includes(e.c) ? e.c : DEFAULT_CHAR,
      alive: e.alive === true, ms: Math.max(0, num(e.ms)), rank: Math.max(1, Math.round(num(e.rank, 1))), dc: e.dc === true,
    })).sort((a, b) => a.rank - b.rank);
    return { mid: v.mid, endedAt: num(v.endedAt), ranking, winners: toArr(v.winners).filter((x) => typeof x === 'string'), draw: v.draw === true };
  }
  function onPos(uid, v) {
    if (!v || typeof v !== 'object') { delete room.pos[uid]; return; }
    const d = {
      t: performance.now(), x: clamp(num(v.x, CX), -600, 2000), y: clamp(num(v.y, CY), -600, 1600),
      z: clamp(num(v.z), -400, 400), st: str(v.st, 'idle').slice(0, 8), f: num(v.f, 1) < 0 ? -1 : 1,
      e: str(v.e).slice(0, 8), mid: str(v.mid),
    };
    let rec = room.pos[uid];
    if (!rec || rec.mid !== d.mid) rec = room.pos[uid] = { mid: d.mid, buf: [] };
    rec.buf.push(d);
    if (rec.buf.length > 24) rec.buf.splice(0, rec.buf.length - 24);
    App.stats.posIn += 1;
  }

  function attachRoomListeners() {
    listen(roomRef('info'), 'value', (s) => {
      room.info = sanitizeInfo(s.val());
      room.infoLoaded = true;
      if (!room.info) { if (!App.leaving) leaveLocal('관리자가 방을 닫았습니다.'); return; }
      onRoomChanged();
    });
    listen(roomRef('players'), 'value', (s) => {
      room.players = sanitizePlayers(s.val());
      room.playersLoaded = true;
      onRoomChanged();
    });
    listen(roomRef('match/meta'), 'value', (s) => { room.meta = sanitizeMeta(s.val()); onRoomChanged(); });
    listen(roomRef('match/result'), 'value', (s) => { room.result = sanitizeResult(s.val()); onRoomChanged(); });
    const wavesRef = roomRef('match/waves');
    listen(wavesRef, 'child_added', (s) => { room.waves[s.key] = s.val(); room.wavesVer += 1; });
    listen(wavesRef, 'child_removed', (s) => { delete room.waves[s.key]; room.wavesVer += 1; });
    const itemsRef = roomRef('match/items');
    const setItem = (s) => {
      const v = s.val();
      if (!v || typeof v !== 'object') { delete room.items[s.key]; return; }
      const prev = room.items[s.key];
      const it = { key: s.key, t: ITEMS[v.t] ? v.t : null, x: num(v.x), y: num(v.y), at: num(v.at), mid: str(v.mid), by: typeof v.by === 'string' ? v.by : null };
      if (!it.t) { delete room.items[s.key]; return; }
      if (it.by && (!prev || !prev.by)) room.lastPick[it.by] = performance.now();
      room.items[s.key] = it;
    };
    listen(itemsRef, 'child_added', setItem);
    listen(itemsRef, 'child_changed', setItem);
    listen(itemsRef, 'child_removed', (s) => { delete room.items[s.key]; });
    listen(roomRef('match/fx'), 'child_added', (s) => {
      const v = s.val();
      if (!v || typeof v !== 'object') return;
      room.fxQueue.push({ key: s.key, by: str(v.by), x: num(v.x), y: num(v.y), at: num(v.at), mid: str(v.mid) });
      if (room.fxQueue.length > 40) room.fxQueue.splice(0, room.fxQueue.length - 40);
    });
    const elimRef = roomRef('match/elim');
    listen(elimRef, 'child_added', (s) => {
      const v = s.val();
      if (v && typeof v === 'object') room.elim[s.key] = { at: num(v.at), ms: Math.max(0, num(v.ms)), mid: str(v.mid), dc: v.dc === true };
    });
    listen(elimRef, 'child_removed', (s) => { delete room.elim[s.key]; });
    const posRef = roomRef('pos');
    listen(posRef, 'child_added', (s) => onPos(s.key, s.val()));
    listen(posRef, 'child_changed', (s) => onPos(s.key, s.val()));
    listen(posRef, 'child_removed', (s) => { delete room.pos[s.key]; });
  }

  function elimFor(mid) {
    const out = {};
    for (const [id, e] of Object.entries(room.elim)) if (e.mid === mid) out[id] = e;
    return out;
  }
  function isPlayerStale(p, now) {
    return !p || p.online === false || now - (p.lastSeen || 0) > CFG.net.staleMs;
  }
  function onlinePlayers() {
    const now = Net.now();
    return Object.values(room.players)
      .filter((p) => !isPlayerStale(p, now))
      .sort((a, b) => (a.joinedAt - b.joinedAt) || (a.id < b.id ? -1 : 1));
  }
  // 경기에 실제로 들어갈 참가자(진행만 하는 관리자는 제외)
  const onlineParticipants = () => onlinePlayers().filter((p) => !p.spectator);
  const minNeeded = () => (Net.mode === 'local' ? 1 : CFG.minPlayers);
  function adminOnline() {
    return !!(room.info && !isPlayerStale(room.players[room.info.adminId], Net.now()));
  }

  let changeQueued = false;
  function onRoomChanged() {
    if (changeQueued) return;
    changeQueued = true;
    queueMicrotask(() => {
      changeQueued = false;
      if (!App.code) return;
      checkSelfRecord();
      if (!App.code) return;
      if (room.info && App.prevHostId && room.info.hostId !== App.prevHostId) {
        const inGame = room.info.status === 'countdown' || room.info.status === 'playing';
        if (room.info.hostId === room.info.adminId) {
          if (!isRoomAdmin()) toast('관리자가 다시 연결되었습니다.', 'info', 3000);
        } else if (room.info.hostId === Net.uid) {
          toast(inGame ? '관리자 연결이 끊겨 이번 경기 진행을 대신 맡았습니다.' : '관리자 연결이 끊겨 방 정리를 대신 맡았습니다.', 'warn', 3600);
        } else if (inGame) {
          toast('관리자 연결이 끊겨 다른 참가자가 경기 진행을 이어받았습니다.', 'warn', 3600);
        }
      }
      if (room.info) App.prevHostId = room.info.hostId;
      maybeElectHost();
      route();
      if (App.screen === 'lobby') renderLobby();
      if (App.screen === 'results') renderResults();
    });
  }
  function checkSelfRecord() {
    if (!room.playersLoaded || App.leaving) return;
    const me = room.players[Net.uid];
    if (me) {
      App.playersSeenSelf = true;
      if (me.sid && me.sid !== App.sid) leaveLocal('같은 세션이 다른 탭이나 창에서 접속해 이 화면의 연결을 종료했습니다.');
      return;
    }
    if (App.playersSeenSelf) leaveLocal('오랫동안 연결이 끊겨 방에서 정리되었습니다. 다시 참가해 주세요.');
  }

  function route() {
    if (!App.code) { showScreen('main'); return; }
    const info = room.info;
    if (!info) return;
    const meta = room.meta;
    if ((info.status === 'countdown' || info.status === 'playing') && meta && meta.id === info.matchId) {
      App.viewOverride = null;
      if (App.screen !== 'game') showScreen('game');
      if (!App.match || App.match.id !== meta.id) startMatchView(meta);
      return;
    }
    if (info.status === 'countdown' || info.status === 'playing') return; // 경기 정보 수신 대기
    if (info.status === 'results' && room.result && meta && room.result.mid === meta.id) {
      stopMatchView();
      if (App.viewOverride === 'lobby') { showScreen('lobby'); renderLobby(); }
      else { showScreen('results'); renderResults(); }
      return;
    }
    if (info.status === 'results') return; // 결과 수신 대기
    stopMatchView();
    App.viewOverride = null;
    if (App.screen !== 'lobby') { showScreen('lobby'); renderLobby(); }
  }

  /* ===================================================================
   * 9. 방 생성·참가·퇴장
   * =================================================================== */
  function saveSession() {
    try { sessionStorage.setItem('ps_session', JSON.stringify({ code: App.code, nickname: App.nickname, local: Net.mode === 'local' })); } catch (e) { /* 무시 */ }
  }
  function loadSession() {
    try { return JSON.parse(sessionStorage.getItem('ps_session') || 'null'); } catch (e) { return null; }
  }
  function clearSession() { try { sessionStorage.removeItem('ps_session'); } catch (e) { /* 무시 */ } }
  function savePref(k, v) { try { localStorage.setItem(`ps_${k}`, JSON.stringify(v)); } catch (e) { /* 무시 */ } }
  function loadPref(k, d) { try { const v = localStorage.getItem(`ps_${k}`); return v === null ? d : JSON.parse(v); } catch (e) { return d; } }

  function readNickname() {
    const n = cleanNickname($('nickname').value);
    if (!n) throw new UserError('닉네임을 1~12자로 입력해 주세요.');
    App.nickname = n;
    savePref('nickname', n);
    return n;
  }

  async function createRoom({ local = false } = {}) {
    if (App.busy || App.code) return;
    setBusy(true);
    hideMainError();
    try {
      readNickname();
      if (local) Net.useLocal();
      else {
        if (!Net.fbReady) throw new UserError('Firebase가 준비되지 않았습니다. 설정과 연결 상태를 확인하세요.');
        Net.useFirebase();
        if (!Net.isAdminAccount) throw new UserError('방은 관리자만 만들 수 있습니다. 받은 방 코드로 참가해 주세요.');
        if (!Net.fbConnected) throw new UserError('Firebase 서버에 연결되지 않았습니다. 네트워크를 확인해 주세요.');
      }
      let code = null;
      for (let attempt = 0; attempt < 8 && !code; attempt++) {
        const c = genRoomCode();
        const res = await withTimeout(
          Net.ref(`rooms/${c}/info`).transaction((cur) => (cur ? undefined : {
            adminId: Net.uid, hostId: Net.uid, status: 'lobby', mapId: 'meadow', maxPlayers: CFG.maxPlayers,
            createdAt: Math.round(Net.now()), matchId: '',
          })),
          CFG.net.requestTimeoutMs, '서버 응답이 없습니다. 잠시 후 다시 시도해 주세요.');
        if (res.committed) code = c;
      }
      if (!code) throw new UserError('방 코드를 만들지 못했습니다. 다시 시도해 주세요.');
      await joinRoom(code, { creating: true });
    } catch (e) {
      logError('create room', e);
      showMainError(friendly(e));
      if (local && !App.code && Net.fbReady) Net.useFirebase();
    } finally {
      setBusy(false);
    }
  }

  async function joinByCode() {
    if (App.busy || App.code) return;
    hideMainError();
    const code = $('room-code-input').value.trim().toUpperCase();
    try {
      readNickname();
      if (!new RegExp(`^[A-Z0-9]{${CFG.codeLength}}$`).test(code)) throw new UserError('방 코드는 영문 대문자와 숫자 6자리입니다.');
      if (!Net.fbReady) throw new UserError('Firebase가 준비되지 않았습니다. 설정과 연결 상태를 확인하세요.');
      Net.useFirebase();
      if (!Net.fbConnected) throw new UserError('Firebase 서버에 연결되지 않았습니다. 네트워크를 확인해 주세요.');
      setBusy(true);
      await joinRoom(code, {});
    } catch (e) {
      logError('join room', e);
      showMainError(friendly(e));
    } finally {
      setBusy(false);
    }
  }

  async function joinRoom(code, { creating = false } = {}) {
    const base = `rooms/${code}`;
    const t = CFG.net.requestTimeoutMs;
    const infoSnap = await withTimeout(Net.ref(`${base}/info`).once('value'), t, '서버 응답이 없습니다.');
    const info = sanitizeInfo(infoSnap.val());
    if (!info) throw new UserError('존재하지 않는 방 코드입니다.');
    const playersSnap = await withTimeout(Net.ref(`${base}/players`).once('value'), t, '서버 응답이 없습니다.');
    const players = sanitizePlayers(playersSnap.val());
    const now = Net.now();
    const existing = players[Net.uid];
    const others = Object.values(players).filter((p) => p.id !== Net.uid);
    const activeOthers = others.filter((p) => p.online && now - p.lastSeen < 120000);
    if (!creating && !existing && !activeOthers.length && now - info.createdAt > 10 * 60000) {
      throw new UserError('이미 종료된 방입니다.');
    }
    const amAdmin = info.adminId === Net.uid;
    if (!existing && !amAdmin && others.filter((p) => !p.spectator).length >= info.maxPlayers) {
      throw new UserError(`방 인원이 가득 찼습니다. (최대 ${info.maxPlayers}명)`);
    }
    const prefChar = loadPref('char', DEFAULT_CHAR);
    const spectator = amAdmin && Net.mode !== 'local' && (existing ? existing.spectator : loadPref('adminSpectate', true) === true);
    const record = {
      nickname: App.nickname,
      characterId: existing ? existing.characterId : CHAR_IDS.includes(prefChar) ? prefChar : DEFAULT_CHAR,
      ready: false, online: true, spectator,
      joinedAt: existing ? existing.joinedAt : Math.round(now),
      lastSeen: Math.round(now), sid: App.sid,
    };
    const meRef = Net.ref(`${base}/players/${Net.uid}`);
    await withTimeout(meRef.set(record), t, '방 참가 요청이 시간 안에 끝나지 않았습니다.');
    await meRef.onDisconnect().update({ online: false, lastSeen: Net.serverTs() });

    resetRoomState();
    App.code = code;
    App.leaving = false;
    App.playersSeenSelf = false;
    App.prevHostId = info.hostId;
    App.viewOverride = null;
    saveSession();
    attachRoomListeners();
    startRoomTimers();
    renderConnPills();
    $('room-code-input').value = code;
    toast(existing ? '방에 다시 연결했습니다.' : Net.mode === 'local' ? '연습 방을 열었습니다.' : creating ? `방을 만들었습니다. 코드: ${code}` : '방에 참가했습니다.', 'ok');
  }

  function refreshPresence() {
    if (!App.code || Net.mode !== 'firebase') return;
    const r = roomRef(`players/${Net.uid}`);
    r.onDisconnect().update({ online: false, lastSeen: Net.serverTs() }).catch((e) => logError('presence', e));
    if (room.players[Net.uid]) r.update({ online: true, lastSeen: Math.round(Net.now()) }).catch((e) => logError('presence update', e));
  }

  function startRoomTimers() {
    stopRoomTimers();
    App.timers.push(setInterval(hostTick, 250));
    App.timers.push(setInterval(() => {
      if (!App.code || !room.players[Net.uid] || !Net.connected) return;
      roomRef(`players/${Net.uid}`).update({ lastSeen: Math.round(Net.now()), online: true }).catch((e) => logError('heartbeat', e));
    }, CFG.net.heartbeatMs));
    App.timers.push(setInterval(() => {
      App.stats.outRate = App.stats.posOut; App.stats.inRate = App.stats.posIn;
      App.stats.posOut = 0; App.stats.posIn = 0;
      maybeElectHost();
      if (App.menuOpen) renderMenuStats();
      if (App.screen === 'lobby') renderLobby();
    }, 1000));
  }
  function stopRoomTimers() { App.timers.forEach(clearInterval); App.timers = []; }

  function maybeElectHost() {
    const info = room.info;
    if (!info || !App.code || App.leaving) return;
    const now = Net.now();
    // 관리자가 돌아오면 대기실·결과 화면에서 진행 담당을 되찾음(경기 중에는 혼선을 막기 위해 유지)
    if (isRoomAdmin() && info.hostId !== Net.uid && (info.status === 'lobby' || info.status === 'results')) {
      if (now - App.electingAt < 3000) return;
      App.electingAt = now;
      roomRef('info/hostId').set(Net.uid).catch((e) => logError('admin reclaim', e));
      return;
    }
    if (!isPlayerStale(room.players[info.hostId], now)) return;
    const cands = onlinePlayers().sort((a, b) => Number(b.id === info.adminId) - Number(a.id === info.adminId));
    if (!cands.length || cands[0].id !== Net.uid) return;
    if (now - App.electingAt < 3000) return;
    App.electingAt = now;
    roomRef('info/hostId').set(Net.uid).catch((e) => logError('host election', e));
  }

  async function leaveRoom() {
    if (!App.code || App.leaving) return;
    if (isRoomAdmin() && Net.mode !== 'local' && !window.confirm('방을 닫으면 모든 참가자가 나가게 됩니다. 방을 닫을까요?')) return;
    App.leaving = true;
    try {
      const meta = room.meta;
      const st = room.info && room.info.status;
      if (meta && meta.roster[Net.uid] && (st === 'countdown' || st === 'playing') && !elimFor(meta.id)[Net.uid]) {
        const now = Net.now();
        await roomRef(`match/elim/${Net.uid}`).set({ at: Math.round(now), ms: Math.round(Math.max(0, now - meta.startAt)), mid: meta.id }).catch(() => {});
      }
      const others = onlinePlayers().filter((p) => p.id !== Net.uid);
      await roomRef(`players/${Net.uid}`).onDisconnect().cancel().catch(() => {});
      if (isRoomAdmin()) {
        await roomRef('').remove();
      } else {
        if (isHost()) {
          const adminP = others.find((p) => p.id === room.info.adminId);
          const next = adminP || others[0];
          if (next) await roomRef('info/hostId').set(next.id).catch((e) => logError('handover', e));
        }
        await roomRef('').update({ [`players/${Net.uid}`]: null, [`pos/${Net.uid}`]: null });
      }
    } catch (e) {
      logError('leave room', e);
    } finally {
      leaveLocal(null);
    }
  }
  function leaveLocal(message) {
    const wasCode = App.code;
    if (wasCode && Net.mode === 'firebase') {
      Net.ref(`rooms/${wasCode}/players/${Net.uid}`).onDisconnect().cancel().catch(() => {});
    }
    detachAll();
    stopRoomTimers();
    stopMatchView();
    resetRoomState();
    App.code = null;
    App.leaving = false;
    App.viewOverride = null;
    App.endPendingAt = 0; App.finishing = false; App.hostItemAt = 0; App.offlineSince = {}; App.takenSeen = {};
    clearSession();
    closeMenu();
    $('net-banner').hidden = true;
    if (Net.mode === 'local' && Net.fbReady) Net.useFirebase();
    else if (Net.mode === 'local') Net.mode = 'none';
    renderConnPills();
    showScreen('main');
    if (message) showMainError(message);
  }

  /* ===================================================================
   * 10. 진행 로직: 관리자 시작·붕괴·아이템·판정
   * ---------------------------------------------------------------
   * 경기 시작·재경기·맵 선택은 관리자만 할 수 있습니다.
   * GitHub Pages는 정적 호스팅이라 서버에서 게임 로직을 돌릴 수 없으므로
   * 진행 담당(평소엔 관리자) 클라이언트가 진행의 기준을 기록합니다. 경기 중 관리자 연결이
   * 끊기면 남은 참가자 한 명이 이번 경기 진행만 이어받아 기록된 정보로 경기를 마칩니다.
   * =================================================================== */
  async function adminStartMatch() {
    if (!isRoomAdmin() || App.starting) return;
    const online = onlineParticipants();
    const need = minNeeded();
    if (online.length < need) { toast(`경기를 시작하려면 참가자가 최소 ${need}명 필요합니다.`, 'warn'); return; }
    if (!window.Phaser) { showFatal('게임 엔진(Phaser)을 불러오지 못해 경기를 시작할 수 없습니다. 네트워크를 확인하고 새로고침하세요.'); return; }
    App.starting = true;
    try {
      let mapId = room.info.mapId;
      if (mapId === 'random' || !MAP_DEFS[mapId]) mapId = pick(MAP_LIST);
      const map = getMap(mapId);
      const roster = {};
      const list = online.slice(0, CFG.maxPlayers);
      const spawns = computeSpawns(map, list.length);
      list.forEach((p, i) => { roster[p.id] = { sx: spawns[i].x, sy: spawns[i].y, c: p.characterId, n: p.nickname }; });
      const mid = 'm' + Date.now().toString(36) + randomId(5);
      const startAt = Math.round(Net.now() + CFG.countdownMs);
      App.endPendingAt = 0; App.finishing = false; App.hostItemAt = 0; App.offlineSince = {}; App.takenSeen = {};
      await roomRef('').update({
        'info/status': 'countdown',
        'info/hostId': Net.uid,
        'info/matchId': mid,
        match: { meta: { id: mid, mapId, startAt, roster } },
        pos: null,
      });
    } catch (e) {
      logError('start match', e);
      toast('경기를 시작하지 못했습니다. ' + friendly(e), 'error', 4000);
    } finally {
      App.starting = false;
    }
  }

  function adminResetToLobby(message) {
    if (!isRoomAdmin()) return;
    roomRef('').update({ 'info/status': 'lobby', 'info/matchId': '', match: null, pos: null })
      .then(() => { if (message) toast(message, 'warn', 3500); })
      .catch((e) => { logError('reset lobby', e); toast(friendly(e), 'error'); });
  }

  function hostTick() {
    if (!App.code || !room.info || !isHost() || App.leaving) return;
    const now = Net.now();
    const info = room.info;
    if (info.status === 'lobby') { hostCleanupLobby(now); return; }
    if (info.status === 'results') return;
    const meta = room.meta;
    if (!meta || meta.id !== info.matchId) {
      if (!App.badMetaSince) App.badMetaSince = now;
      // 경기 정보를 복구할 수 없으면 관리자가 안전하게 대기실로 되돌림(진행 대행 참가자는 대기)
      if (isRoomAdmin() && now - App.badMetaSince > 5000) { App.badMetaSince = 0; adminResetToLobby('경기 정보를 복구할 수 없어 대기실로 돌아갑니다.'); }
      return;
    }
    App.badMetaSince = 0;
    if (room.result && room.result.mid === meta.id) {
      if (info.status !== 'results') roomRef('info/status').set('results').catch((e) => logError('status', e));
      return;
    }
    if (info.status === 'countdown' && now >= meta.startAt) roomRef('info/status').set('playing').catch((e) => logError('status', e));
    if (now < meta.startAt) return;
    const elapsed = now - meta.startAt;
    const map = getMap(meta.mapId);
    hostDropDisconnected(meta, now);
    hostCheckEnd(meta, now, elapsed);
    hostCollapse(meta, map, now, elapsed);
    hostItems(meta, map, now, elapsed);
    if (now - App.hostFxCleanAt > 2000) {
      App.hostFxCleanAt = now;
      const stale = {};
      for (const f of room.fxQueue) if (now - f.at > 4000 || f.mid !== meta.id) stale[`match/fx/${f.key}`] = null;
      if (Object.keys(stale).length) roomRef('').update(stale).catch((e) => logError('fx cleanup', e));
      room.fxQueue = room.fxQueue.filter((f) => now - f.at <= 4000 && f.mid === meta.id);
    }
  }

  function hostCleanupLobby(now) {
    for (const p of Object.values(room.players)) {
      if (p.id === Net.uid || p.id === room.info.adminId) continue;
      if (isPlayerStale(p, now)) {
        if (!App.offlineSince[p.id]) App.offlineSince[p.id] = now;
        if (now - App.offlineSince[p.id] > CFG.presence.lobbyRemoveMs) {
          delete App.offlineSince[p.id];
          roomRef('').update({ [`players/${p.id}`]: null, [`pos/${p.id}`]: null }).catch((e) => logError('cleanup player', e));
        }
      } else delete App.offlineSince[p.id];
    }
  }

  function hostDropDisconnected(meta, now) {
    const elim = elimFor(meta.id);
    for (const id of Object.keys(meta.roster)) {
      if (elim[id] || id === Net.uid) continue;
      const p = room.players[id];
      if (isPlayerStale(p, now) || (p && p.online === false)) {
        if (!App.offlineSince[id]) App.offlineSince[id] = now;
        if (now - App.offlineSince[id] > CFG.presence.matchDropMs) {
          delete App.offlineSince[id];
          roomRef(`match/elim/${id}`).set({ at: Math.round(now), ms: Math.round(Math.max(0, now - meta.startAt)), mid: meta.id, dc: true })
            .catch((e) => logError('drop player', e));
        }
      } else delete App.offlineSince[id];
    }
  }

  function computeRanking(meta, elim, endAt) {
    const dur = Math.round(clamp(endAt - meta.startAt, 0, CFG.matchMaxMs));
    const list = Object.keys(meta.roster).map((id) => {
      const e = elim[id];
      return { id, n: meta.roster[id].n, c: meta.roster[id].c, alive: !e, ms: e ? Math.round(clamp(e.ms, 0, dur)) : dur, dc: !!(e && e.dc) };
    });
    list.sort((a, b) => (Number(b.alive) - Number(a.alive)) || (b.ms - a.ms));
    list.forEach((e, i) => {
      if (i === 0) { e.rank = 1; return; }
      const p = list[i - 1];
      const tie = (e.alive && p.alive) || (!e.alive && !p.alive && p.ms - e.ms <= CFG.tieWindowMs);
      e.rank = tie ? p.rank : i + 1;
    });
    return list;
  }

  function hostCheckEnd(meta, now, elapsed) {
    const ids = Object.keys(meta.roster);
    const elim = elimFor(meta.id);
    const alive = ids.filter((id) => !elim[id]);
    const solo = ids.length < 2;
    const timeUp = elapsed >= CFG.matchMaxMs;
    const over = timeUp || (solo ? alive.length === 0 : alive.length <= 1);
    if (!over) { App.endPendingAt = 0; return; }
    if (!App.endPendingAt) App.endPendingAt = now;
    if (!timeUp && now - App.endPendingAt < CFG.endConfirmMs) return;
    finishMatch(meta, now);
  }

  async function finishMatch(meta, now) {
    if (App.finishing) return;
    App.finishing = true;
    try {
      const ranking = computeRanking(meta, elimFor(meta.id), now);
      const winners = ranking.filter((e) => e.rank === 1).map((e) => e.id);
      const result = { mid: meta.id, endedAt: Math.round(now), ranking, winners, draw: winners.length > 1 };
      // 같은 경기에 대한 결과가 이미 있으면 덮어쓰지 않습니다(중복 종료 방지).
      await roomRef('match/result').transaction((cur) => (cur && cur.mid === meta.id ? undefined : result));
      if (room.info && room.info.matchId === meta.id) await roomRef('info/status').set('results');
    } catch (e) {
      logError('finish match', e);
      App.finishing = false;
    }
  }

  function hostCollapse(meta, map, now, elapsed) {
    if (elapsed < CFG.collapse.graceMs) return;
    const wi = waveInfo(meta.id);
    if (elapsed >= CFG.collapse.suddenDeathMs) {
      if (wi.sd) return;
      const ids = map.platforms.filter((p) => p.collapsible && !wi.map.has(p.id)).map((p) => p.id);
      if (!ids.length || App.hostSdFor === meta.id) return;
      App.hostSdFor = meta.id;
      roomRef('match/waves').push({ ids, at: Math.round(now), mid: meta.id, sd: true }).catch((e) => { App.hostSdFor = null; logError('wave', e); });
      return;
    }
    const si = stageInfo(elapsed);
    if (!si.stage) return;
    const lastAt = Number.isFinite(wi.last) ? wi.last : -Infinity;
    if (now - lastAt < si.stage.every) return;
    if (App.hostWaveAt && now - App.hostWaveAt < si.stage.every) return; // 리스너 반영 전 중복 방지
    const cand = map.platforms.filter((p) => p.collapsible && !wi.map.has(p.id));
    const n = Math.min(si.stage.count, cand.length - CFG.collapse.keepMin);
    if (n <= 0) return;
    const ids = cand
      .map((p) => ({ p, s: Math.hypot(p.x - CX, p.y - CY) + (p.prio || 0) + Math.random() * CFG.collapse.jitter }))
      .sort((a, b) => b.s - a.s).slice(0, n).map((o) => o.p.id);
    App.hostWaveAt = now;
    roomRef('match/waves').push({ ids, at: Math.round(now), mid: meta.id }).catch((e) => logError('wave', e));
  }

  function hostItems(meta, map, now, elapsed) {
    if (elapsed < CFG.items.firstMs) return;
    const all = Object.values(room.items).filter((it) => it.mid === meta.id);
    const removals = {};
    for (const it of Object.values(room.items)) {
      if (it.mid !== meta.id) { removals[`match/items/${it.key}`] = null; continue; }
      if (it.by) {
        if (!App.takenSeen[it.key]) App.takenSeen[it.key] = now;
        if (now - App.takenSeen[it.key] > 1200) { removals[`match/items/${it.key}`] = null; delete App.takenSeen[it.key]; }
      } else if (now - it.at > CFG.items.ttlMs + 2000) removals[`match/items/${it.key}`] = null;
    }
    if (Object.keys(removals).length) roomRef('').update(removals).catch((e) => logError('item cleanup', e));

    const wi = waveInfo(meta.id);
    const active = all.filter((it) => !it.by && now - it.at < CFG.items.ttlMs);
    const lastAt = Math.max(App.hostItemAt || 0, meta.startAt + CFG.items.firstMs - CFG.items.everyMs, ...all.map((i) => i.at));
    if (active.length >= CFG.items.maxActive || now - lastAt < CFG.items.everyMs) return;
    const spots = map.itemSpots.filter((s) => {
      const p = map.platforms.find((pl) => platformContains(pl, s.x, s.y, 0));
      if (!p || wi.map.has(p.id)) return false; // 붕괴 예정 발판 제외
      return !active.some((it) => Math.hypot(it.x - s.x, it.y - s.y) < 40); // 중복 생성 방지
    });
    if (!spots.length) return;
    const s = pick(spots);
    App.hostItemAt = now;
    roomRef('match/items').push({ t: pickItemType(), x: Math.round(s.x), y: Math.round(s.y), at: Math.round(now), mid: meta.id })
      .catch((e) => logError('item spawn', e));
  }

  /* ===================================================================
   * 11. 입력 (키보드 + 가상 조이스틱 + 멀티 터치)
   * =================================================================== */
  const KEYMAP = {
    KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down',
    KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
  };
  const Input = {
    keys: new Set(),
    joy: { id: null, x: 0, y: 0 },
    jumpAt: -1e9,
    usePressed: false,
    init() {
      window.addEventListener('keydown', (e) => this.onKey(e, true));
      window.addEventListener('keyup', (e) => this.onKey(e, false));
      window.addEventListener('blur', () => this.reset());
      document.addEventListener('visibilitychange', () => { if (document.hidden) this.reset(); });
      const joy = $('joystick');
      joy.addEventListener('pointerdown', (e) => {
        if (this.joy.id !== null) return;
        e.preventDefault();
        this.joy.id = e.pointerId;
        try { joy.setPointerCapture(e.pointerId); } catch (err) { /* 무시 */ }
        this.updateJoy(e);
      });
      joy.addEventListener('pointermove', (e) => { if (e.pointerId === this.joy.id) { e.preventDefault(); this.updateJoy(e); } });
      const end = (e) => { if (e.pointerId === this.joy.id) this.resetJoy(); };
      joy.addEventListener('pointerup', end);
      joy.addEventListener('pointercancel', end);
      joy.addEventListener('lostpointercapture', end);
      const bindBtn = (el, fn) => {
        el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.classList.add('is-down'); fn(); });
        const up = () => el.classList.remove('is-down');
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
        el.addEventListener('pointerleave', up);
        el.addEventListener('contextmenu', (e) => e.preventDefault());
      };
      bindBtn($('touch-jump'), () => { this.jumpAt = performance.now(); });
      bindBtn($('touch-item'), () => { this.usePressed = true; });
      $('touch-controls').addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
    },
    onKey(e, down) {
      const t = e.target;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
      if (e.code === 'Escape' && down && App.screen === 'game') { e.preventDefault(); toggleMenu(); return; }
      if (App.screen !== 'game' || typing) return;
      const dir = KEYMAP[e.code];
      if (dir) {
        e.preventDefault();
        if (down) this.keys.add(dir); else this.keys.delete(dir);
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        if (down && !e.repeat) this.jumpAt = performance.now();
        return;
      }
      if (e.code === 'KeyE' && down && !e.repeat) { e.preventDefault(); this.usePressed = true; }
    },
    updateJoy(e) {
      const el = $('joystick');
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2, R = r.width / 2;
      let dx = (e.clientX - cx) / R, dy = (e.clientY - cy) / R;
      const len = Math.hypot(dx, dy);
      if (len > 1) { dx /= len; dy /= len; }
      const dead = 0.15;
      const l2 = Math.min(1, len);
      this.joy.x = l2 < dead ? 0 : dx;
      this.joy.y = l2 < dead ? 0 : dy;
      $('joystick-knob').style.transform = `translate(${dx * R * 0.55}px, ${dy * R * 0.55}px)`;
    },
    resetJoy() {
      this.joy.id = null; this.joy.x = 0; this.joy.y = 0;
      $('joystick-knob').style.transform = '';
    },
    vector() {
      if (App.menuOpen) return { x: 0, y: 0 };
      let x = 0, y = 0;
      if (this.keys.has('left')) x -= 1;
      if (this.keys.has('right')) x += 1;
      if (this.keys.has('up')) y -= 1;
      if (this.keys.has('down')) y += 1;
      x += this.joy.x; y += this.joy.y;
      const len = Math.hypot(x, y);
      if (len > 1) { x /= len; y /= len; }
      return { x, y };
    },
    consumeJump(pnow) {
      if (App.menuOpen) return false;
      if (pnow - this.jumpAt <= CFG.player.jumpBufferMs) { this.jumpAt = -1e9; return true; }
      return false;
    },
    consumeUse() { const u = this.usePressed && !App.menuOpen; this.usePressed = false; return u; },
    reset() {
      this.keys.clear(); this.jumpAt = -1e9; this.usePressed = false; this.resetJoy();
      document.querySelectorAll('.touch-btn.is-down').forEach((el) => el.classList.remove('is-down'));
    },
  };

  /* ===================================================================
   * 12. 경기 화면 (Phaser 3)
   * =================================================================== */
  function startMatchView(meta) {
    stopMatchView();
    if (!window.Phaser) { showFatal('게임 엔진(Phaser)을 불러오지 못했습니다. 네트워크를 확인하고 새로고침하세요.'); return; }
    try {
      App.match = new MatchView(meta);
    } catch (e) {
      logError('match view', e);
      showFatal('경기 화면을 만들지 못했습니다. 새로고침 후 다시 참가해 주세요.');
      return;
    }
    const me = room.players[Net.uid];
    if (me && me.ready) roomRef(`players/${Net.uid}/ready`).set(false).catch(() => {});
    Input.reset();
  }
  function stopMatchView() {
    if (App.match) { App.match.destroy(); App.match = null; }
  }

  class MatchView {
    constructor(meta) {
      this.id = meta.id;
      this.meta = meta;
      this.map = getMap(meta.mapId);
      this.startAt = meta.startAt;
      this.rosterIds = Object.keys(meta.roster).sort();
      this.colors = {};
      this.rosterIds.forEach((id, i) => { this.colors[id] = PLAYER_COLORS[i % PLAYER_COLORS.length]; });
      this.me = null;
      this.views = new Map();
      this.itemViews = new Map();
      this.platformViews = [];
      this.fxSeen = new Set();
      this.lastSend = 0; this.lastSent = null; this.sendNow = false; this.sentOut = false;
      this.hudAt = 0; this.stageIdx = -1; this.hudItem = undefined; this.goShownAt = 0; this.lastCount = null;
      this.spec = { active: false, id: null, all: false };
      this.cam = { x: CX, y: CY, z: null };
      this.destroyed = false;
      this.scene = null;
      this.endShown = false;
      const self = this;
      const root = $('game-root');
      document.body.classList.add('in-game');
      this.game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: root,
        width: root.clientWidth || 800,
        height: root.clientHeight || 600,
        backgroundColor: this.map.theme.void,
        scale: { mode: Phaser.Scale.RESIZE },
        render: { antialias: true, powerPreference: 'default' },
        audio: { noAudio: true },
        input: { keyboard: false },
        banner: false,
        disableContextMenu: true,
        scene: {
          key: 'arena',
          preload() { self.preload(this); },
          create() { self.create(this); },
          update(t, d) { self.update(t, d); },
        },
      });
      $('countdown').hidden = true;
      $('hud-banner').hidden = true;
      $('spectate-bar').hidden = true;
    }

    preload(scene) {
      scene.load.setCORS('anonymous');
      const used = new Set(Object.values(this.meta.roster).map((r) => r.c));
      for (const c of CHARACTERS) {
        if (c.imageUrl && used.has(c.id)) scene.load.image(`img_${c.id}`, c.imageUrl);
      }
      scene.load.on('loaderror', (file) => console.warn('[PikaSurvival] 캐릭터 이미지 로딩 실패, 대체 렌더링 사용:', file && file.key));
    }

    create(scene) {
      if (this.destroyed) return;
      this.scene = scene;
      for (const c of CHARACTERS) {
        for (const mood of MOODS) {
          const key = `ch_${c.id}_${mood}`;
          if (!scene.textures.exists(key)) scene.textures.addCanvas(key, charCanvas(c.id, mood));
        }
      }
      for (const t of ITEM_TYPES) if (!scene.textures.exists(`it_${t}`)) scene.textures.addCanvas(`it_${t}`, itemCanvas(t));
      this.drawBackground();
      this.buildPlatforms();
      for (const id of this.rosterIds) this.views.set(id, this.makePlayerView(id));
      if (this.meta.roster[Net.uid]) this.initMe();
      else this.enterSpectate(false);
    }

    charKeys(cId) {
      const s = this.scene;
      if (s.textures.exists(`img_${cId}`)) {
        const src = s.textures.get(`img_${cId}`).getSourceImage();
        const k = `img_${cId}`;
        return { normal: k, happy: k, hurt: k, isImg: true, base: CFG.visual.charSize / Math.max(src.width || 1, src.height || 1) };
      }
      return { normal: `ch_${cId}_normal`, happy: `ch_${cId}_happy`, hurt: `ch_${cId}_hurt`, isImg: false, base: CFG.visual.charSize / CFG.visual.texSize };
    }

    drawBackground() {
      const s = this.scene;
      const b = this.map.bounds;
      const style = this.map.theme.style;
      const rnd = mulberry32(hashStr(this.map.id));
      const g = s.add.graphics().setDepth(-20);
      if (App.settings.lowfx) return;
      if (style === 'grass' || style === 'cloud') {
        g.fillStyle(0xffffff, style === 'cloud' ? 0.35 : 0.5);
        for (let i = 0; i < 12; i++) {
          const x = b.x - 200 + rnd() * (b.w + 400), y = b.y - 150 + rnd() * (b.h + 300), w = 90 + rnd() * 120;
          g.fillEllipse(x, y, w, w * 0.42);
          g.fillEllipse(x + w * 0.25, y - w * 0.12, w * 0.6, w * 0.38);
        }
      } else if (style === 'ice') {
        g.lineStyle(3, 0xffffff, 0.12);
        for (let i = 0; i < 18; i++) {
          const x = b.x - 200 + rnd() * (b.w + 400), y = b.y - 150 + rnd() * (b.h + 300), w = 60 + rnd() * 140;
          g.strokeEllipse(x, y, w, w * 0.3);
        }
      } else if (style === 'toy') {
        g.lineStyle(2, 0xffffff, 0.06);
        for (let x = Math.floor((b.x - 400) / 80) * 80; x < b.x + b.w + 400; x += 80) g.lineBetween(x, b.y - 300, x, b.y + b.h + 300);
        for (let y = Math.floor((b.y - 300) / 80) * 80; y < b.y + b.h + 300; y += 80) g.lineBetween(b.x - 400, y, b.x + b.w + 400, y);
      }
    }

    shapeTop(g, p, color, alpha, inset = 0) {
      g.fillStyle(color, alpha);
      if (p.shape === 'circle') {
        if (this.map.theme.style === 'cloud') {
          g.fillCircle(0, 0, p.r * 0.92 - inset);
          for (let k = 0; k < 8; k++) {
            const a = (k * Math.PI) / 4;
            g.fillCircle(Math.cos(a) * p.r * 0.62, Math.sin(a) * p.r * 0.6, p.r * 0.4 - inset);
          }
        } else if (this.map.theme.style === 'ice') {
          g.fillPoints(this.icePoints(p, 0, inset), true);
        } else g.fillCircle(0, 0, p.r - inset);
      } else {
        const w = p.w - inset * 2, h = p.h - inset * 2;
        g.fillRoundedRect(-w / 2, -h / 2, w, h, Math.min(14, w / 2, h / 2));
      }
    }
    icePoints(p, dy, inset) {
      if (!p._ice) {
        const rnd = mulberry32(hashStr(p.id));
        p._ice = Array.from({ length: 10 }, (_, k) => ({ a: (k / 10) * Math.PI * 2, m: 0.95 + rnd() * 0.09 }));
      }
      return p._ice.map((q) => ({ x: Math.cos(q.a) * (p.r * q.m - inset), y: Math.sin(q.a) * (p.r * q.m - inset) + dy }));
    }

    buildPlatforms() {
      const s = this.scene;
      const th = this.map.theme;
      const d = CFG.visual.platformDepth;
      for (const p of this.map.platforms) {
        const topHex = p.color || th.top;
        const top = hexNum(topHex);
        const side = hexNum(p.color ? shade(p.color, -70) : th.side);
        const edge = hexNum(p.color ? shade(p.color, 35) : th.edge);
        const g = s.add.graphics({ x: p.x, y: p.y }).setDepth(p.y / 10000);
        // 옆면(두께)
        g.fillStyle(side, 1);
        if (p.shape === 'circle') {
          if (th.style === 'ice') g.fillPoints(this.icePoints(p, d, 0), true);
          else g.fillCircle(0, d * (th.style === 'cloud' ? 0.6 : 1), p.r * (th.style === 'cloud' ? 0.95 : 1));
          g.fillRect(-p.r * 0.9, 0, p.r * 1.8, d * 0.9);
        } else {
          g.fillRoundedRect(-p.w / 2, -p.h / 2 + d, p.w, p.h, Math.min(14, p.w / 2, p.h / 2));
          g.fillRect(-p.w / 2, 0, p.w, p.h / 2 + d * 0.5);
        }
        // 윗면
        this.shapeTop(g, p, top, 1);
        this.shapeTop(g, p, edge, 0.35, 0);
        this.shapeTop(g, p, top, 1, 4);
        // 장식
        const rnd = mulberry32(hashStr(p.id + this.map.id));
        if (th.style === 'grass') {
          g.fillStyle(hexNum(th.top2), 1);
          for (let i = 0; i < 4; i++) g.fillEllipse((rnd() - 0.5) * p.w * 0.7, (rnd() - 0.5) * p.h * 0.7, 26 + rnd() * 14, 10 + rnd() * 6);
        } else if (th.style === 'ice') {
          g.lineStyle(4, 0xffffff, 0.6);
          g.lineBetween(-p.r * 0.45, -p.r * 0.25, -p.r * 0.1, -p.r * 0.5);
          g.lineBetween(-p.r * 0.2, -p.r * 0.05, p.r * 0.25, -p.r * 0.38);
        } else if (th.style === 'toy') {
          const stud = hexNum(shade(topHex, 30));
          const ring = hexNum(shade(topHex, -25));
          const step = 40;
          const nx = Math.max(1, Math.floor((p.w - 10) / step)), ny = Math.max(1, Math.floor((p.h - 10) / step));
          for (let ix = 0; ix < nx; ix++) {
            for (let iy = 0; iy < ny; iy++) {
              const x = -((nx - 1) * step) / 2 + ix * step, y = -((ny - 1) * step) / 2 + iy * step;
              g.fillStyle(ring, 1); g.fillCircle(x, y + 2, 9);
              g.fillStyle(stud, 1); g.fillCircle(x, y, 9);
            }
          }
        } else if (th.style === 'cloud') {
          g.fillStyle(0xffffff, 0.8);
          g.fillCircle(-p.r * 0.3, -p.r * 0.3, p.r * 0.18);
        }
        if (!p.collapsible) {
          g.lineStyle(3, 0xffffff, 0.55);
          if (p.shape === 'circle') g.strokeCircle(0, 0, p.r * 0.55);
          else g.strokeRoundedRect(-p.w * 0.3, -p.h * 0.3, p.w * 0.6, p.h * 0.6, 10);
        }
        const warn = s.add.graphics({ x: p.x, y: p.y }).setDepth(p.y / 10000 + 0.00001).setAlpha(0);
        this.shapeTop(warn, p, 0xff4d4d, 1);
        const crack = s.add.graphics({ x: p.x, y: p.y }).setDepth(p.y / 10000 + 0.00002).setVisible(false);
        this.platformViews.push({ p, g, warn, crack, st: 'normal', cracked: false });
      }
    }

    drawCracks(pv) {
      const p = pv.p;
      const c = pv.crack;
      const rnd = mulberry32(hashStr(p.id + 'crack'));
      const R = p.shape === 'circle' ? p.r * 0.85 : Math.min(p.w, p.h) * 0.45;
      c.lineStyle(3, 0x3b2a2a, 0.75);
      for (let k = 0; k < 4; k++) {
        let x = (rnd() - 0.5) * R * 0.3, y = (rnd() - 0.5) * R * 0.3;
        const a0 = rnd() * Math.PI * 2;
        c.beginPath(); c.moveTo(x, y);
        for (let j = 1; j <= 3; j++) {
          const a = a0 + (rnd() - 0.5) * 0.9;
          x += Math.cos(a) * R * 0.3; y += Math.sin(a) * R * 0.3;
          c.lineTo(x, y);
        }
        c.strokePath();
      }
      c.setVisible(true);
      pv.cracked = true;
    }

    makePlayerView(id) {
      const s = this.scene;
      const r = this.meta.roster[id];
      const color = this.colors[id];
      const isMe = id === Net.uid;
      const keys = this.charKeys(r.c);
      const shadow = s.add.ellipse(r.sx, r.sy, 46, 18, 0x000000, 0.22).setDepth(1);
      const ring = s.add.ellipse(r.sx, r.sy, 52, 21).setStrokeStyle(isMe ? 4 : 3, hexNum(color), 0.95).setDepth(1.1);
      const body = s.add.image(0, 0, keys.normal).setOrigin(0.5, 0.9);
      body.setScale(keys.base);
      const bubble = s.add.ellipse(0, -30, 80, 80, 0x9fd8ff, 0.18).setStrokeStyle(4, 0xbfe6ff, 0.95).setVisible(false);
      const cont = s.add.container(r.sx, r.sy, [bubble, body]).setDepth(10);
      const label = s.add.text(r.sx, r.sy - 70, isMe ? `나 · ${r.n}` : r.n, {
        fontFamily: 'Jua, "Noto Sans KR", sans-serif', fontSize: '15px', color: '#1d1836',
        backgroundColor: color, padding: { x: 7, y: 2 },
      }).setOrigin(0.5, 1).setDepth(60).setResolution(2);
      const badges = EFFECT_TYPES.map((t) => s.add.image(0, 0, `it_${t}`).setScale(0.2).setVisible(false).setDepth(61));
      return {
        id, isMe, shadow, ring, body, bubble, cont, label, badges, keys,
        mood: 'normal', dropStart: 0, landAt: 0, hitAt: 0, happyAt: 0, lastZ: 0, hidden: false,
        phase: Math.random() * 6, x: r.sx, y: r.sy, z: 0,
      };
    }

    initMe() {
      const r = this.meta.roster[Net.uid];
      const now = Net.now();
      this.me = {
        x: r.sx, y: r.sy, z: 0, vx: 0, vy: 0, vz: 0, kx: 0, ky: 0, facing: 1,
        alive: true, airborne: false, falling: false, fallStart: 0, fallVz: 0,
        lastGroundAt: now, item: null, fx: {}, landAt: 0, hitAt: 0, happyAt: 0, useAt: 0,
        picking: false, picked: new Set(), st: 'idle', frozenUntil: 0,
      };
      // 경기 도중 새로고침/재접속: 저장된 위치와 탈락 정보를 받을 때까지 잠시 대기
      if (now > this.startAt + 500) this.me.frozenUntil = performance.now() + 1500;
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      try { this.game.destroy(true); } catch (e) { logError('destroy game', e); }
      document.body.classList.remove('in-game');
      $('countdown').hidden = true;
      $('hud-banner').hidden = true;
      $('spectate-bar').hidden = true;
      clearTimeout(this.bannerTimer);
      Input.reset();
    }

    /* ---------- 발판 상태 ---------- */
    groundAt(x, y, wi, now) {
      for (const p of this.map.platforms) {
        if (platformState(p.id, wi, now) === 'gone') continue;
        if (platformContains(p, x, y, CFG.player.footTol)) return p;
      }
      return null;
    }
    nearestSafe(x, y, wi, now) {
      let best = null, bestD = Infinity;
      const m = CFG.player.rescueMargin;
      for (const p of this.map.platforms) {
        const st = platformState(p.id, wi, now);
        if (st === 'gone') continue;
        let px, py;
        if (p.shape === 'circle') {
          const dx = x - p.x, dy = y - p.y, d = Math.hypot(dx, dy), lim = Math.max(0, p.r - m);
          if (d <= lim) { px = x; py = y; } else { px = p.x + (dx / (d || 1)) * lim; py = p.y + (dy / (d || 1)) * lim; }
        } else {
          const hw = Math.max(0, p.w / 2 - m), hh = Math.max(0, p.h / 2 - m);
          px = clamp(x, p.x - hw, p.x + hw); py = clamp(y, p.y - hh, p.y + hh);
        }
        const dd = Math.hypot(px - x, py - y) + (st === 'warn' ? 400 : 0);
        if (dd < bestD) { bestD = dd; best = { x: px, y: py }; }
      }
      return best;
    }

    /* ---------- 메인 루프 ---------- */
    update(time, deltaMs) {
      if (this.destroyed || !this.scene) return;
      try {
        const dt = Math.min(deltaMs, 50) / 1000;
        const now = Net.now();
        const pnow = performance.now();
        const wi = waveInfo(this.id);
        const ended = !!(room.result && room.result.mid === this.id);
        const phase = ended ? 'ended' : now < this.startAt ? 'countdown' : 'playing';
        const elim = elimFor(this.id);

        if (this.me) {
          if (this.me.alive && elim[Net.uid]) this.eliminate(now, true);
          if (this.me.frozenUntil) this.tryRestoreMe(pnow, now);
          if (phase === 'playing' && this.me.alive && !this.me.frozenUntil) this.stepLocal(dt, now, pnow, wi);
        }
        this.consumeFx(now, pnow);
        this.updatePlatforms(now, pnow, wi);
        this.updateItems(now, pnow, wi);
        this.renderPlayers(now, pnow, elim);
        this.updateCamera(dt);
        if (pnow - this.hudAt > 100) { this.hudAt = pnow; this.updateHud(now, pnow, phase, elim); }
        if (phase === 'playing') this.netSend(pnow, now);
      } catch (e) {
        logError('game loop', e);
      }
    }

    tryRestoreMe(pnow, now) {
      const me = this.me;
      const rec = room.pos[Net.uid];
      if (rec && rec.mid === this.id && rec.buf.length) {
        const last = rec.buf[rec.buf.length - 1];
        me.x = last.x; me.y = last.y; me.z = 0; me.facing = last.f;
        me.lastGroundAt = now;
        me.frozenUntil = 0;
        if (last.st === 'out' || last.st === 'drop') this.eliminate(now, false);
        return;
      }
      if (pnow > me.frozenUntil) { me.frozenUntil = 0; me.lastGroundAt = now; }
    }

    stepLocal(dt, now, pnow, wi) {
      const me = this.me;
      const P = CFG.player;
      const phys = this.map.physics;

      if (me.falling) {
        me.fallVz -= P.gravity * dt;
        me.z += me.fallVz * dt;
        me.x += me.vx * 0.35 * dt; me.y += me.vy * 0.35 * dt;
        if (now - me.fallStart > P.fallMs) this.eliminate(now, false);
        return;
      }

      const inp = Input.vector();
      const speedMul = me.fx.speed > now ? ITEMS.speed.mul : 1;
      const max = P.speed * speedMul * (phys.maxMul || 1);
      const tx = inp.x * max, ty = inp.y * max;
      const moving = inp.x !== 0 || inp.y !== 0;
      let rate = moving ? phys.accel : phys.decel;
      if (me.airborne) rate *= P.airControl;
      let dvx = tx - me.vx, dvy = ty - me.vy;
      const dl = Math.hypot(dvx, dvy), step = rate * dt;
      if (dl > step) { dvx *= step / dl; dvy *= step / dl; }
      me.vx += dvx; me.vy += dvy;
      if (Math.abs(inp.x) > 0.1) me.facing = inp.x > 0 ? 1 : -1;
      const kd = Math.exp(-P.knockDecay * dt);
      me.kx *= kd; me.ky *= kd;
      me.x += (me.vx + me.kx) * dt;
      me.y += (me.vy + me.ky) * dt;
      this.separate(me);
      me.x = clamp(me.x, -300, CFG.world.w + 300);
      me.y = clamp(me.y, -300, CFG.world.h + 300);

      // 지면 / 점프 / 낙하 판정 (공중 높이 z 는 2D 좌표와 분리해 일관되게 처리)
      if (!me.airborne) {
        const g = this.groundAt(me.x, me.y, wi, now);
        if (g) me.lastGroundAt = now;
        const canJump = !!g || now - me.lastGroundAt <= P.coyoteMs;
        if (canJump && Input.consumeJump(pnow)) {
          me.vz = P.jumpVz * (me.fx.jump > now ? ITEMS.jump.mul : 1);
          me.airborne = true;
          me.z = 0.01;
        } else if (!g && now - me.lastGroundAt > P.coyoteMs) {
          this.startFall(now, wi);
          return;
        }
      }
      if (me.airborne) {
        let gr = P.gravity;
        if (me.fx.float > now && me.vz < 0) gr *= ITEMS.float.gravMul;
        me.vz -= gr * dt;
        me.z += me.vz * dt;
        if (me.z <= 0) {
          me.z = 0; me.vz = 0; me.airborne = false;
          if (this.groundAt(me.x, me.y, wi, now)) { me.landAt = pnow; me.lastGroundAt = now; }
          else { this.startFall(now, wi); return; }
        }
      }

      const hitting = pnow - me.hitAt < 450;
      me.st = me.airborne ? 'air' : hitting ? 'hit' : Math.hypot(me.vx, me.vy) > 30 ? 'run' : 'idle';
      for (const t of EFFECT_TYPES) if (me.fx[t] && me.fx[t] <= now) delete me.fx[t];
      this.checkPickups(now, pnow, wi);
      if (Input.consumeUse()) this.useItem(now, pnow);
    }

    separate(me) {
      const R2 = CFG.player.radius * 1.8;
      for (const v of this.views.values()) {
        if (v.isMe || v.hidden || v.dropping) continue;
        if (Math.abs(v.z - me.z) > 40) continue;
        const dx = me.x - v.x, dy = me.y - v.y, d = Math.hypot(dx, dy);
        if (d >= R2 || d === 0) continue;
        const push = (R2 - d) * 0.5;
        me.x += (dx / d) * push; me.y += (dy / d) * push;
      }
    }

    startFall(now, wi) {
      const me = this.me;
      if (me.fx.shield > now) {
        delete me.fx.shield;
        const safe = this.nearestSafe(me.x, me.y, wi, now);
        if (safe) {
          me.x = safe.x; me.y = safe.y; me.z = 0;
          me.vx = me.vy = me.kx = me.ky = me.vz = 0;
          me.airborne = false; me.lastGroundAt = now;
          this.ringFx(me.x, me.y, 0x9fd8ff, 120);
          this.popText(me.x, me.y - 80, '보호막!', '#bfe6ff');
          this.sendNow = true;
          return;
        }
      }
      me.falling = true;
      me.airborne = false;
      me.fallStart = now;
      me.fallVz = 0;
      me.st = 'drop';
      this.sendNow = true;
    }

    eliminate(now, alreadyRecorded) {
      const me = this.me;
      if (!me || !me.alive) return;
      me.alive = false;
      me.falling = false;
      me.st = 'out';
      this.sendNow = true;
      this.netSend(performance.now(), now);
      if (!alreadyRecorded) {
        roomRef(`match/elim/${Net.uid}`).set({ at: Math.round(now), ms: Math.round(Math.max(0, now - this.startAt)), mid: this.id })
          .catch((e) => logError('eliminate', e));
      }
      this.banner('탈락했어요. 관전 모드로 전환합니다.', true, 2600);
      this.enterSpectate(true);
    }

    checkPickups(now, pnow, wi) {
      const me = this.me;
      if (me.item || me.picking || me.z > 30) return;
      for (const it of Object.values(room.items)) {
        if (it.mid !== this.id || it.by || me.picked.has(it.key) || now - it.at > CFG.items.ttlMs) continue;
        if (Math.hypot(it.x - me.x, it.y - me.y) > CFG.items.pickupRadius) continue;
        if (!this.groundAt(it.x, it.y, wi, now)) continue;
        me.picking = true;
        me.picked.add(it.key);
        const type = it.t;
        roomRef(`match/items/${it.key}/by`).transaction((cur) => (cur ? undefined : Net.uid))
          .then((res) => {
            if (this.destroyed || !this.me) return;
            if (res.committed && res.snapshot.val() === Net.uid && this.me.alive && !this.me.item) {
              this.me.item = type;
              this.me.happyAt = performance.now();
              this.popText(this.me.x, this.me.y - 84, ITEMS[type].name, '#ffffff');
            }
          })
          .catch((e) => logError('pickup', e))
          .finally(() => { if (this.me) this.me.picking = false; });
        return;
      }
    }

    useItem(now, pnow) {
      const me = this.me;
      if (!me.item || now - me.useAt < CFG.items.useCooldownMs) return;
      const t = me.item;
      me.item = null;
      me.useAt = now;
      if (t === 'shock') {
        const fx = { by: Net.uid, x: Math.round(me.x), y: Math.round(me.y), at: Math.round(now), mid: this.id };
        roomRef('match/fx').push(fx).catch((e) => logError('shockwave', e));
        this.ringFx(me.x, me.y, hexNum(ITEMS.shock.color), ITEMS.shock.radius);
      } else {
        me.fx[t] = now + ITEMS[t].durMs; // 같은 효과는 중첩 없이 지속시간만 갱신
        this.ringFx(me.x, me.y, hexNum(ITEMS[t].color), 60);
      }
      this.popText(me.x, me.y - 84, ITEMS[t].name, '#ffffff');
      this.sendNow = true;
    }

    consumeFx(now, pnow) {
      for (const f of room.fxQueue) {
        if (this.fxSeen.has(f.key) || f.mid !== this.id) continue;
        this.fxSeen.add(f.key);
        if (now - f.at > 2000 || f.by === Net.uid) continue;
        this.ringFx(f.x, f.y, hexNum(ITEMS.shock.color), ITEMS.shock.radius);
        const me = this.me;
        if (!me || !me.alive || me.falling || me.frozenUntil) continue;
        const dx = me.x - f.x, dy = me.y - f.y, d = Math.hypot(dx, dy);
        const R = ITEMS.shock.radius;
        if (d > R) continue;
        const nx = d > 1 ? dx / d : Math.cos(Math.random() * 6.28), ny = d > 1 ? dy / d : Math.sin(Math.random() * 6.28);
        const force = ITEMS.shock.force * (1 - 0.5 * (d / R));
        me.kx += nx * force; me.ky += ny * force;
        me.vx *= 0.3; me.vy *= 0.3;
        if (!me.airborne) { me.airborne = true; me.vz = ITEMS.shock.hop; me.z = 0.01; }
        me.hitAt = pnow;
        this.sendNow = true;
      }
    }

    /* ---------- 렌더링 ---------- */
    updatePlatforms(now, pnow, wi) {
      const warnMs = CFG.collapse.warnMs;
      const lowfx = App.settings.lowfx;
      for (const pv of this.platformViews) {
        const st = platformState(pv.p.id, wi, now);
        if (st !== pv.st) {
          if (st === 'gone') {
            const at = wi.map.get(pv.p.id);
            pv.warn.setAlpha(0); pv.crack.setVisible(false);
            if (!lowfx && now - (at + warnMs) < 1000) {
              this.scene.tweens.add({ targets: pv.g, y: pv.p.y + 80, alpha: 0, scaleX: 0.85, scaleY: 0.85, duration: 520, ease: 'Quad.easeIn', onComplete: () => pv.g.setVisible(false) });
            } else pv.g.setVisible(false);
          }
          pv.st = st;
        }
        if (st === 'warn') {
          const at = wi.map.get(pv.p.id);
          const prog = clamp((now - at) / warnMs, 0, 1);
          const a = lowfx ? 0 : 1 + prog * 4;
          const ox = a ? rand(-a, a) : 0, oy = a ? rand(-a * 0.5, a * 0.5) : 0;
          pv.g.setPosition(pv.p.x + ox, pv.p.y + oy);
          pv.warn.setPosition(pv.p.x + ox, pv.p.y + oy);
          pv.crack.setPosition(pv.p.x + ox, pv.p.y + oy);
          pv.warn.setAlpha(0.2 + 0.35 * (0.5 + 0.5 * Math.sin(pnow * 0.012 * (1 + prog * 2.5))));
          if (prog > 0.3 && !pv.cracked) this.drawCracks(pv);
        }
      }
    }

    updateItems(now, pnow, wi) {
      const seen = new Set();
      for (const it of Object.values(room.items)) {
        if (it.mid !== this.id || it.by || now - it.at > CFG.items.ttlMs) continue;
        if (!this.groundAt(it.x, it.y, wi, now)) continue;
        seen.add(it.key);
        let v = this.itemViews.get(it.key);
        if (!v) {
          const shadow = this.scene.add.ellipse(it.x, it.y, 30, 11, 0x000000, 0.2).setDepth(2);
          const img = this.scene.add.image(it.x, it.y - 28, `it_${it.t}`).setScale(0.44).setDepth(10 + it.y / 1000);
          v = { shadow, img, born: pnow };
          this.itemViews.set(it.key, v);
        }
        const k = Math.min(1, (pnow - v.born) / 250);
        const left = CFG.items.ttlMs - (now - it.at);
        v.img.y = it.y - 28 - Math.sin(pnow * 0.004 + it.x) * 5;
        v.img.setScale(0.44 * k);
        v.img.setAlpha(left < 3000 ? 0.45 + 0.55 * Math.abs(Math.sin(pnow * 0.012)) : 1);
      }
      for (const [key, v] of this.itemViews) {
        if (seen.has(key)) continue;
        v.shadow.destroy(); v.img.destroy();
        this.itemViews.delete(key);
      }
    }

    effString(m, now) {
      let e = '';
      for (const t of EFFECT_TYPES) if (m.fx[t] > now) e += ITEMS[t].code;
      return e;
    }

    renderPlayers(now, pnow, elim) {
      const renderT = pnow - CFG.net.interpDelayMs;
      for (const v of this.views.values()) {
        let d;
        if (v.isMe && this.me) {
          const m = this.me;
          d = { x: m.x, y: m.y, z: m.z, st: !m.alive ? 'out' : m.falling ? 'drop' : m.st, f: m.facing, e: this.effString(m, now) };
          v.hitAt = m.hitAt; v.landAt = m.landAt; v.happyAt = m.happyAt;
        } else {
          const rec = room.pos[v.id];
          d = rec && rec.mid === this.id ? samplePos(rec, renderT) : null;
          const r = this.meta.roster[v.id];
          if (!d) d = { x: r.sx, y: r.sy, z: 0, st: 'idle', f: 1, e: '' };
          if (elim[v.id] && d.st !== 'drop') d = { ...d, st: 'out' };
          if (d.st === 'hit' && pnow - v.hitAt > 500) v.hitAt = pnow;
          if (v.lastZ > 4 && d.z <= 0.5 && d.st !== 'drop') v.landAt = pnow;
          const pk = room.lastPick[v.id];
          if (pk && pk > v.happyAt) v.happyAt = pk;
        }
        this.renderView(v, d, pnow);
      }
    }

    renderView(v, d, pnow) {
      v.x = d.x; v.y = d.y; v.z = d.z;
      const dropping = d.st === 'drop' || d.st === 'out';
      if (dropping && !v.dropStart) v.dropStart = pnow;
      if (!dropping) v.dropStart = 0;
      v.dropping = dropping;
      const outDone = d.st === 'out' && (!v.dropStart || pnow - v.dropStart > CFG.player.fallMs + 150);
      if (outDone) {
        if (!v.hidden) {
          v.hidden = true;
          [v.shadow, v.ring, v.cont, v.label, ...v.badges].forEach((o) => o.setVisible(false));
        }
        return;
      }
      if (v.hidden) { v.hidden = false; [v.shadow, v.ring, v.cont].forEach((o) => o.setVisible(true)); }

      const t = pnow / 1000;
      const ch = charById(this.meta.roster[v.id].c);
      let sx = 1, sy = 1, rot = 0, off = 0, mood = 'normal', alpha = 1;
      const zs = Math.max(0, d.z);
      const hScale = 1 - Math.min(zs, 260) / 520;
      if (d.st === 'idle') {
        sy = 1 + 0.035 * ch.anim.bob * Math.sin(t * 4.2 + v.phase);
        sx = 1 - 0.02 * ch.anim.bob * Math.sin(t * 4.2 + v.phase);
      } else if (d.st === 'run') {
        off = -Math.abs(Math.sin(t * 13 + v.phase)) * ch.anim.runBounce;
        rot = 0.07 * Math.sin(t * 13 + v.phase);
      } else if (d.st === 'air') {
        if (d.z >= v.lastZ) { sx = 0.9; sy = 1.1; } else { sx = 0.96; sy = 1.04; }
      }
      if (pnow - v.landAt < 140) { const k = 1 - (pnow - v.landAt) / 140; sx += 0.2 * k; sy -= 0.18 * k; }
      if (dropping) {
        const k = clamp((pnow - v.dropStart) / CFG.player.fallMs, 0, 1);
        rot = k * 2.6 * (d.f || 1);
        sx = sy = 1 - 0.55 * k;
        alpha = 1 - 0.85 * k;
        mood = 'hurt';
      } else if (pnow - v.hitAt < 450 || d.st === 'hit') {
        mood = 'hurt';
        rot += 0.22 * Math.sin(pnow * 0.04);
      } else if (pnow - v.happyAt < 650) {
        mood = 'happy';
        off -= Math.sin(clamp((pnow - v.happyAt) / 650, 0, 1) * Math.PI) * 10;
      }
      if (mood !== v.mood) {
        v.mood = mood;
        v.body.setTexture(v.keys[mood]);
        if (v.keys.isImg) { if (mood === 'hurt') v.body.setTint(0xffb0b0); else v.body.clearTint(); }
      }
      v.body.setFlipX((d.f || 1) < 0);
      v.body.setScale(v.keys.base * sx * ch.size, v.keys.base * sy * ch.size);
      v.body.setRotation(rot);
      v.body.y = off;
      v.body.setAlpha(alpha);
      v.cont.setPosition(d.x, d.y - d.z);
      v.cont.setDepth(dropping ? -5 : 10 + d.y / 1000);
      v.shadow.setPosition(d.x, d.y).setScale(hScale).setVisible(!dropping);
      v.ring.setPosition(d.x, d.y).setScale(hScale).setVisible(!dropping);
      const shield = d.e.includes('H') && !dropping;
      v.bubble.setVisible(shield);
      if (shield) v.bubble.setScale(1 + 0.04 * Math.sin(pnow * 0.01));
      const showName = App.settings.names && !dropping;
      const ly = d.y - d.z - CFG.visual.charSize * 0.95 - 4;
      v.label.setVisible(showName).setPosition(d.x, ly);
      let bi = 0;
      const act = EFFECT_TYPES.filter((tp) => d.e.includes(ITEMS[tp].code));
      v.badges.forEach((b, i) => {
        const on = !dropping && act.includes(EFFECT_TYPES[i]);
        b.setVisible(on);
        if (on) {
          b.setPosition(d.x - ((act.length - 1) * 22) / 2 + bi * 22, (showName ? ly - 30 : ly - 6));
          bi += 1;
        }
      });
      v.lastZ = d.z;
    }

    ringFx(x, y, color, radius) {
      if (!this.scene || App.settings.lowfx && radius < 100) return;
      const e = this.scene.add.ellipse(x, y, 40, 24).setStrokeStyle(6, color, 1).setDepth(9);
      this.scene.tweens.add({
        targets: e, scaleX: (radius * 2) / 40, scaleY: (radius * 2 * 0.62) / 24, alpha: 0,
        duration: 480, ease: 'Cubic.easeOut', onComplete: () => e.destroy(),
      });
    }
    popText(x, y, text, color) {
      if (!this.scene) return;
      const t = this.scene.add.text(x, y, text, {
        fontFamily: 'Jua, "Noto Sans KR", sans-serif', fontSize: '18px', color, stroke: '#1d1836', strokeThickness: 5,
      }).setOrigin(0.5).setDepth(70).setResolution(2);
      this.scene.tweens.add({ targets: t, y: y - 36, alpha: 0, duration: 900, ease: 'Quad.easeOut', onComplete: () => t.destroy() });
    }

    /* ---------- 카메라 ---------- */
    cameraTarget() {
      if (this.me && this.me.alive) return { x: this.me.x, y: this.me.y - this.me.z * 0.3 };
      if (this.spec.active && !this.spec.all && this.spec.id) {
        const v = this.views.get(this.spec.id);
        if (v && !v.hidden) return { x: v.x, y: v.y };
      }
      return null;
    }
    updateCamera(dt) {
      const cam = this.scene.cameras.main;
      const vw = this.scene.scale.width, vh = this.scene.scale.height;
      if (!vw || !vh) return;
      const b = this.map.bounds;
      const fit = Math.min(vw / b.w, vh / b.h);
      const readable = Math.min(1.1, Math.min(vw, vh) / 560);
      const target = this.cameraTarget();
      let z, x, y;
      if (!target || this.spec.all || readable <= fit * 1.08) {
        z = fit; x = b.x + b.w / 2; y = b.y + b.h / 2;
      } else {
        z = readable;
        const hw = vw / z / 2, hh = vh / z / 2;
        x = hw * 2 >= b.w ? b.x + b.w / 2 : clamp(target.x, b.x + hw, b.x + b.w - hw);
        y = hh * 2 >= b.h ? b.y + b.h / 2 : clamp(target.y, b.y + hh, b.y + b.h - hh);
      }
      if (this.cam.z === null) { this.cam.z = z; this.cam.x = x; this.cam.y = y; }
      const k = 1 - Math.exp(-6 * dt);
      this.cam.z = lerp(this.cam.z, z, k);
      this.cam.x = lerp(this.cam.x, x, k);
      this.cam.y = lerp(this.cam.y, y, k);
      cam.setZoom(this.cam.z);
      cam.centerOn(this.cam.x, this.cam.y);
    }

    /* ---------- 관전 ---------- */
    aliveOthers() {
      const el = elimFor(this.id);
      return this.rosterIds.filter((id) => !el[id] && id !== Net.uid);
    }
    enterSpectate(delayed) {
      this.spec.active = true;
      if (!this.spec.id || !this.aliveOthers().includes(this.spec.id)) this.spec.id = this.aliveOthers()[0] || null;
      const show = () => { if (!this.destroyed) $('spectate-bar').hidden = false; };
      if (delayed) setTimeout(show, 900); else show();
    }
    cycleSpec(dir) {
      const list = this.aliveOthers();
      this.spec.all = false;
      if (!list.length) { this.spec.id = null; return; }
      const i = list.indexOf(this.spec.id);
      this.spec.id = list[(i + dir + list.length) % list.length];
    }

    /* ---------- HUD ---------- */
    banner(text, warn, ms = 2000) {
      const el = $('hud-banner');
      el.textContent = text;
      el.classList.toggle('is-warn', !!warn);
      el.hidden = false;
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
      clearTimeout(this.bannerTimer);
      this.bannerTimer = setTimeout(() => { el.hidden = true; }, ms);
    }
    updateHud(now, pnow, phase, elim) {
      const alive = this.rosterIds.filter((id) => !elim[id]).length;
      $('hud-alive').textContent = `${alive} / ${this.rosterIds.length}`;
      const elapsed = Math.max(0, now - this.startAt);
      $('hud-time').textContent = fmtTime(CFG.matchMaxMs - Math.min(elapsed, CFG.matchMaxMs));
      const si = phase === 'countdown' ? { idx: -1, label: '준비' } : stageInfo(elapsed);
      $('hud-stage').textContent = phase === 'ended' ? '경기 종료' : si.label;
      $('hud-conn').classList.toggle('is-bad', !Net.connected);

      const cd = $('countdown');
      if (phase === 'countdown') {
        const n = Math.max(1, Math.ceil((this.startAt - now) / 1000));
        if (this.lastCount !== n) {
          this.lastCount = n;
          cd.textContent = String(n);
          cd.hidden = false;
          cd.classList.remove('pop'); void cd.offsetWidth; cd.classList.add('pop');
        }
      } else if (phase === 'playing' && elapsed < 900) {
        if (this.lastCount !== 0) { this.lastCount = 0; cd.textContent = 'GO!'; cd.hidden = false; cd.classList.remove('pop'); void cd.offsetWidth; cd.classList.add('pop'); }
      } else if (!cd.hidden) cd.hidden = true;

      if (phase === 'playing' && si.idx !== this.stageIdx) {
        if (this.stageIdx !== -1 || si.idx > 0) {
          if (si.idx === 0) this.banner(`${Math.round(CFG.collapse.graceMs / 1000)}초 뒤 발판이 무너지기 시작해요!`, false, 2400);
          else if (si.idx === 99) this.banner('최종 단계! 중앙 안전 구역만 남습니다.', true, 2800);
          else this.banner(`${si.label} — ${si.idx === 1 ? '흔들리는 발판을 피하세요!' : '붕괴가 빨라집니다!'}`, true, 2400);
        } else this.banner(`${Math.round(CFG.collapse.graceMs / 1000)}초 뒤 발판이 무너지기 시작해요!`, false, 2400);
        this.stageIdx = si.idx;
      }
      if (phase === 'ended' && !this.endShown) { this.endShown = true; this.banner('경기 종료!', false, 3000); }

      const item = this.me && this.me.alive ? this.me.item : null;
      if (item !== this.hudItem) {
        this.hudItem = item;
        for (const id of ['hud-item-icon', 'touch-item-icon']) {
          const c = $(id), ctx = c.getContext('2d');
          ctx.clearRect(0, 0, c.width, c.height);
          if (item) ctx.drawImage(itemCanvas(item), 0, 0, c.width, c.height);
        }
        $('hud-item-label').textContent = item ? ITEMS[item].name : '아이템 없음';
        $('hud-item').classList.toggle('is-empty', !item);
        $('touch-item').classList.toggle('is-empty', !item);
      }
      $('hud-item').hidden = !(this.me && this.me.alive);

      const fxBox = $('hud-effects');
      let html = '';
      if (this.me && this.me.alive) {
        for (const t of EFFECT_TYPES) {
          const until = this.me.fx[t];
          if (until > now) html += `<div class="fx-chip" style="--c:${ITEMS[t].color}">${ITEMS[t].name} ${Math.ceil((until - now) / 1000)}초</div>`;
        }
      }
      if (fxBox.innerHTML !== html) fxBox.innerHTML = html;

      if (this.spec.active) {
        if (this.spec.id && elim[this.spec.id]) this.cycleSpec(1);
        if (!this.spec.id && !this.spec.all) { const l = this.aliveOthers(); this.spec.id = l[0] || null; }
        const v = this.spec.id && this.meta.roster[this.spec.id];
        $('spec-name').textContent = this.spec.all ? '전체 경기장' : v ? v.n : '생존자 없음';
      }
    }

    /* ---------- 네트워크 전송 (게임 루프와 분리된 주기) ---------- */
    netSend(pnow, now) {
      const m = this.me;
      if (!m || this.sentOut || m.frozenUntil) return;
      if (!this.sendNow && pnow - this.lastSend < CFG.net.sendIntervalMs) return;
      const st = !m.alive ? 'out' : m.falling ? 'drop' : m.st;
      const e = this.effString(m, now);
      const s = this.lastSent;
      if (s && !this.sendNow && Math.hypot(m.x - s.x, m.y - s.y) < CFG.net.minMoveDist && Math.abs(m.z - s.z) < 3 && s.st === st && s.e === e && s.f === m.facing) return;
      this.sendNow = false;
      this.lastSend = pnow;
      this.lastSent = { x: m.x, y: m.y, z: m.z, st, e, f: m.facing };
      if (st === 'out') this.sentOut = true;
      App.stats.posOut += 1;
      roomRef(`pos/${Net.uid}`).set({
        x: Math.round(m.x), y: Math.round(m.y), z: Math.round(clamp(m.z, -400, 400)),
        st, f: m.facing, e, t: Math.round(now), mid: this.id,
      }).catch((err) => { if (pnow - (this.lastErrAt || 0) > 5000) { this.lastErrAt = pnow; logError('send pos', err); } });
    }
  }

  function samplePos(rec, renderT) {
    const b = rec.buf;
    if (!b.length) return null;
    if (renderT <= b[0].t) return b[0];
    for (let i = b.length - 1; i >= 0; i--) {
      if (b[i].t <= renderT) {
        const a = b[i], c = b[i + 1];
        if (!c) return a;
        if (Math.hypot(c.x - a.x, c.y - a.y) > 250) return c; // 순간이동(보호막 구조 등)은 보간하지 않음
        const k = clamp((renderT - a.t) / (c.t - a.t || 1), 0, 1);
        return { x: lerp(a.x, c.x, k), y: lerp(a.y, c.y, k), z: lerp(a.z, c.z, k), st: k < 0.5 ? a.st : c.st, f: c.f, e: c.e };
      }
    }
    return b[b.length - 1];
  }

  /* ===================================================================
   * 13. UI: 메인·대기실·결과·메뉴
   * =================================================================== */
  function showScreen(name) {
    App.screen = name;
    for (const s of ['main', 'lobby', 'game', 'results']) $(`screen-${s}`).classList.toggle('is-active', s === name);
    if (name !== 'game') { closeMenu(); Input.reset(); }
    renderConnPills();
  }
  function showMainError(msg) { const el = $('main-error'); el.textContent = msg; el.hidden = !msg; }
  function hideMainError() { showMainError(''); }
  function setBusy(b) {
    App.busy = b;
    ['btn-create', 'btn-join', 'btn-practice', 'btn-admin-login', 'btn-admin-logout'].forEach((id) => {
      $(id).disabled = b || (id !== 'btn-practice' && !Net.fbReady) || !window.Phaser;
    });
    $('btn-create').textContent = b ? '처리 중…' : '방 만들기';
  }
  function renderAdminUi() {
    const admin = Net.isAdminAccount;
    $('btn-create').hidden = !admin;
    $('join-hint').hidden = admin;
    $('admin-login').hidden = admin;
    $('admin-logged').hidden = !admin;
    if (admin) $('admin-box').open = true;
  }
  function renderConnPills() {
    const rs = $('room-status');
    if (App.code) { rs.className = 'pill pill-ok'; rs.textContent = Net.mode === 'local' ? `연습 방 참가 중` : `방 참가 중 · ${App.code}`; }
    else { rs.className = 'pill'; rs.textContent = '방 참가 전'; }
    const lc = $('lobby-conn');
    if (Net.mode === 'local') { lc.className = 'pill pill-ok'; lc.textContent = '오프라인 연습'; }
    else { lc.className = `pill ${Net.connected ? 'pill-ok' : 'pill-bad'}`; lc.textContent = Net.connected ? '연결됨' : '연결 끊김'; }
  }

  let lobbyBuilt = false;
  function buildLobbyStatic() {
    if (lobbyBuilt) return;
    lobbyBuilt = true;
    const grid = $('char-grid');
    for (const c of CHARACTERS.filter((x) => x.selectable)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'char-card';
      b.dataset.id = c.id;
      b.setAttribute('role', 'radio');
      b.appendChild(charImg(c.id, c.preview.mood));
      const name = document.createElement('span'); name.className = 'cname'; name.textContent = c.name;
      const cnt = document.createElement('span'); cnt.className = 'ccount';
      b.append(name, cnt);
      b.addEventListener('click', () => selectCharacter(c.id));
      grid.appendChild(b);
    }
    const mg = $('map-grid');
    for (const id of [...MAP_LIST, 'random']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'map-card';
      b.dataset.id = id;
      b.setAttribute('role', 'radio');
      const img = new Image();
      img.src = mapPreviewUrl(id);
      img.alt = '';
      const n = document.createElement('span'); n.className = 'mname'; n.textContent = id === 'random' ? '무작위' : MAP_DEFS[id].name;
      const d = document.createElement('span'); d.className = 'mdesc'; d.textContent = id === 'random' ? '시작할 때 4개 맵 중 하나' : MAP_DEFS[id].desc;
      b.append(img, n, d);
      b.addEventListener('click', () => selectMap(id));
      mg.appendChild(b);
    }
  }
  function mapPreviewUrl(id) {
    const c = document.createElement('canvas');
    c.width = 280; c.height = 190;
    const ctx = c.getContext('2d');
    if (id === 'random') {
      ctx.fillStyle = '#efeaff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = '#6c5ce7'; ctx.font = 'bold 96px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('?', c.width / 2, c.height / 2 + 6);
      return c.toDataURL();
    }
    const m = getMap(id);
    const th = m.theme;
    ctx.fillStyle = th.void; ctx.fillRect(0, 0, c.width, c.height);
    const s = Math.min(c.width / m.bounds.w, c.height / m.bounds.h);
    const ox = (c.width - m.bounds.w * s) / 2 - m.bounds.x * s, oy = (c.height - m.bounds.h * s) / 2 - m.bounds.y * s;
    for (const pass of [0, 1]) {
      for (const p of m.platforms) {
        ctx.fillStyle = pass ? p.color || th.top : p.color ? shade(p.color, -70) : th.side;
        const dy = pass ? 0 : CFG.visual.platformDepth * s;
        ctx.beginPath();
        if (p.shape === 'circle') ctx.arc(ox + p.x * s, oy + p.y * s + dy, p.r * s, 0, Math.PI * 2);
        else ctx.rect(ox + (p.x - p.w / 2) * s, oy + (p.y - p.h / 2) * s + dy, p.w * s, p.h * s);
        ctx.fill();
      }
    }
    return c.toDataURL();
  }

  function selectCharacter(id) {
    if (!App.code || !CHAR_IDS.includes(id)) return;
    savePref('char', id);
    if (room.players[Net.uid]) room.players[Net.uid].characterId = id;
    renderLobby();
    roomRef(`players/${Net.uid}/characterId`).set(id).catch((e) => { logError('select char', e); toast(friendly(e), 'error'); });
  }
  function selectMap(id) {
    if (!isRoomAdmin()) return;
    roomRef('info/mapId').set(id).catch((e) => { logError('select map', e); toast(friendly(e), 'error'); });
  }
  function toggleSpectate() {
    const me = room.players[Net.uid];
    if (!me || !isRoomAdmin() || Net.mode === 'local') return;
    const next = !me.spectator;
    savePref('adminSpectate', next);
    roomRef(`players/${Net.uid}/spectator`).set(next).catch((e) => { logError('spectate', e); toast(friendly(e), 'error'); });
  }
  function toggleReady() {
    const me = room.players[Net.uid];
    if (!me) return;
    roomRef(`players/${Net.uid}/ready`).set(!me.ready).catch((e) => { logError('ready', e); toast(friendly(e), 'error'); });
  }

  function renderLobby() {
    if (!App.code || !room.info) return;
    const now = Net.now();
    const info = room.info;
    const admin = isRoomAdmin();
    const local = Net.mode === 'local';
    $('lobby-code').textContent = local ? '연습' : App.code;
    $('btn-copy').hidden = local;
    $('btn-leave').textContent = admin && !local ? '방 닫기' : '나가기';
    const players = Object.values(room.players).sort((a, b) => (a.joinedAt - b.joinedAt) || (a.id < b.id ? -1 : 1));
    const participants = onlineParticipants();
    $('lobby-count').textContent = `참가 ${players.filter((p) => !p.spectator).length} / ${info.maxPlayers}`;
    renderConnPills();

    const ul = $('player-list');
    const frag = document.createDocumentFragment();
    for (const p of players) {
      const li = document.createElement('li');
      const off = isPlayerStale(p, now);
      li.className = (p.id === Net.uid ? 'is-me ' : '') + (off ? 'is-off' : '');
      li.appendChild(charImg(p.characterId, 'normal'));
      const nm = document.createElement('span');
      nm.className = 'pname';
      nm.textContent = p.nickname + (p.id === Net.uid ? ' (나)' : '');
      const sub = document.createElement('span');
      sub.className = 'pchar';
      sub.textContent = charById(p.characterId).name;
      nm.appendChild(sub);
      li.appendChild(nm);
      const isAdm = p.id === info.adminId;
      if (isAdm) li.insertAdjacentHTML('beforeend', `<span class="badge badge-host">${p.spectator ? '관리자 · 진행만' : '관리자'}</span>`);
      else if (p.id === info.hostId) li.insertAdjacentHTML('beforeend', '<span class="badge badge-host">진행 대행</span>');
      if (off) li.insertAdjacentHTML('beforeend', '<span class="badge badge-off">연결 끊김</span>');
      else if (p.ready) li.insertAdjacentHTML('beforeend', '<span class="badge badge-ready">준비</span>');
      else if (!isAdm) li.insertAdjacentHTML('beforeend', '<span class="badge">대기</span>');
      frag.appendChild(li);
    }
    ul.replaceChildren(frag);

    const me = room.players[Net.uid];
    const myChar = me ? me.characterId : DEFAULT_CHAR;
    const counts = {};
    players.forEach((p) => { counts[p.characterId] = (counts[p.characterId] || 0) + 1; });
    document.querySelectorAll('.char-card').forEach((b) => {
      const sel = b.dataset.id === myChar;
      b.classList.toggle('is-selected', sel);
      b.setAttribute('aria-checked', String(sel));
      b.querySelector('.ccount').textContent = counts[b.dataset.id] ? String(counts[b.dataset.id]) : '';
    });
    document.querySelectorAll('.map-card').forEach((b) => {
      const sel = b.dataset.id === info.mapId;
      b.classList.toggle('is-selected', sel);
      b.setAttribute('aria-checked', String(sel));
      b.disabled = !admin;
    });
    $('map-hint').textContent = admin ? '관리자가 선택합니다' : '관리자가 선택 중';

    const rb = $('btn-ready');
    if (admin) {
      // 관리자는 준비 대신 "나도 참가 / 진행만"을 매번 고름
      rb.hidden = local;
      const plays = !!(me && !me.spectator);
      rb.textContent = plays ? '나도 참가: 켜짐' : '나도 참가: 꺼짐 (진행만)';
      rb.classList.toggle('is-on', plays);
    } else {
      rb.hidden = false;
      rb.textContent = me && me.ready ? '준비 취소' : '준비 완료';
      rb.classList.toggle('is-on', !!(me && me.ready));
    }
    const sb = $('btn-start');
    sb.hidden = !admin;
    const need = minNeeded();
    const others = participants.filter((p) => p.id !== info.adminId);
    const readyN = others.filter((p) => p.ready).length;
    sb.disabled = participants.length < need || App.starting;
    sb.textContent = others.length ? `경기 시작 (준비 ${readyN}/${others.length})` : '경기 시작';
    const note = $('lobby-note');
    if (local) note.textContent = '혼자 연습하는 오프라인 방입니다. 기록은 저장되지 않아요.';
    else if (admin) note.textContent = participants.length < need ? `참가자가 ${need}명 이상 모이면 시작할 수 있어요. 방 코드를 공유하세요.` : '준비하지 않은 참가자도 함께 시작됩니다.';
    else if (!adminOnline()) note.textContent = '관리자 연결이 끊겼습니다. 관리자가 다시 연결될 때까지 기다려 주세요.';
    else note.textContent = '관리자가 경기를 시작할 때까지 기다려 주세요.';
  }

  function renderResults() {
    const r = room.result;
    const meta = room.meta;
    if (!r || !meta) return;
    const solo = Object.keys(meta.roster).length < 2;
    const winners = r.ranking.filter((e) => e.rank === 1);
    const mine = r.ranking.find((e) => e.id === Net.uid);
    let title, sub;
    if (solo) {
      title = mine && mine.alive ? '끝까지 살아남았어요!' : '연습 종료';
      sub = mine ? `생존 시간 ${fmtSec(mine.ms)}` : '';
    } else if (!winners.length) {
      title = '무승부'; sub = '';
    } else if (winners.length > 1) {
      title = '공동 우승!';
      sub = winners.map((w) => w.n).join(', ');
    } else {
      title = `${winners[0].n} 우승!`;
      sub = winners[0].alive ? '마지막까지 살아남았습니다.' : '가장 늦게 떨어졌습니다.';
    }
    if (mine && !solo) sub += `${sub ? ' · ' : ''}내 순위 ${mine.rank}위`;
    $('res-eyebrow').textContent = `${getMap(meta.mapId).name} · 경기 종료`;
    $('res-title').textContent = title;
    $('res-sub').textContent = sub;
    const wImg = $('res-winner-img');
    const wc = (winners[0] || mine || r.ranking[0] || { c: DEFAULT_CHAR }).c;
    const fresh = charImg(wc, 'happy');
    wImg.onerror = fresh.onerror;
    wImg.src = fresh.src;
    wImg.alt = charById(wc).name;

    const tb = $('res-body');
    const frag = document.createDocumentFragment();
    for (const e of r.ranking) {
      const tr = document.createElement('tr');
      if (e.id === Net.uid) tr.className = 'is-me';
      const status = e.alive ? '<span class="ok">생존</span>' : `<span class="out">${e.dc ? '연결 끊김' : '탈락'}</span>`;
      tr.innerHTML = `<td class="rk">${e.rank}</td><td><span class="who"></span></td><td>${fmtSec(e.ms)}</td><td>${status}</td>`;
      const who = tr.querySelector('.who');
      who.appendChild(charImg(e.c, e.rank === 1 ? 'happy' : 'normal'));
      who.appendChild(document.createTextNode(e.n + (e.id === Net.uid ? ' (나)' : '')));
      frag.appendChild(tr);
    }
    tb.replaceChildren(frag);

    const admin = isRoomAdmin();
    const need = minNeeded();
    const n = onlineParticipants().length;
    $('btn-rematch').hidden = !admin;
    $('btn-rematch').disabled = n < need || App.starting;
    $('res-note').textContent = admin
      ? (n < need ? `재경기에는 참가자가 최소 ${need}명 필요합니다.` : '재경기는 같은 맵 설정으로 바로 시작됩니다.')
      : '관리자가 재경기를 시작하면 자동으로 참가합니다.';
  }

  function toggleMenu() { if (App.menuOpen) closeMenu(); else openMenu(); }
  function openMenu() {
    App.menuOpen = true;
    Input.reset();
    $('menu').hidden = false;
    $('menu-leave').textContent = isRoomAdmin() && Net.mode !== 'local' ? '방 닫기' : '방 나가기';
    renderMenuStats();
  }
  function closeMenu() { App.menuOpen = false; $('menu').hidden = true; }
  function renderMenuStats() {
    const n = App.match ? App.match.rosterIds.length : 0;
    $('menu-stats').textContent = `위치 전송 ${App.stats.outRate}회/초 · 수신 ${App.stats.inRate}회/초 · 참가 ${n}명 · ${Net.mode === 'local' ? '오프라인' : Net.connected ? '온라인' : '연결 끊김'}`;
  }

  function drawLogo() {
    const c = $('logo-mascot');
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(charCanvas(DEFAULT_CHAR, 'happy'), 0, 0, c.width, c.height);
  }

  function detectTouch() {
    const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
    if (coarse || navigator.maxTouchPoints > 1) document.body.classList.add('touch');
    window.addEventListener('touchstart', () => document.body.classList.add('touch'), { once: true, passive: true });
  }

  function wireUi() {
    $('nickname').value = loadPref('nickname', '');
    $('nickname').addEventListener('keydown', (e) => { if (e.key === 'Enter') (Net.isAdminAccount ? createRoom() : $('room-code-input').focus()); });
    $('admin-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') adminLogin(); });
    $('btn-admin-login').addEventListener('click', () => adminLogin());
    $('btn-admin-logout').addEventListener('click', () => adminLogout());
    $('room-code-input').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CFG.codeLength); });
    $('room-code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinByCode(); });
    $('btn-create').addEventListener('click', () => createRoom());
    $('btn-join').addEventListener('click', () => joinByCode());
    $('btn-practice').addEventListener('click', () => createRoom({ local: true }));
    $('btn-leave').addEventListener('click', () => leaveRoom());
    $('btn-copy').addEventListener('click', () => {
      const code = App.code;
      if (!code) return;
      const done = () => toast('방 코드를 복사했습니다.', 'ok');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(done).catch(() => window.prompt('방 코드를 복사하세요', code));
      } else window.prompt('방 코드를 복사하세요', code);
    });
    $('btn-ready').addEventListener('click', () => (isRoomAdmin() ? toggleSpectate() : toggleReady()));
    $('btn-start').addEventListener('click', () => adminStartMatch());
    $('btn-rematch').addEventListener('click', () => adminStartMatch());
    $('btn-to-lobby').addEventListener('click', () => {
      if (isRoomAdmin()) adminResetToLobby();
      else { App.viewOverride = 'lobby'; route(); }
    });
    $('btn-menu').addEventListener('click', toggleMenu);
    $('menu-close').addEventListener('click', closeMenu);
    $('menu-leave').addEventListener('click', () => { closeMenu(); leaveRoom(); });
    $('spec-prev').addEventListener('click', () => App.match && App.match.cycleSpec(-1));
    $('spec-next').addEventListener('click', () => App.match && App.match.cycleSpec(1));
    $('spec-all').addEventListener('click', () => { if (App.match) App.match.spec.all = !App.match.spec.all; });
    $('fatal-reload').addEventListener('click', () => location.reload());
    $('fatal-close').addEventListener('click', () => { $('fatal').hidden = true; });
    App.settings = { ...App.settings, ...loadPref('settings', {}) };
    $('opt-names').checked = App.settings.names;
    $('opt-lowfx').checked = App.settings.lowfx;
    $('opt-names').addEventListener('change', (e) => { App.settings.names = e.target.checked; savePref('settings', App.settings); });
    $('opt-lowfx').addEventListener('change', (e) => { App.settings.lowfx = e.target.checked; savePref('settings', App.settings); });
    window.addEventListener('error', (e) => logError('window error', e.error || e.message));
    window.addEventListener('unhandledrejection', (e) => logError('unhandled rejection', e.reason));
  }

  /* ===================================================================
   * 14. 부팅
   * =================================================================== */
  async function boot() {
    try {
      detectTouch();
      wireUi();
      Input.init();
      drawLogo();
      buildLobbyStatic();
      setBusy(false);
      const cdn = window.__cdnErrors || [];
      if (!window.Phaser) {
        showMainError('게임 엔진(Phaser)을 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침해 주세요.');
        setFbStatus('bad', 'CDN 로드 실패');
        setBusy(false);
        return;
      }
      const ok = await initFirebase();
      if (!ok && cdn.length) showMainError(`외부 라이브러리를 불러오지 못했습니다: ${cdn.join(', ')}. 혼자 연습하기만 이용할 수 있어요.`);
      setBusy(false);
      const sess = loadSession();
      if (ok && sess && sess.code && !sess.local && /^[A-Z0-9]{6}$/.test(sess.code)) {
        App.nickname = cleanNickname(sess.nickname) || cleanNickname($('nickname').value);
        if (!App.nickname) { clearSession(); return; }
        $('nickname').value = App.nickname;
        setBusy(true);
        try {
          await withTimeout(new Promise((res) => {
            if (Net.fbConnected) { res(); return; }
            const iv = setInterval(() => { if (Net.fbConnected) { clearInterval(iv); res(); } }, 200);
          }), CFG.net.requestTimeoutMs, '서버 연결이 지연되고 있습니다.');
          await joinRoom(sess.code, {});
        } catch (e) {
          clearSession();
          logError('rejoin', e);
          showMainError('이전 방에 다시 참가하지 못했습니다. ' + friendly(e));
        } finally {
          setBusy(false);
        }
      }
    } catch (e) {
      logError('boot', e);
      showFatal('초기화 중 오류가 발생했습니다. 새로고침해 주세요.');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
