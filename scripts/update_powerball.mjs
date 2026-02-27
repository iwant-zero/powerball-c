import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const DRAWS_PATH = path.join(DATA_DIR, "powerball_draws.json");
const FREQ_PATH = path.join(DATA_DIR, "powerball_freq.json");

// ✅ 공개 로그(JSON) 제공 소스 (POST dayLog)
const SOURCE_URL = "https://www.powerballgame.co.kr/";

// 기본: 저장하는 “원본 draw 로그”는 최근 N일치만 유지(파일 폭증 방지)
const KEEP_DAYS = Number(process.env.PB_KEEP_DAYS || "365");
// 업데이트 시 “최근 며칠”을 다시 긁을지(누락/지연 대비)
const REFRESH_DAYS = Number(process.env.PB_REFRESH_DAYS || "7");

function isArg(name) {
  return process.argv.includes(name);
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
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 350 * (i + 1)));
    }
  }
  throw lastErr;
}
async function fetchDayLog(ymd) {
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
      const balls = String(r.number || "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => Number(x));

      const pb = Number(r.powerball);
      const round = Number(r.round);
      const todayRound = Number(r.todayRound);

      if (!Number.isFinite(round) || balls.length < 5 || !Number.isFinite(pb)) continue;

      const five = balls.slice(0, 5);
      const sum = five.reduce((a, b) => a + b, 0);

      draws.push({
        ymd,
        round,
        todayRound,
        balls: five,
        powerball: pb,
        sum,
        _src: "powerballgame.co.kr",
      });
    }

    if (resp.endYN === "Y") break;
    page += 1;
    if (page > 200) break;
  }
  return draws;
}

// -------------------------
// 카테고리(숫자합 게임) 분류
// -------------------------
function sumSizeKey(sum) {
  // 소(15~64), 중(65~80), 대(81~130)
  if (sum <= 64) return "S";
  if (sum <= 80) return "M";
  return "L";
}
function sumBandKey(sum) {
  // A:15~35, B:36~49, C:50~57, D:58~65, E:66~78, F:79~130
  if (sum <= 35) return "A";
  if (sum <= 49) return "B";
  if (sum <= 57) return "C";
  if (sum <= 65) return "D";
  if (sum <= 78) return "E";
  return "F";
}
function oddEvenKey(n) {
  return n % 2 ? "ODD" : "EVEN";
}
function powerBandKey(pb) {
  // A:0~2, B:3~4, C:5~6, D:7~9
  if (pb <= 2) return "A";
  if (pb <= 4) return "B";
  if (pb <= 6) return "C";
  return "D";
}

// -------------------------
// 카운터 초기화
// -------------------------
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
function initCountsSum() {
  return {
    size: { S: 0, M: 0, L: 0 },
    band: { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 },
    oddEven: { ODD: 0, EVEN: 0 },
    powerBand: { A: 0, B: 0, C: 0, D: 0 },
  };
}
function bump(obj, key) {
  if (obj[key] == null) obj[key] = 0;
  obj[key] += 1;
}
function ensureFreqShape(freqDoc) {
  // 구버전 호환(혹시 allTime.normal/power만 있으면 select로도 복사)
  if (!freqDoc.allTime) freqDoc.allTime = {};
  if (!freqDoc.recent) freqDoc.recent = {};
  if (!freqDoc.allTime.select) freqDoc.allTime.select = {};
  if (!freqDoc.allTime.sum) freqDoc.allTime.sum = initCountsSum();

  // select.normal/power
  const n = freqDoc.allTime.select.normal || freqDoc.allTime.normal || initCountsNormal();
  const p = freqDoc.allTime.select.power || freqDoc.allTime.power || initCountsPower();
  freqDoc.allTime.select.normal = n;
  freqDoc.allTime.select.power = p;

  // legacy 유지(기존 UI/툴이 참조할 수도)
  freqDoc.allTime.normal = n;
  freqDoc.allTime.power = p;

  if (!Number.isFinite(freqDoc.allTime.totalDraws)) freqDoc.allTime.totalDraws = 0;
  if (!Number.isFinite(freqDoc.allTime.lastRound)) freqDoc.allTime.lastRound = 0;

  if (!freqDoc.recent.d1) freqDoc.recent.d1 = null;
  if (!freqDoc.recent.d7) freqDoc.recent.d7 = null;
  if (!freqDoc.recent.d30) freqDoc.recent.d30 = null;

  return freqDoc;
}

