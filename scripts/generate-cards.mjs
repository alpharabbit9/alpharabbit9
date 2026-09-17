#!/usr/bin/env node
/**
 * Regenerates the profile's data cards from live GitHub data:
 *
 *   assets/stats.svg      headline figures, stat list, language breakdown
 *   assets/activity.svg   daily contributions over the last 12 months
 *
 *   GH_TOKEN=<token> node scripts/generate-cards.mjs
 *
 * Env:
 *   GH_TOKEN / GITHUB_TOKEN  required. A classic PAT with `repo` + `read:user`
 *                            also counts private repos and private contributions;
 *                            the Actions GITHUB_TOKEN sees public data only.
 *   GH_LOGIN                 GitHub username (default: alpharabbit9)
 *
 * No dependencies — Node 18+ (global fetch).
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOGIN = process.env.GH_LOGIN || 'alpharabbit9';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_STATS = resolve(ROOT, 'assets', 'stats.svg');
const OUT_ACTIVITY = resolve(ROOT, 'assets', 'activity.svg');

if (!TOKEN) {
  console.error('Missing GH_TOKEN (or GITHUB_TOKEN).');
  process.exit(1);
}

/* ─────────────────────────── GitHub GraphQL ─────────────────────────── */

async function gql(query, variables) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `bearer ${TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': `${LOGIN}-profile-stats`,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 502 || res.status === 503 || res.status === 429) {
      const wait = attempt * 3000;
      console.warn(`HTTP ${res.status} from GitHub — retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }

    const body = await res.json();
    if (body.errors?.length) {
      throw new Error(`GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
    }
    if (!res.ok) throw new Error(`GitHub returned HTTP ${res.status}`);
    return body.data;
  }
  throw new Error('GitHub API unreachable after 4 attempts');
}

const PROFILE_QUERY = `
query($login:String!, $cursor:String) {
  user(login:$login) {
    createdAt
    followers { totalCount }
    pullRequests(states:[OPEN, CLOSED, MERGED]) { totalCount }
    issues { totalCount }
    repositoriesContributedTo(contributionTypes:[COMMIT, PULL_REQUEST, ISSUE, REPOSITORY]) { totalCount }
    repositories(first:100, after:$cursor, ownerAffiliations:OWNER, orderBy:{field:CREATED_AT, direction:DESC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes {
        name
        isFork
        isPrivate
        stargazerCount
        languages(first:12, orderBy:{field:SIZE, direction:DESC}) {
          edges { size node { name } }
        }
      }
    }
  }
}`;

const YEAR_QUERY = `
query($login:String!, $from:DateTime!, $to:DateTime!) {
  user(login:$login) {
    contributionsCollection(from:$from, to:$to) {
      totalCommitContributions
      restrictedContributionsCount
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`;

/* ─────────────────────────────── Collect ─────────────────────────────── */

async function collect() {
  let cursor = null;
  let user = null;
  const repos = [];

  do {
    const data = await gql(PROFILE_QUERY, { login: LOGIN, cursor });
    user = data.user;
    repos.push(...user.repositories.nodes);
    cursor = user.repositories.pageInfo.hasNextPage ? user.repositories.pageInfo.endCursor : null;
  } while (cursor);

  const own = repos.filter((r) => !r.isFork);

  const stars = own.reduce((sum, r) => sum + r.stargazerCount, 0);
  const publicRepos = own.filter((r) => !r.isPrivate).length;
  const privateRepos = own.filter((r) => r.isPrivate).length;

  const langBytes = new Map();
  for (const repo of own) {
    for (const edge of repo.languages.edges) {
      langBytes.set(edge.node.name, (langBytes.get(edge.node.name) || 0) + edge.size);
    }
  }

  // contributionsCollection is capped at one year per call — walk year by year.
  const createdAt = new Date(user.createdAt);
  const createdYear = createdAt.getUTCFullYear();
  const now = new Date();
  const thisYear = now.getUTCFullYear();

  let allTimeContributions = 0;
  let allTimeCommits = 0;
  const days = new Map();

  for (let year = createdYear; year <= thisYear; year++) {
    const from = new Date(Date.UTC(year, 0, 1, 0, 0, 0));
    const to = new Date(Date.UTC(year, 11, 31, 23, 59, 59));
    const data = await gql(YEAR_QUERY, {
      login: LOGIN,
      from: (from < createdAt ? createdAt : from).toISOString(),
      to: (to > now ? now : to).toISOString(),
    });

    const c = data.user.contributionsCollection;
    allTimeContributions += c.contributionCalendar.totalContributions;
    allTimeCommits += c.totalCommitContributions;

    for (const week of c.contributionCalendar.weeks) {
      for (const day of week.contributionDays) {
        days.set(day.date, day.contributionCount);
      }
    }
  }

  return {
    createdYear,
    stars,
    publicRepos,
    privateRepos,
    totalRepos: own.length,
    forks: repos.length - own.length,
    pullRequests: user.pullRequests.totalCount,
    issues: user.issues.totalCount,
    contributedTo: user.repositoriesContributedTo.totalCount,
    followers: user.followers.totalCount,
    allTimeContributions,
    allTimeCommits,
    days,
    langBytes,
  };
}

/* ──────────────────────────────── Derive ─────────────────────────────── */

function streaks(days) {
  const sorted = [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  if (!sorted.length) return { current: 0, longest: 0 };

  let longest = 0;
  let run = 0;
  let prev = null;

  for (const [date, count] of sorted) {
    const consecutive = prev !== null && Date.parse(date) - Date.parse(prev) === 86400000;
    run = count > 0 ? (consecutive ? run + 1 : 1) : 0;
    if (run > longest) longest = run;
    prev = date;
  }

  // Walk backwards from the last day in the calendar. A zero *today* does not
  // break the streak yet — the day isn't over.
  let current = 0;
  let i = sorted.length - 1;
  if (sorted[i][1] === 0) i--;
  for (; i >= 0 && sorted[i][1] > 0; i--) current++;

  return { current, longest };
}

function lastYearContributions(days) {
  const cutoff = Date.now() - 364 * 86400000;
  let total = 0;
  for (const [date, count] of days) {
    if (Date.parse(date) >= cutoff) total += count;
  }
  return total;
}

function topLanguages(langBytes, limit = 10) {
  const total = [...langBytes.values()].reduce((a, b) => a + b, 0);
  if (!total) return [];
  return [...langBytes.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, limit)
    .map(([name, size]) => ({ name, pct: (size / total) * 100 }));
}

/* ───────────────────────────────── SVG ───────────────────────────────── */

const SANS = "'Segoe UI','Helvetica Neue',Arial,sans-serif";
const MONO = "'JetBrains Mono','Cascadia Code',Consolas,monospace";
const GREYS = ['#F5F5F5', '#CFCFCF', '#A6A6A6', '#808080', '#5F5F5F', '#474747', '#3A3A3A', '#303030', '#282828', '#222222'];

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (n) => n.toLocaleString('en-US');
const headlineSize = (s) => (s.length <= 3 ? 76 : s.length === 4 ? 70 : s.length === 5 ? 60 : 52);

function headline(x, value, label, sub, delay) {
  const v = num(value);
  return (
    `<g opacity="0"><animate attributeName="opacity" from="0" to="1" dur="0.8s" begin="${delay}s" fill="freeze"/>` +
    `<text x="${x}" y="108" text-anchor="middle" font-family="${SANS}" font-size="${headlineSize(v)}" font-weight="800" fill="#F5F5F5">${v}</text>` +
    `<text x="${x}" y="150" text-anchor="middle" font-family="${MONO}" font-size="17" letter-spacing="3.5" fill="#8A8A8A">${label}</text>` +
    `<text x="${x}" y="176" text-anchor="middle" font-family="${MONO}" font-size="12" letter-spacing="2.5" fill="#4F4F4F">${sub}</text></g>`
  );
}

const ICONS = {
  star: `<path transform="translate(96 %Y%)" stroke="#9A9A9A" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round" d="M0 -9 L2.6 -2.8 L9.2 -2.8 L3.9 1.4 L5.8 8 L0 4 L-5.8 8 L-3.9 1.4 L-9.2 -2.8 L-2.6 -2.8 Z"/>`,
  commit: `<g transform="translate(96 %Y%)" stroke="#9A9A9A" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="0" cy="0" r="5"/><path d="M-11 0 h6 M5 0 h6"/></g>`,
  pr: `<g transform="translate(96 %Y%)" stroke="#9A9A9A" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="-7" cy="-7" r="3.2"/><circle cx="-7" cy="7" r="3.2"/><circle cx="7" cy="7" r="3.2"/><path d="M-7 -3.5 v11 M7 3.8 V-2 a3 3 0 0 0 -3 -3 h-4"/></g>`,
  issue: `<g transform="translate(96 %Y%)" stroke="#9A9A9A" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="0" cy="0" r="8"/></g><circle cx="96" cy="%Y%" r="1.9" fill="#9A9A9A"/>`,
  repo: `<g transform="translate(96 %Y%)" stroke="#9A9A9A" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M-8 -8 h11 a2 2 0 0 1 2 2 v14 h-11 a2 2 0 0 0 -2 2 z"/><path d="M-8 10 a2 2 0 0 1 2 -2 h11"/></g>`,
  graph: `<g transform="translate(96 %Y%)" stroke="#9A9A9A" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M-9 -9 v18 h18"/><path d="M-6 6 L-1 -1 L3 3 L8 -6"/></g>`,
};

function statRow(icon, label, value, index, isLast) {
  const y = 340 + index * 44;
  return (
    ICONS[icon].replaceAll('%Y%', String(y - 5)) +
    `<text x="122" y="${y}" font-family="${SANS}" font-size="17" fill="#A3A3A3">${esc(label)}</text>` +
    `<text x="740" y="${y}" text-anchor="end" font-family="${MONO}" font-size="19" font-weight="700" fill="#F2F2F2">${num(value)}</text>` +
    (isLast ? '' : `<line x1="96" y1="${y + 18}" x2="740" y2="${y + 18}" stroke="#191919" stroke-width="1"/>`)
  );
}

function buildSvg(s) {
  const { current, longest } = streaks(s.days);
  const pastYear = lastYearContributions(s.days);
  const langs = topLanguages(s.langBytes);

  const rows = [
    ['star', 'Total Stars Earned', s.stars],
    ['commit', 'Total Commits (all-time)', s.allTimeCommits],
    ['pr', 'Total Pull Requests', s.pullRequests],
    ['issue', 'Total Issues', s.issues],
    ['repo', 'Public Repositories', s.publicRepos],
    ['graph', 'Contributions (past year)', pastYear],
  ];

  // Language bar — proportional widths with a 1.5px gutter between segments.
  const BAR_X = 856;
  const BAR_W = 668;
  const GAP = 1.5;
  const usable = BAR_W - GAP * Math.max(0, langs.length - 1);
  // A minimum width keeps slivers visible; rescale afterwards so the bumped
  // segments can never push the bar past its track.
  let widths = langs.map((lang) => Math.max(4, (lang.pct / 100) * usable));
  const drawn = widths.reduce((a, b) => a + b, 0);
  if (drawn > usable) widths = widths.map((w) => (w / drawn) * usable);

  let cursor = BAR_X;
  const segments = langs
    .map((lang, i) => {
      const seg = `<rect x="${cursor.toFixed(1)}" y="328" width="${widths[i].toFixed(1)}" height="22" fill="${GREYS[i]}" clip-path="url(#barclip)" opacity="0"><animate attributeName="opacity" from="0" to="1" dur="0.5s" begin="${(0.6 + i * 0.08).toFixed(2)}s" fill="freeze"/></rect>`;
      cursor += widths[i] + GAP;
      return seg;
    })
    .join('\n');

  const legend = langs
    .map((lang, i) => {
      const y = 383 + Math.floor(i / 2) * 46;
      const col = i % 2;
      const sx = col === 0 ? 856 : 1204;
      const tx = col === 0 ? 878 : 1226;
      const px = col === 0 ? 1156 : 1504;
      return (
        `<rect x="${sx}" y="${y - 11}" width="12" height="12" rx="3" fill="${GREYS[i]}"/>` +
        `<text x="${tx}" y="${y}" font-family="${MONO}" font-size="15.5" fill="#B0B0B0">${esc(lang.name)}</text>` +
        `<text x="${px}" y="${y}" text-anchor="end" font-family="${MONO}" font-size="14.5" fill="#6E6E6E">${lang.pct.toFixed(1)}%</text>`
      );
    })
    .join('\n');

  const alt =
    `GitHub statistics for Rifat Ahmed: ${num(s.allTimeContributions)} all-time contributions since ${s.createdYear}, ` +
    `current streak ${current}, longest streak ${longest}, ${num(s.allTimeCommits)} commits, ${num(s.pullRequests)} pull requests, ` +
    `${num(s.issues)} issues, ${num(s.publicRepos)} public repositories, ${num(pastYear)} contributions in the past year. ` +
    `Most used languages: ${langs.map((l) => `${l.name} ${l.pct.toFixed(1)}%`).join(', ')}.`;

  return `<svg viewBox="0 0 1600 645" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(alt)}">
<!-- Generated by scripts/generate-stats.mjs — do not edit by hand. No timestamp here on
     purpose: the file then only changes when the numbers do, so CI commits stay meaningful. -->
${headline(345, s.allTimeContributions, 'CONTRIBUTIONS', `ALL TIME · SINCE ${s.createdYear}`, 0.1)}
${headline(1255, longest, 'LONGEST STREAK', 'DAYS', 0.5)}
<g><circle cx="800" cy="82" r="58" fill="none" stroke="#242424" stroke-width="3"/><circle cx="800" cy="82" r="58" fill="none" stroke="#F2F2F2" stroke-width="3" stroke-linecap="round" stroke-dasharray="364" stroke-dashoffset="364" transform="rotate(-90 800 82)"><animate attributeName="stroke-dashoffset" from="364" to="0" dur="1.3s" begin="0.3s" fill="freeze" calcMode="spline" keySplines="0.25 0.1 0.25 1"/></circle>
<g transform="translate(800 26)"><path d="M0 -14 C-9 -2 -12 6 -4 15 C-6 8 -2 4 0 2 C1 8 5 9 4 15 C11 8 12 -2 4 -9 C5 -4 3 -1 1 0 C2 -6 1 -10 0 -14 Z" fill="#FFFFFF"><animate attributeName="opacity" values="1;0.55;1" dur="1.4s" repeatCount="indefinite"/><animateTransform attributeName="transform" type="scale" additive="sum" values="1 1;1.08 0.94;1 1" dur="1.4s" repeatCount="indefinite"/></path></g>
<text x="800" y="104" text-anchor="middle" font-family="${SANS}" font-size="${headlineSize(num(current))}" font-weight="800" fill="#F5F5F5">${num(current)}</text><text x="800" y="168" text-anchor="middle" font-family="${MONO}" font-size="17" letter-spacing="3.5" fill="#8A8A8A">CURRENT STREAK</text><text x="800" y="192" text-anchor="middle" font-family="${MONO}" font-size="12" letter-spacing="2.5" fill="#4F4F4F">AS OF TODAY</text></g>
<line x1="573" y1="45" x2="573" y2="150" stroke="#262626" stroke-width="1.4"/>
<line x1="1027" y1="45" x2="1027" y2="150" stroke="#262626" stroke-width="1.4"/>
<rect x="40" y="232" width="740" height="384" rx="14" fill="#131313" stroke="#262626" stroke-width="1.5"/>
<rect x="72" y="232" width="50" height="3" fill="#FFFFFF"/>
<text x="76" y="284" font-family="${SANS}" font-size="21" font-weight="700" letter-spacing="1.5" fill="#F2F2F2">RIFAT AHMED — GITHUB STATS</text>
<line x1="76" y1="302" x2="744" y2="302" stroke="#1E1E1E" stroke-width="1.4"/>
${rows.map(([icon, label, value], i) => statRow(icon, label, value, i, i === rows.length - 1)).join('\n')}
<rect x="820" y="232" width="740" height="384" rx="14" fill="#131313" stroke="#262626" stroke-width="1.5"/>
<rect x="852" y="232" width="50" height="3" fill="#FFFFFF"/>
<text x="856" y="284" font-family="${SANS}" font-size="21" font-weight="700" letter-spacing="1.5" fill="#F2F2F2">MOST USED LANGUAGES</text>
<line x1="856" y1="302" x2="1524" y2="302" stroke="#1E1E1E" stroke-width="1.4"/>
<clipPath id="barclip"><rect x="856" y="328" width="668" height="22" rx="11"/></clipPath>
${segments}
<rect x="856" y="328" width="668" height="22" rx="11" fill="none" stroke="#262626" stroke-width="1"/>
${legend}
</svg>
`;
}

/* ─────────────────────────── Activity graph ──────────────────────────── */

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Axis ticks on 1 / 2 / 2.5 / 5 × 10ⁿ steps, always integers here. */
function axisTicks(maxValue, target = 4) {
  const safeMax = Math.max(1, maxValue);
  const raw = safeMax / target;
  const exp = Math.pow(10, Math.floor(Math.log10(raw)));
  let step = [1, 2, 2.5, 5, 10].map((m) => m * exp).find((s) => s >= raw) ?? 10 * exp;
  step = Math.max(1, Math.round(step));

  const out = [];
  for (let t = 0; t <= safeMax; t += step) out.push(t);
  if (out[out.length - 1] < safeMax) out.push(out[out.length - 1] + step);
  return out;
}

// JetBrains Mono (and every fallback in MONO) is monospaced at 0.6em advance,
// so label widths are computable — no measuring needed to lay the legend out.
const monoWidth = (text, size) => text.length * size * 0.6;

function buildActivitySvg(s) {
  const W = 1600;
  const H = 420;
  const LEFT = 116;
  const RIGHT = 1524;
  const TOP = 132;
  const BOTTOM = 320;

  const all = [...s.days.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const counts = all.map(([, c]) => c);

  // 7-day trailing mean, computed across the full history so the left edge of
  // the window isn't distorted by a ramp-in from zero.
  const meanAll = counts.map((_, i) => {
    const from = Math.max(0, i - 6);
    let sum = 0;
    for (let j = from; j <= i; j++) sum += counts[j];
    return sum / (i - from + 1);
  });

  const start = Math.max(0, all.length - 365);
  const window = all.slice(start);
  const mean = meanAll.slice(start);
  const n = window.length;

  const total = window.reduce((acc, [, c]) => acc + c, 0);
  const activeDays = window.filter(([, c]) => c > 0).length;
  const peakValue = Math.max(0, ...window.map(([, c]) => c));
  const peakIndex = window.findIndex(([, c]) => c === peakValue);

  const ticks = axisTicks(peakValue);
  const yMax = ticks[ticks.length - 1];

  const xAt = (i) => (n < 2 ? LEFT : LEFT + (i / (n - 1)) * (RIGHT - LEFT));
  const yAt = (v) => BOTTOM - (v / yMax) * (BOTTOM - TOP);

  /* gridlines — solid hairlines one shade off the surface, never dashed */
  const grid = ticks
    .map((t) => {
      const y = yAt(t);
      return (
        `<line x1="${LEFT}" y1="${y.toFixed(1)}" x2="${RIGHT}" y2="${y.toFixed(1)}" stroke="${t === 0 ? '#262626' : '#1C1C1C'}" stroke-width="1"/>` +
        `<text x="${LEFT - 14}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-family="${MONO}" font-size="12" fill="#5A5A5A">${t}</text>`
      );
    })
    .join('\n');

  /* daily contributions — one path of thin vertical ticks rather than 365 rects.
     Butt caps: at this width a rounded end would just bleed past the baseline. */
  const step = n > 1 ? (RIGHT - LEFT) / (n - 1) : 0;
  const tickWidth = Math.max(1.6, Math.min(3, step * 0.62));
  const dailyPath = window
    .map(([, c], i) => (c > 0 ? `M${xAt(i).toFixed(1)} ${BOTTOM}V${yAt(c).toFixed(1)}` : ''))
    .filter(Boolean)
    .join('');

  /* 7-day mean — area + line */
  const points = mean.map((v, i) => [xAt(i), yAt(v)]);
  const linePath = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
  const areaPath = `M${LEFT} ${BOTTOM}${linePath.replace(/^M/, 'L')}L${RIGHT} ${BOTTOM}Z`;

  // Approximate path length for the draw-on animation (exact enough for SMIL).
  let lineLength = 0;
  for (let i = 1; i < points.length; i++) {
    lineLength += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  lineLength = Math.ceil(lineLength);

  /* month labels, centred under each month's span */
  const monthSpans = new Map();
  window.forEach(([date], i) => {
    const key = date.slice(0, 7);
    if (!monthSpans.has(key)) monthSpans.set(key, { first: i, last: i });
    else monthSpans.get(key).last = i;
  });
  const monthLabels = [...monthSpans.entries()]
    .map(([key, span]) => {
      const centre = (xAt(span.first) + xAt(span.last)) / 2;
      const width = xAt(span.last) - xAt(span.first);
      if (width < 34) return '';
      const [year, month] = key.split('-');
      const label = month === '01' ? `${MONTHS[0]} ${year.slice(2)}` : MONTHS[Number(month) - 1];
      return `<text x="${centre.toFixed(1)}" y="346" text-anchor="middle" font-family="${MONO}" font-size="11.5" letter-spacing="1.5" fill="#5A5A5A">${label}</text>`;
    })
    .filter(Boolean)
    .join('\n');

  /* one selective direct label: the peak. Never a value on every point. */
  let peakMark = '';
  if (peakValue > 0 && peakIndex >= 0) {
    const px = xAt(peakIndex);
    const py = yAt(peakValue);
    const label = `PEAK ${peakValue}`;
    const labelW = monoWidth(label, 12);
    const anchor = px - labelW / 2 < LEFT ? 'start' : px + labelW / 2 > RIGHT ? 'end' : 'middle';
    // When the peak touches the top gridline there is no room above it, and a
    // label pushed into the header would land on the subtitle — drop it below.
    const ly = py - 16 >= TOP + 2 ? py - 16 : py + 24;
    peakMark =
      `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4.5" fill="#FFFFFF" stroke="#131313" stroke-width="2"/>` +
      `<text x="${px.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}" font-family="${MONO}" font-size="12" letter-spacing="1.2" fill="#8A8A8A">${label}</text>`;
  }

  /* legend — two marks means identity is never carried by position alone */
  const legend = (() => {
    const size = 12.5;
    const meanLabel = '7-DAY AVERAGE';
    const dailyLabel = 'DAILY';
    const meanTextX = RIGHT;
    const meanSwatchX = meanTextX - monoWidth(meanLabel, size) - 30;
    const dailyTextX = meanSwatchX - 28;
    const dailySwatchX = dailyTextX - monoWidth(dailyLabel, size) - 16;
    return (
      `<rect x="${(dailySwatchX - 13).toFixed(1)}" y="61" width="3" height="14" fill="#3A3A3A"/>` +
      `<text x="${dailySwatchX.toFixed(1)}" y="73" font-family="${MONO}" font-size="${size}" letter-spacing="1.2" fill="#6E6E6E">${dailyLabel}</text>` +
      `<line x1="${meanSwatchX.toFixed(1)}" y1="68" x2="${(meanSwatchX + 22).toFixed(1)}" y2="68" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round"/>` +
      `<text x="${(meanSwatchX + 30).toFixed(1)}" y="73" font-family="${MONO}" font-size="${size}" letter-spacing="1.2" fill="#6E6E6E">${meanLabel}</text>`
    );
  })();

  const first = window[0]?.[0] ?? '';
  const last = window[n - 1]?.[0] ?? '';
  const alt =
    `Contribution activity for Rifat Ahmed from ${first} to ${last}: ${num(total)} contributions across ${num(activeDays)} active days, ` +
    `peaking at ${peakValue} in a single day. The chart shows daily contributions as vertical ticks with a seven-day average line.`;

  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(alt)}">
<!-- Generated by scripts/generate-cards.mjs — do not edit by hand.
     A README image cannot receive pointer events, so there is no hover layer:
     the figures a tooltip would carry live in the subtitle and the aria-label. -->
<rect x="40" y="20" width="1520" height="380" rx="14" fill="#131313" stroke="#262626" stroke-width="1.5"/>
<rect x="72" y="20" width="50" height="3" fill="#FFFFFF"/>
<text x="76" y="73" font-family="${SANS}" font-size="21" font-weight="700" letter-spacing="1.5" fill="#F2F2F2">CONTRIBUTION ACTIVITY</text>
${legend}
<line x1="76" y1="91" x2="1524" y2="91" stroke="#1E1E1E" stroke-width="1.4"/>
<text x="76" y="114" font-family="${MONO}" font-size="12.5" letter-spacing="2" fill="#5A5A5A">LAST 12 MONTHS · ${num(total)} CONTRIBUTIONS · ${num(activeDays)} ACTIVE DAYS</text>
${grid}
<path d="${dailyPath}" stroke="#3A3A3A" stroke-width="${tickWidth.toFixed(2)}" fill="none" opacity="0"><animate attributeName="opacity" from="0" to="1" dur="0.7s" begin="0.2s" fill="freeze"/></path>
<path d="${areaPath}" fill="#191919" opacity="0"><animate attributeName="opacity" from="0" to="1" dur="0.9s" begin="0.5s" fill="freeze"/></path>
<path d="${linePath}" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="${lineLength}" stroke-dashoffset="${lineLength}"><animate attributeName="stroke-dashoffset" from="${lineLength}" to="0" dur="1.6s" begin="0.4s" fill="freeze" calcMode="spline" keySplines="0.25 0.1 0.25 1"/></path>
${peakMark}
${monthLabels}
</svg>
`;
}

/* ──────────────────────────────── Main ───────────────────────────────── */

const stats = await collect();

mkdirSync(dirname(OUT_STATS), { recursive: true });
writeFileSync(OUT_STATS, buildSvg(stats), 'utf8');
writeFileSync(OUT_ACTIVITY, buildActivitySvg(stats), 'utf8');

const { current, longest } = streaks(stats.days);
console.log(`Wrote ${OUT_STATS}`);
console.log(`Wrote ${OUT_ACTIVITY}`);
console.table({
  'All-time contributions': stats.allTimeContributions,
  'Contributions (past year)': lastYearContributions(stats.days),
  'All-time commits': stats.allTimeCommits,
  'Pull requests': stats.pullRequests,
  Issues: stats.issues,
  'Public repos': stats.publicRepos,
  'Private repos (token-dependent)': stats.privateRepos,
  Forks: stats.forks,
  Stars: stats.stars,
  'Current streak': current,
  'Longest streak': longest,
});
