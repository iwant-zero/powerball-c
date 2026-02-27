import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const DRAWS_PATH = path.join(DATA_DIR, "powerball_draws.json");
const FREQ_PATH = path.join(DATA_DIR, "powerball_freq.json");

// ✅ 공개 로그(JSON) 제공 소스 (POST dayLog)
// (동행복권 파워볼: 일반볼 1~28 중 5개 + 파워볼 0~9 중 1개)  :contentReference[oaicite:3]{index=3}
const SOURCE_URL = "https://www.powerballgame.co.kr/"; // :contentReference[oaicite:4]{index=4}

// 기본: 저장하는 “원본 draw 로그”는 최근 N일치만 유지(파일 폭증 방지)
const KEEP_DAYS = Number(process.env.PB_KEEP_DAYS || "365");
// 업데이트 시 “최근 며칠”을 다시 긁을지(누락/지연 대비)
const REFRESH_DAYS = Number(process.env.PB_REFRESH_DAYS || "7");

function isArg(name) {
  return process.argv.includes(name);
}
function argValue(prefix) {
  const it = process.argv.find((s) => s.startsWith(prefix));
  if (!it) return null;
  return it.slice(prefix.length);
}

function kstTodayYmd() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, "0");
  const d = String(kst.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function ymdToDate(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  // UTC로 잡고 계산(ymd 비교용)
  return new Date(Date.UTC(y, m - 1, d));
}
function addDaysYmd(ymd, deltaDays) {
  const dt = ymdToDate(ymd);
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function daysDiff(aYmd, bYmd) {
  const a = ymdToDate(aYmd).getTime();
  const b = ymdToDate(bYmd).getTime();
  return Math.floor((a - b) / (24 * 60 * 60 * 1000));
}

async function readJsonSafe(p, fallback) {
  try {
    const s = await fs.readFile(p, "utf8");
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function postForm(url, formObj, retry = 3) {
  const body = new URLSearchParams(formObj);
  let lastErr = null;
  for (let i = 0; i < retry; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "user-agent": "Mozilla/5.0 (GitHubActions; +https://github.com/)",
        },
        body,
      });
      const text = await res.text();
      // JSON 파싱
      const json = JSON.parse(text);
      return json;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 350 * (i + 1)));
    }
  }
  throw lastErr;
}

async function fetchDayLog(ymd) {
  // powerballgame.co.kr dayLog: page=1..n, endYN=Y면 종료 :contentReference[oaicite:5]{index=5}
  const draws = [];
  let page = 1;
  while (true) {
    const payload = {
      view: "action",
      action: "ajaxPowerballLog",
      actionType: "dayLog",
      date: ymd,
      page: String(page),
    };
    const resp = await postForm(SOURCE_URL, payload, 4);

    if (!resp || !Array.isArray(resp.content)) break;

    for (const r of resp.content) {
      // r.number = "1, 2, 3, 4, 5" (일반볼 5개)
      const balls = String(r.number || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => Number(x));

      const pb = Number(r.powerball);

      const round = Number(r.round); // 전체 회차(증가)
      const todayRound = Number(r.todayRound); // 당일 회차

      if (!Number.isFinite(round) || balls.length < 5 || !Number.isFinite(pb)) continue;

      draws.push({
        ymd,
        round,
        todayRound,
        balls: balls.slice(0, 5),
        powerball: pb,
        sum: Number(r.numberSum),
        meta: {
          ballOddEven: r.numberOddEven,
          ballUnderOver: r.numberUnderOver,
          powerOddEven: r.powerballOddEven,
          powerUnderOver: r.powerballUnderOver,
        },
        _src: "powerballgame.co.kr",
      });
    }

    if (resp.endYN === "Y") break;
    page += 1;
    if (page > 200) break; // 안전장치
  }
  return draws;
}