// -------------------------
// 윈도우(최근) 카운트 계산
// -------------------------
function calcWindowCounts(draws, latestYmd, windowDays) {
  const cut = addDaysYmd(latestYmd, -(windowDays - 1));

  const select = { normal: initCountsNormal(), power: initCountsPower() };
  const sum = initCountsSum();
  let totalDraws = 0;

  for (const d of draws) {
    if (d.ymd < cut) continue;
    totalDraws += 1;
    for (const b of d.balls) bump(select.normal, String(b));
    bump(select.power, String(d.powerball));

    bump(sum.size, sumSizeKey(d.sum));
    bump(sum.band, sumBandKey(d.sum));
    bump(sum.oddEven, oddEvenKey(d.sum));
    bump(sum.powerBand, powerBandKey(d.powerball));
  }

  return { windowDays, fromYmd: cut, toYmd: latestYmd, totalDraws, select, sum };
}

// -------------------------
// 결정론 RNG (Math.random/crypto 사용 안 함)
// -------------------------
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
  const scores = [];
  for (const key of Object.keys(allCounts)) {
    const cAll = allCounts[key] || 0;
    const cWin = (winCounts && winCounts[key]) || 0;
    const pAll = allTotal > 0 ? cAll / allTotal : 0;
    const pWin = winTotal > 0 ? cWin / winTotal : 0;
    const s = (1 - alpha) * pAll + alpha * pWin;
    scores.push({ k: key, s });
  }
  scores.sort((a, b) => b.s - a.s || String(a.k).localeCompare(String(b.k)));
  return scores;
}
function bandSplitGeneric(sortedKeys) {
  const n = sortedKeys.length;
  const topN = Math.max(1, Math.floor(n * 0.35));
  const lowN = Math.max(1, Math.floor(n * 0.25));
  const top = sortedKeys.slice(0, topN);
  const mid = sortedKeys.slice(topN, Math.max(topN, n - lowN));
  const low = sortedKeys.slice(Math.max(topN, n - lowN));
  return { top, mid, low };
}
function pickOneFromBands(bands, nextU64) {
  // cycle마다 top/mid/low 섞기
  const gate = Number(nextU64() % 100n);
  const pool =
    gate < 55 ? bands.top :
    gate < 85 ? (bands.mid.length ? bands.mid : bands.top) :
                (bands.low.length ? bands.low : bands.top);

  return pool[Number(nextU64() % BigInt(pool.length))];
}

// -------------------------
// 추천기: 숫자선택
// -------------------------
function makeRecommendSelect(freq, opts) {
  const mode = opts.mode; // "1d"|"7d"|"30d"
  const alpha = mode === "1d" ? 0.65 : mode === "7d" ? 0.45 : 0.25;

  const allTotal = freq.allTime?.totalDraws || 0;
  const allNormal = (freq.allTime?.select?.normal) || freq.allTime?.normal || initCountsNormal();
  const allPower = (freq.allTime?.select?.power) || freq.allTime?.power || initCountsPower();

  const win = mode === "1d" ? freq.recent?.d1 : mode === "7d" ? freq.recent?.d7 : freq.recent?.d30;
  const winTotal = win?.totalDraws || 0;
  const winNormal = win?.select?.normal || initCountsNormal();
  const winPower = win?.select?.power || initCountsPower();

  const normalScores = scoreList(allNormal, allTotal, winNormal, winTotal, alpha);
  const powerScores = scoreList(allPower, allTotal, winPower, winTotal, alpha);

  const normalBand = bandSplitGeneric(normalScores.map((x) => Number(x.k)));
  const powerBand = bandSplitGeneric(powerScores.map((x) => Number(x.k)));

  const seedStr = `${opts.seed}|select|${mode}|${freq.updatedAt}|${freq.allTime?.lastRound || 0}`;
  const base = fnv1a64(seedStr);
  const cycle = BigInt(opts.cycle);
  const next = splitmix64(base ^ (cycle * 0x9e3779b97f4a7c15n) ^ BigInt(opts.salt || 0));

  const t = 1 + Number(next() % 3n);            // top 1..3
  const l = 1 + Number((next() >> 7n) % 2n);    // low 1..2
  let m = 5 - t - l;
  if (m < 0) m = 0;

  const balls = [
    ...pickUnique(normalBand.top, t, next),
    ...pickUnique(normalBand.mid, m, next),
    ...pickUnique(normalBand.low, 5 - t - m, next),
  ].slice(0, 5);

  const pPick = Number((next() >> 13n) % 3n);
  const pPool = pPick === 0 ? powerBand.top : pPick === 1 ? powerBand.mid : powerBand.low;
  const powerball = pickUnique(pPool, 1, next)[0];

  balls.sort((a, b) => a - b);
  return { game: "select", balls, powerball, mode };
}

