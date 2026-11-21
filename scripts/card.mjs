#!/usr/bin/env node
// Builds card.svg: a football-style player card rated from real GitHub activity.
// Runs daily in GitHub Actions (see .github/workflows/card.yml). No dependencies.
//
// Local run:  GITHUB_TOKEN=$(gh auth token) node scripts/card.mjs

import { writeFile } from "node:fs/promises";

const CONFIG = {
  login: process.env.CARD_LOGIN || "rege-ontop89",
  name: "REGE",
  position: "FS",
  positionLabel: "FULL-STACK",
  out: process.env.CARD_OUT || "card.svg",
};

// Each stat maps a raw number onto 40..99. `target` is the value that earns a 99.
// The scale is logarithmic, so early progress moves the rating quickly and
// the top end takes real work.
const STATS = [
  { key: "PAC", meaning: "contributions in the last 30 days", target: 150, weight: 0.2 },
  { key: "SHO", meaning: "commits in the last year", target: 1500, weight: 0.2 },
  { key: "PAS", meaning: "pull requests opened and reviewed", target: 250, weight: 0.15 },
  { key: "DRI", meaning: "longest daily contribution streak", target: 60, weight: 0.2 },
  { key: "DEF", meaning: "issues opened and closed", target: 120, weight: 0.1 },
  { key: "PHY", meaning: "languages and repos worked across", target: null, weight: 0.15 },
];

const TIERS = [
  // min overall, name, background stops, text colour, accent colour
  { min: 85, name: "elite", bg: ["#3a1d6e", "#1b0f3a", "#0c0820"], text: "#f6d77c", accent: "#c9a8ff" },
  { min: 75, name: "gold", bg: ["#fff1b8", "#e2b448", "#9a6c12"], text: "#2f2104", accent: "#6b4a07" },
  { min: 65, name: "silver", bg: ["#f7f9fb", "#c3cad2", "#808a95"], text: "#1d2228", accent: "#4a525c" },
  { min: 0, name: "bronze", bg: ["#f1c08f", "#c0804a", "#7d4a22"], text: "#2e1a0a", accent: "#5a3416" },
];

const QUERY = `
query ($login: String!) {
  user(login: $login) {
    login
    avatarUrl(size: 320)
    createdAt
    repositories(ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC, first: 100) {
      nodes {
        languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
          edges { size node { name } }
        }
      }
    }
    closedIssues: issues(states: CLOSED) { totalCount }
    contributionsCollection {
      totalCommitContributions
      totalIssueContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
      totalRepositoriesWithContributedCommits
      contributionCalendar {
        weeks { contributionDays { contributionCount date } }
      }
    }
  }
}`;

async function github(query, variables) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "player-card" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`GitHub API error: ${JSON.stringify(json.errors ?? json)}`);
  return json.data;
}

const scale = (value, target) =>
  Math.round(40 + 59 * Math.min(1, Math.log1p(Math.max(0, value)) / Math.log1p(target)));