function initCountsNormal() {
  const obj = {};
  for (let i = 1; i <= 28; i++) obj[String(i)] = 0;
  return obj;
}
function initCountsPower() {
  const obj = {};
  for (let i = 0; i <= 9; i++) obj[String(i)] = 0;
  return obj;
}

function bumpCounts(counts, n) {
  const k = String(n);
  if (counts[k] == null) counts[k] = 0;
  counts[k] += 1;
}

function calcWindowCounts(draws, latestYmd, windowDays) {
  const cut = addDaysYmd(latestYmd, -(windowDays - 1));
  const normal = initCountsNormal();
  const power = initCountsPower();
  let totalDraws = 0;

  for (const d of draws) {
    if (d.ymd < cut) continue;
    totalDraws += 1;
    for (const b of d.balls) bumpCounts(normal, b);
    bumpCounts(power, d.powerball);
  }

  return { windowDays, fromYmd: cut, toYmd: latestYmd, totalDraws, normal, power };
}

/**
 * Issue 추천용: 결정론 RNG (Math.random/crypto 사용 안 함)
 * - SplitMix64 기반 (seedStr + cycle + salt)
 */
function fnv1a64(str) {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  return h;
}
function splitmix64(seed) {
  let x = seed & 0xffffffffffffffffn;
  return () => {
    x = (x + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
    let z = x;
    z = (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n & 0xffffffffffffffffn;
    z = (z ^ (z >> 27n)) * 0x94d049bb133111ebn & 0xffffffffffffffffn;
    return (z ^ (z >> 31n)) & 0xffffffffffffffffn;
  };
}
function pickUnique(list, k, nextU64) {
  const arr = list.slice();
  const out = [];
  while (out.length < k && arr.length > 0) {
    const idx = Number(nextU64() % BigInt(arr.length));
    out.push(arr[idx]);
    arr.splice(idx, 1);
  }
  return out;
}
function scoreList(allCounts, allTotal, winCounts, winTotal, alpha) {
  // 확률(p) 기반으로 섞기
  const scores = [];
  for (const key of Object.keys(allCounts)) {
    const cAll = allCounts[key] || 0;
    const cWin = winCounts[key] || 0;
    const pAll = allTotal > 0 ? cAll / allTotal : 0;
    const pWin = winTotal > 0 ? cWin / winTotal : 0;
    const s = (1 - alpha) * pAll + alpha * pWin;
    scores.push({ n: Number(key), s });
  }
  scores.sort((a, b) => b.s - a.s || a.n - b.n);
  return scores;
}
function bandSplit(sortedNums) {
  const n = sortedNums.length;
  const topN = Math.max(1, Math.floor(n * 0.35));
  const lowN = Math.max(1, Math.floor(n * 0.25));
  const top = sortedNums.slice(0, topN);
  const mid = sortedNums.slice(topN, n - lowN);
  const low = sortedNums.slice(n - lowN);
  return { top, mid, low };
}
function makeRecommend(freq, opts) {
  const mode = opts.mode; // "1d"|"7d"|"30d"
  const alpha = mode === "1d" ? 0.65 : mode === "7d" ? 0.45 : 0.25;

  const allTotal = freq.allTime?.totalDraws || 0;
  const allNormal = freq.allTime?.normal || initCountsNormal();
  const allPower = freq.allTime?.power || initCountsPower();

  const win = mode === "1d" ? freq.recent?.d1 : mode === "7d" ? freq.recent?.d7 : freq.recent?.d30;
  const winTotal = win?.totalDraws || 0;
  const winNormal = win?.normal || initCountsNormal();
  const winPower = win?.power || initCountsPower();

  const normalScores = scoreList(allNormal, allTotal, winNormal, winTotal, alpha);
  const powerScores = scoreList(allPower, allTotal, winPower, winTotal, alpha);

  const normalBand = bandSplit(normalScores.map((x) => x.n));
  const powerBand = bandSplit(powerScores.map((x) => x.n));

  const seedStr = `${opts.seed}|${mode}|${freq.updatedAt}|${freq.allTime?.lastRound || 0}`;
  const base = fnv1a64(seedStr);
  const cycle = BigInt(opts.cycle);

  const next = splitmix64(base ^ (cycle * 0x9e3779b97f4a7c15n) ^ BigInt(opts.salt || 0));

  // ✅ 랭크 밴드 분산: cycle마다 top/mid/low 비율이 계속 변함(“패턴 몇 개” 고정 방지)
  // top: 1~3, low: 1~2, mid는 나머지
  const t = 1 + Number(next() % 3n);        // 1..3
  const l = 1 + Number((next() >> 7n) % 2n); // 1..2
  let m = 5 - t - l;
  if (m < 0) m = 0;

  const balls = [
    ...pickUnique(normalBand.top, t, next),
    ...pickUnique(normalBand.mid, m, next),
    ...pickUnique(normalBand.low, 5 - t - m, next),
  ].slice(0, 5);

  // powerball은 top/mid/low 중 어디서 뽑을지 cycle에 따라 분산
  const pPick = Number((next() >> 13n) % 3n); // 0/1/2
  const pPool = pPick === 0 ? powerBand.top : pPick === 1 ? powerBand.mid : powerBand.low;
  const powerball = pickUnique(pPool, 1, next)[0];

  balls.sort((a, b) => a - b);
  return { balls, powerball, mode };
}

function parseIssueCommand(body) {
  // 예: "/pb seed=TEAM-A jump=1000 mode=7d"
  const out = { seed: null, jump: 0, mode: null };
  if (!body) return out;
  const line = String(body).split("\n")[0].trim();
  if (!line.includes("/pb") && !line.includes("/powerball")) return out;

  const parts = line.split(/\s+/);
  for (const p of parts) {
    if (p.startsWith("seed=")) out.seed = p.slice(5);
    if (p.startsWith("jump=")) out.jump = Number(p.slice(5)) || 0;
    if (p.startsWith("mode=")) out.mode = p.slice(5);
  }
  if (out.mode === "1" || out.mode === "1d") out.mode = "1d";
  else if (out.mode === "7" || out.mode === "7d") out.mode = "7d";
  else if (out.mode === "30" || out.mode === "30d") out.mode = "30d";
  else out.mode = null;

  return out;
}

async function main() {
  await ensureDir(DATA_DIR);

  const nowYmd = kstTodayYmd();
  const drawsDoc = await readJsonSafe(DRAWS_PATH, { updatedAt: null, draws: [] });
  const freqDoc = await readJsonSafe(FREQ_PATH, {
    updatedAt: null,
    source: { url: SOURCE_URL },
    allTime: { totalDraws: 0, lastRound: 0, normal: initCountsNormal(), power: initCountsPower() },
    recent: { d1: null, d7: null, d30: null },
  });

  // -----------------------------
  // Issue 추천 모드
  // -----------------------------
  if (isArg("--issue")) {
    const cmd = parseIssueCommand(process.env.COMMENT_BODY || "");
    const mode = cmd.mode || "7d";
    const seed = cmd.seed || `${process.env.ACTOR || "anonymous"}|issue-${process.env.ISSUE_NUMBER || "0"}`;
    const cycle = BigInt(cmd.jump || 0) + BigInt(Number(process.env.ISSUE_NUMBER || "0"));

    const sets = [];
    for (let i = 0; i < 10; i++) {
      sets.push(makeRecommend(freqDoc, { seed, cycle: Number(cycle) + i * 9973, salt: 17 + i, mode }));
    }

    const lines = [];
    lines.push(`## 🎯 파워볼(동행복권) 빈도 기반 추천 (결정론)`);
    lines.push(`- mode: **${mode}** (최근 가중)`);
    lines.push(`- seed: \`${seed}\``);
    lines.push(`- cycle: \`${cycle.toString()}\` (jump 반영)`);
    lines.push(`- data updatedAt: \`${freqDoc.updatedAt}\``);
    lines.push("");
    lines.push(`| # | 일반볼(5) | 파워볼(1) |`);
    lines.push(`|---:|---|---:|`);
    sets.forEach((s, idx) => {
      lines.push(`| ${idx + 1} | ${s.balls.join(", ")} | ${s.powerball} |`);
    });
    lines.push("");
    lines.push(`> 댓글 커맨드 예시: \`/pb seed=TEAM-A jump=1000 mode=7d\``);
    process.stdout.write(lines.join("\n"));
    return;
  }

  // -----------------------------
  // Update 모드 (Actions 스케줄)
  // -----------------------------
  // 최근 REFRESH_DAYS 만큼 다시 긁어서 병합
  const startYmd = addDaysYmd(nowYmd, -(REFRESH_DAYS - 1));
  const fetchDays = [];
  for (let i = 0; i < REFRESH_DAYS; i++) fetchDays.push(addDaysYmd(startYmd, i));

  const fetched = [];
  for (const ymd of fetchDays) {
    try {
      const dayDraws = await fetchDayLog(ymd);
      fetched.push(...dayDraws);
    } catch (e) {
      // 특정 날짜 실패해도 전체 실패로 만들지 않음(다음 스케줄에서 재시도)
      console.error(`[WARN] fetch failed for ${ymd}:`, e?.message || e);
    }
  }

  // 기존 draws + fetched 병합(라운드 기준)
  const map = new Map();
  for (const d of drawsDoc.draws || []) map.set(d.round, d);
  for (const d of fetched) map.set(d.round, d);

  const merged = Array.from(map.values()).sort((a, b) => a.round - b.round);

  // KEEP_DAYS 유지
  let latestYmd = merged.length ? merged[merged.length - 1].ymd : nowYmd;
  const keepFrom = addDaysYmd(latestYmd, -(KEEP_DAYS - 1));
  const trimmed = merged.filter((d) => d.ymd >= keepFrom);

  // allTime 누적은 freqDoc에 “마지막 round 이후”만 더함
  let lastRound = Number(freqDoc.allTime?.lastRound || 0);
  let totalDraws = Number(freqDoc.allTime?.totalDraws || 0);
  const allNormal = freqDoc.allTime?.normal || initCountsNormal();
  const allPower = freqDoc.allTime?.power || initCountsPower();

  // 새로 들어온 round만 누적
  for (const d of merged) {
    if (d.round <= lastRound) continue;
    totalDraws += 1;
    for (const b of d.balls) bumpCounts(allNormal, b);
    bumpCounts(allPower, d.powerball);
    lastRound = Math.max(lastRound, d.round);
  }

  latestYmd = trimmed.length ? trimmed[trimmed.length - 1].ymd : nowYmd;

  const d1 = calcWindowCounts(trimmed, latestYmd, 1);
  const d7 = calcWindowCounts(trimmed, latestYmd, 7);
  const d30 = calcWindowCounts(trimmed, latestYmd, 30);

  const updatedAt = new Date().toISOString();

  const outDraws = {
    updatedAt,
    source: { url: SOURCE_URL },
    keepDays: KEEP_DAYS,
    latestYmd,
    draws: trimmed,
  };

  const outFreq = {
    updatedAt,
    source: { url: SOURCE_URL },
    allTime: { totalDraws, lastRound, normal: allNormal, power: allPower },
    recent: { d1, d7, d30 },
  };

  await fs.writeFile(DRAWS_PATH, JSON.stringify(outDraws, null, 2), "utf8");
  await fs.writeFile(FREQ_PATH, JSON.stringify(outFreq, null, 2), "utf8");

  console.log(`[OK] Updated. draws=${trimmed.length}, allTime.totalDraws=${totalDraws}, lastRound=${lastRound}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