// -------------------------
// 추천기: 숫자합(대/중/소 | A~F | 홀/짝) + 파워볼 구간(A~D)
// -------------------------
function makeRecommendSum(freq, opts) {
  const mode = opts.mode; // "1d"|"7d"|"30d"
  const rule = opts.rule; // "size"|"band"|"oddeven"
  const alpha = mode === "1d" ? 0.65 : mode === "7d" ? 0.45 : 0.25;

  const allTotal = freq.allTime?.totalDraws || 0;
  const allSum = freq.allTime?.sum || initCountsSum();

  const win = mode === "1d" ? freq.recent?.d1 : mode === "7d" ? freq.recent?.d7 : freq.recent?.d30;
  const winTotal = win?.totalDraws || 0;
  const winSum = win?.sum || initCountsSum();

  const sumScores = scoreList(allSum[rule], allTotal, winSum[rule], winTotal, alpha);
  const pbScores = scoreList(allSum.powerBand, allTotal, winSum.powerBand, winTotal, alpha);

  const sumBands = bandSplitGeneric(sumScores.map((x) => x.k));
  const pbBands = bandSplitGeneric(pbScores.map((x) => x.k));

  const seedStr = `${opts.seed}|sum|${rule}|${mode}|${freq.updatedAt}|${freq.allTime?.lastRound || 0}`;
  const base = fnv1a64(seedStr);
  const cycle = BigInt(opts.cycle);
  const next = splitmix64(base ^ (cycle * 0x9e3779b97f4a7c15n) ^ BigInt(opts.salt || 0));

  const sumPick = pickOneFromBands(sumBands, next);
  const pbPick = pickOneFromBands(pbBands, next);

  return { game: "sum", rule, sumPick, powerBand: pbPick, mode };
}

// -------------------------
// Issue 커맨드 파싱
// -------------------------
function parseIssueCommand(body) {
  // 예:
  // /pb game=select mode=7d seed=TEAM-A jump=1000 n=10
  // /pb game=sum rule=band mode=30d seed=닉네임 n=10
  const out = {
    seed: null,
    jump: 0,
    mode: null,
    game: null,
    rule: null,
    n: 10,
  };
  if (!body) return out;
  const line = String(body).split("\n")[0].trim();
  if (!line.includes("/pb") && !line.includes("/powerball")) return out;

  const parts = line.split(/\s+/);
  for (const p of parts) {
    if (p.startsWith("seed=")) out.seed = p.slice(5);
    if (p.startsWith("jump=")) out.jump = Number(p.slice(5)) || 0;
    if (p.startsWith("mode=")) out.mode = p.slice(5);
    if (p.startsWith("game=")) out.game = p.slice(5);
    if (p.startsWith("rule=")) out.rule = p.slice(5);
    if (p.startsWith("n=")) out.n = Math.max(1, Math.min(50, Number(p.slice(2)) || 10));
  }

  // normalize
  if (out.mode === "1" || out.mode === "1d") out.mode = "1d";
  else if (out.mode === "7" || out.mode === "7d") out.mode = "7d";
  else if (out.mode === "30" || out.mode === "30d") out.mode = "30d";
  else out.mode = null;

  if (out.game !== "sum") out.game = "select";
  if (out.rule !== "band" && out.rule !== "oddeven") out.rule = "size";

  return out;
}