function streaks(days) {
  let longest = 0;
  let run = 0;
  for (const d of days) {
    run = d.contributionCount > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}

const LANG_SHORT = { JavaScript: "JS", TypeScript: "TS", Python: "PY", Swift: "SWIFT", Kotlin: "KT", Go: "GO", Rust: "RS", Java: "JAVA", HTML: "HTML", CSS: "CSS", Dart: "DART", Ruby: "RB", PHP: "PHP", "C#": "C#", "C++": "C++" };

function computeRatings(user) {
  const c = user.contributionsCollection;
  const days = c.contributionCalendar.weeks.flatMap((w) => w.contributionDays);

  const last30 = days.slice(-30).reduce((sum, d) => sum + d.contributionCount, 0);

  const langBytes = new Map();
  for (const repo of user.repositories.nodes) {
    for (const { size, node } of repo.languages.edges) {
      langBytes.set(node.name, (langBytes.get(node.name) ?? 0) + size);
    }
  }
  const topLang = [...langBytes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Code";

  const raw = {
    PAC: last30,
    SHO: c.totalCommitContributions,
    PAS: c.totalPullRequestContributions + c.totalPullRequestReviewContributions,
    DRI: streaks(days),
    DEF: c.totalIssueContributions + user.closedIssues.totalCount,
    PHY: { languages: langBytes.size, repos: c.totalRepositoriesWithContributedCommits },
  };

  const ratings = {};
  for (const s of STATS) {
    ratings[s.key] =
      s.key === "PHY"
        ? Math.round((scale(raw.PHY.languages, 12) + scale(raw.PHY.repos, 25)) / 2)
        : scale(raw[s.key], s.target);
  }
  const overall = Math.min(99, Math.round(STATS.reduce((sum, s) => sum + ratings[s.key] * s.weight, 0)));

  // Weekly totals for the last 12 weeks, shown as "form" bars.
  const form = c.contributionCalendar.weeks
    .slice(-12)
    .map((w) => w.contributionDays.reduce((sum, d) => sum + d.contributionCount, 0));

  return {
    raw,
    ratings,
    overall,
    form,
    topLang: LANG_SHORT[topLang] ?? topLang.slice(0, 4).toUpperCase(),
    since: new Date(user.createdAt).getUTCFullYear(),
  };
}

async function avatarDataUri(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Avatar download failed: ${res.status}`);
  const type = res.headers.get("content-type") ?? "image/png";
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:${type};base64,${buf.toString("base64")}`;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const SHIELD = "M30,52 C110,20 250,20 330,52 L330,392 C330,432 250,470 180,490 C110,470 30,432 30,392 Z";

function renderSvg({ ratings, overall, form, topLang, since }, avatar) {
  const tier = TIERS.find((t) => overall >= t.min);
  const [c1, c2, c3] = tier.bg;
  const font = "'Segoe UI','Helvetica Neue',Helvetica,Arial,sans-serif";

  const rows = [["PAC", "DRI"], ["SHO", "DEF"], ["PAS", "PHY"]];
  const statText = rows
    .map(([l, r], i) => {
      const y = 356 + i * 32;
      return `
    <text x="112" y="${y}" text-anchor="end" class="val">${ratings[l]}</text>
    <text x="120" y="${y}" class="lbl">${l}</text>
    <text x="236" y="${y}" text-anchor="end" class="val">${ratings[r]}</text>
    <text x="244" y="${y}" class="lbl">${r}</text>`;
    })
    .join("");

  const maxWeek = Math.max(1, ...form);
  const formBars = form
    .map((n, i) => {
      const h = Math.max(2, Math.round((n / maxWeek) * 20));
      return `<rect x="${110 + i * 12}" y="${456 - h}" width="8" height="${h}" rx="2" fill="${tier.accent}" opacity="${n ? 0.85 : 0.3}"/>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="500" viewBox="0 0 360 500" role="img" aria-label="${esc(CONFIG.name)}: ${overall} rated ${esc(CONFIG.positionLabel)} player card (${tier.name})">
  <title>${esc(CONFIG.name)} · ${overall} ${esc(CONFIG.position)}</title>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c1}"/><stop offset="0.55" stop-color="${c2}"/><stop offset="1" stop-color="${c3}"/>
    </linearGradient>
    <linearGradient id="shine" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.45"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <pattern id="stripes" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
      <rect width="7" height="14" fill="#fff" opacity="0.06"/>
    </pattern>
    <clipPath id="card"><path d="${SHIELD}"/></clipPath>
    <clipPath id="face"><circle cx="226" cy="146" r="80"/></clipPath>
  </defs>
  <style>
    text { font-family: ${font}; fill: ${tier.text}; }
    .val { font-size: 25px; font-weight: 800; }
    .lbl { font-size: 18px; font-weight: 500; letter-spacing: 1px; }
    .sweep { animation: sweep 7s ease-in-out infinite; }
    @keyframes sweep { 0% { transform: translateX(-160px); } 45%, 100% { transform: translateX(460px); } }
    @media (prefers-reduced-motion: reduce) { .sweep { animation: none; opacity: 0; } }
  </style>

  <g clip-path="url(#card)">
    <rect width="360" height="500" fill="url(#bg)"/>
    <rect width="360" height="500" fill="url(#stripes)"/>
    <circle cx="226" cy="146" r="118" fill="#fff" opacity="0.08"/>
    <g class="sweep"><rect x="0" y="-40" width="70" height="580" fill="url(#shine)" transform="skewX(-18)"/></g>
  </g>
  <path d="${SHIELD}" fill="none" stroke="${tier.accent}" stroke-width="3"/>
  <path d="${SHIELD}" fill="none" stroke="${tier.text}" stroke-opacity="0.25" stroke-width="1.5" transform="translate(180 262) scale(0.94) translate(-180 -262)"/>

  <text x="80" y="122" text-anchor="middle" style="font-size:64px;font-weight:800">${overall}</text>
  <text x="80" y="154" text-anchor="middle" style="font-size:24px;font-weight:700;letter-spacing:1px">${esc(CONFIG.position)}</text>
  <line x1="58" y1="170" x2="102" y2="170" stroke="${tier.text}" stroke-opacity="0.35"/>
  <text x="80" y="194" text-anchor="middle" style="font-size:15px;font-weight:700;letter-spacing:1px">${esc(topLang)}</text>
  <text x="80" y="214" text-anchor="middle" style="font-size:9px;font-weight:600;letter-spacing:2px;opacity:0.7">${tier.name.toUpperCase()}</text>

  <circle cx="226" cy="146" r="83" fill="none" stroke="${tier.accent}" stroke-width="3"/>
  <image href="${avatar}" x="146" y="66" width="160" height="160" clip-path="url(#face)" preserveAspectRatio="xMidYMid slice"/>

  <text x="180" y="276" text-anchor="middle" style="font-size:36px;font-weight:800;letter-spacing:4px">${esc(CONFIG.name)}</text>
  <text x="180" y="298" text-anchor="middle" style="font-size:11px;font-weight:600;letter-spacing:3px;opacity:0.75">${esc(CONFIG.positionLabel)} · SINCE ${since}</text>
  <line x1="70" y1="314" x2="290" y2="314" stroke="${tier.text}" stroke-opacity="0.35"/>
  <line x1="180" y1="330" x2="180" y2="418" stroke="${tier.text}" stroke-opacity="0.35"/>
  ${statText}

  ${formBars}
  <text x="180" y="472" text-anchor="middle" style="font-size:8px;font-weight:700;letter-spacing:2px;opacity:0.6">FORM · 12 WEEKS</text>
</svg>
`;
}

const { user } = await github(QUERY, { login: CONFIG.login });
if (!user) throw new Error(`User ${CONFIG.login} not found`);

const card = computeRatings(user);
await writeFile(CONFIG.out, renderSvg(card, await avatarDataUri(user.avatarUrl)));

console.log(`Overall ${card.overall} (${TIERS.find((t) => card.overall >= t.min).name})`);
for (const s of STATS) console.log(`  ${s.key} ${card.ratings[s.key]}  <- ${s.meaning}: ${JSON.stringify(card.raw[s.key])}`);
console.log(`Wrote ${CONFIG.out}`);