// -------------------------
// main
// -------------------------
async function main() {
  await ensureDir(DATA_DIR);

  const nowYmd = kstTodayYmd();
  const drawsDoc = await readJsonSafe(DRAWS_PATH, { updatedAt: null, draws: [] });
  let freqDoc = await readJsonSafe(FREQ_PATH, {
    updatedAt: null,
    source: { url: SOURCE_URL },
    allTime: {
      totalDraws: 0,
      lastRound: 0,
      normal: initCountsNormal(),
      power: initCountsPower(),
      select: { normal: initCountsNormal(), power: initCountsPower() },
      sum: initCountsSum(),
    },
    recent: { d1: null, d7: null, d30: null },
  });
  freqDoc = ensureFreqShape(freqDoc);

  // -----------------------------
  // Issue 추천 모드
  // -----------------------------
  if (isArg("--issue")) {
    const cmd = parseIssueCommand(process.env.COMMENT_BODY || "");
    const mode = cmd.mode || "7d";
    const seed =
      cmd.seed ||
      `${process.env.ACTOR || "anonymous"}|issue-${process.env.ISSUE_NUMBER || "0"}`;
    const baseCycle =
      BigInt(cmd.jump || 0) + BigInt(Number(process.env.ISSUE_NUMBER || "0"));

    const n = cmd.n || 10;

    const lines = [];
    lines.push(`## 🎯 파워볼 추천 (결정론: 데이터+시드+cycle)`);
    lines.push(`- data updatedAt: \`${freqDoc.updatedAt}\``);
    lines.push(`- lastRound: \`${freqDoc.allTime.lastRound}\``);
    lines.push(`- seed: \`${seed}\``);
    lines.push(`- mode: **${mode}**`);
    lines.push(`- cycle: \`${baseCycle.toString()}\` (jump 반영)`);
    lines.push("");

    if (cmd.game === "sum") {
      lines.push(`### 🧮 숫자합 게임 추천 (rule=${cmd.rule})`);
      lines.push(`| # | 일반볼(합) 선택 | 파워볼 구간(A~D) |`);
      lines.push(`|---:|---|---|`);
      for (let i = 0; i < n; i++) {
        const rec = makeRecommendSum(freqDoc, {
          seed,
          cycle: Number(baseCycle) + i * 9973,
          salt: 71 + i,
          mode,
          rule: cmd.rule,
        });
        lines.push(`| ${i + 1} | ${rec.rule}:${rec.sumPick} | PB:${rec.powerBand} |`);
      }
      lines.push("");
      lines.push(`> 예: \`/pb game=sum rule=band mode=30d seed=TEAM-A jump=1000 n=10\``);
    } else {
      lines.push(`### 🎲 숫자선택 게임 추천`);
      lines.push(`| # | 일반볼(5) | 파워볼(1) |`);
      lines.push(`|---:|---|---:|`);
      for (let i = 0; i < n; i++) {
        const rec = makeRecommendSelect(freqDoc, {
          seed,
          cycle: Number(baseCycle) + i * 9973,
          salt: 17 + i,
          mode,
        });
        lines.push(`| ${i + 1} | ${rec.balls.join(", ")} | ${rec.powerball} |`);
      }
      lines.push("");
      lines.push(`> 예: \`/pb game=select mode=7d seed=TEAM-A jump=1000 n=10\``);
      lines.push(`> 숫자합: \`/pb game=sum rule=size mode=7d seed=TEAM-A n=10\``);
    }

    process.stdout.write(lines.join("\n"));
    return;
  }

  // -----------------------------
  // Update 모드 (Actions 스케줄)
  // -----------------------------
  const startYmd = addDaysYmd(nowYmd, -(REFRESH_DAYS - 1));
  const fetchDays = [];
  for (let i = 0; i < REFRESH_DAYS; i++) fetchDays.push(addDaysYmd(startYmd, i));

  const fetched = [];
  for (const ymd of fetchDays) {
    try {
      const dayDraws = await fetchDayLog(ymd);
      fetched.push(...dayDraws);
    } catch (e) {
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
  latestYmd = trimmed.length ? trimmed[trimmed.length - 1].ymd : nowYmd;

  // allTime 누적은 lastRound 이후만 더함
  let lastRound = Number(freqDoc.allTime.lastRound || 0);
  let totalDraws = Number(freqDoc.allTime.totalDraws || 0);

  const allNormal = freqDoc.allTime.select.normal || initCountsNormal();
  const allPower = freqDoc.allTime.select.power || initCountsPower();
  const allSum = freqDoc.allTime.sum || initCountsSum();

  for (const d of merged) {
    if (d.round <= lastRound) continue;

    totalDraws += 1;

    // 숫자선택(원 숫자)
    for (const b of d.balls) bump(allNormal, String(b));
    bump(allPower, String(d.powerball));

    // 숫자합(카테고리)
    bump(allSum.size, sumSizeKey(d.sum));
    bump(allSum.band, sumBandKey(d.sum));
    bump(allSum.oddEven, oddEvenKey(d.sum));
    bump(allSum.powerBand, powerBandKey(d.powerball));

    lastRound = Math.max(lastRound, d.round);
  }

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
    allTime: {
      totalDraws,
      lastRound,
      // legacy(기존 화면/도구 호환)
      normal: allNormal,
      power: allPower,
      // new
      select: { normal: allNormal, power: allPower },
      sum: allSum,
    },
    recent: { d1, d7, d30 },
  };

  await fs.writeFile(DRAWS_PATH, JSON.stringify(outDraws, null, 2), "utf8");
  await fs.writeFile(FREQ_PATH, JSON.stringify(outFreq, null, 2), "utf8");

  // ✅ 미러링 저장: /powerball-c/data 도 같이 만들어서 “경로 문제” 원천 차단
  const ALT_DATA_DIR = path.join(ROOT, "powerball-c", "data");
  const ALT_DRAWS_PATH = path.join(ALT_DATA_DIR, "powerball_draws.json");
  const ALT_FREQ_PATH = path.join(ALT_DATA_DIR, "powerball_freq.json");
  try {
    await ensureDir(ALT_DATA_DIR);
    await fs.writeFile(ALT_DRAWS_PATH, JSON.stringify(outDraws, null, 2), "utf8");
    await fs.writeFile(ALT_FREQ_PATH, JSON.stringify(outFreq, null, 2), "utf8");
    console.log(`[OK] Mirrored to ${ALT_DATA_DIR}`);
  } catch (e) {
    console.error("[WARN] Mirror write failed:", e?.message || e);
  }

  console.log(
    `[OK] Updated. draws=${trimmed.length}, allTime.totalDraws=${totalDraws}, lastRound=${lastRound}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
