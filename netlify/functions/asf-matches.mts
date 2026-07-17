import type { Context, Config } from "@netlify/functions";

// Known categories for FC Etoile Biel — 'match' is the text that appears in the
// page's section heading, 'label' is the friendly name we display on the site.
const CATEGORY_PATTERNS: { match: string; label: string }[] = [
  { match: "4e ligue", label: "4e ligue" },
  { match: "5e ligue", label: "5e ligue b" },
  { match: "Seniors 30+", label: "Seniors 30+" },
  { match: "Juniors D-9", label: "Juniors D-9" },
  { match: "Juniors E", label: "Juniors E a" },
  { match: "Juniors F", label: "Juniors F" },
  { match: "Juniors G", label: "Juniors G" }
];

const SOURCE_URL = "https://matchcenter.fvbj-afbj.ch/default.aspx?v=1316&oid=6&lng=2&a=rr";
const READER_URL = "https://r.jina.ai/" + SOURCE_URL;

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "fr-CH,fr;q=0.9,en;q=0.8,de;q=0.7",
  "Referer": "https://matchcenter.fvbj-afbj.ch/"
};

interface MatchInfo {
  date: string | null;
  time: string | null;
  home: boolean;
  ourTeam: string;
  opponent: string;
  category: string | null;
  detailUrl: string | null;
}

async function fetchFirstWorking(): Promise<{ content: string; usedSource: string; isMarkdown: boolean }> {
  const attempts: { url: string; label: string; isMarkdown: boolean }[] = [
    { url: READER_URL, label: "r.jina.ai reader", isMarkdown: true },
    { url: SOURCE_URL, label: "matchcenter direct", isMarkdown: false }
  ];
  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      const res = await fetch(attempt.url, { headers: BROWSER_HEADERS });
      if (!res.ok) {
        errors.push(`${attempt.label}: HTTP ${res.status}`);
        continue;
      }
      const content = await res.text();
      if (content && content.length > 500) {
        return { content, usedSource: attempt.label, isMarkdown: attempt.isMarkdown };
      }
      errors.push(`${attempt.label}: réponse trop courte`);
    } catch (e) {
      errors.push(`${attempt.label}: ${String(e)}`);
    }
  }
  throw new Error("Toutes les sources ont échoué — " + errors.join(" | "));
}

function findNearestCategoryBefore(text: string, pos: number): string | null {
  let best: { label: string; idx: number } | null = null;
  for (const { match, label } of CATEGORY_PATTERNS) {
    const idx = text.lastIndexOf(match, pos);
    if (idx !== -1 && (!best || idx > best.idx)) best = { label, idx };
  }
  return best ? best.label : null;
}

const DATE_RE_SRC = "(?:Lu|Ma|Me|Je|Ve|Sa|Di)\\s\\d{2}\\.\\d{2}\\.\\d{4}";

function extractMatches(text: string, isMarkdown: boolean): MatchInfo[] {
  const dateRe = new RegExp(DATE_RE_SRC, "g");
  const dateMarkers: { text: string; idx: number }[] = [];
  let dm: RegExpExecArray | null;
  while ((dm = dateRe.exec(text)) !== null) {
    dateMarkers.push({ text: dm[0], idx: dm.index });
  }

  const matches: MatchInfo[] = [];

  if (isMarkdown) {
    // markdown links: [11:00 **FC Etoile Biel** - FC Nidau](url "Télégramme")
    const linkRe = /\[([^\]]+)\]\(([^\s)]+)\s+"Télégramme"\)/g;
    let lm: RegExpExecArray | null;
    while ((lm = linkRe.exec(text)) !== null) {
      const rawText = lm[1].replace(/\*\*/g, "").trim();
      const href = lm[2];
      pushIfOurs(matches, text, lm.index, dateMarkers, rawText, href);
    }
  } else {
    // raw HTML: <a ... title="Télégramme" href="...">...</a>
    const linkRe = /<a[^>]*title="Télégramme"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let lm: RegExpExecArray | null;
    while ((lm = linkRe.exec(text)) !== null) {
      const href = lm[1].replace(/&amp;/g, "&");
      const rawText = lm[2].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
      pushIfOurs(matches, text, lm.index, dateMarkers, rawText, href);
    }
  }

  function pushIfOurs(
    out: MatchInfo[],
    fullText: string,
    pos: number,
    dates: { text: string; idx: number }[],
    rawText: string,
    href: string | null
  ) {
    if (!/etoile/i.test(rawText)) return;
    const timeMatch = rawText.match(/(\d{2}:\d{2})/);
    const time = timeMatch ? timeMatch[1] : null;
    const withoutTime = rawText.replace(/\d{2}:\d{2}/, "").trim();
    const parts = withoutTime.split(" - ").map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) return;
    const [teamA, teamB] = parts;
    const isHome = /etoile/i.test(teamA);
    const ourTeam = isHome ? teamA : teamB;
    const opponent = isHome ? teamB : teamA;

    let nearestDate: string | null = null;
    let bestIdx = -1;
    for (const d of dates) {
      if (d.idx < pos && d.idx > bestIdx) {
        bestIdx = d.idx;
        nearestDate = d.text;
      }
    }
    const category = findNearestCategoryBefore(fullText, pos);
    out.push({ date: nearestDate, time, home: isHome, ourTeam, opponent, category, detailUrl: href });
  }

  return matches;
}

interface StandingRow {
  team: string;
  isUs: boolean;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  diff: number;
  points: number;
}

function extractStandings(text: string, isMarkdown: boolean): Record<string, StandingRow[]> {
  const standings: Record<string, StandingRow[]> = {};
  if (!isMarkdown) return standings; // only reliably parseable from the markdown reader output

  for (const { match, label } of CATEGORY_PATTERNS) {
    // find every occurrence of this category heading, keep the one immediately
    // followed by a markdown table (the standings block, not the fixtures block)
    let searchFrom = 0;
    let tableStart = -1;
    while (true) {
      const idx = text.indexOf(match, searchFrom);
      if (idx === -1) break;
      const nextChunk = text.slice(idx, idx + 400);
      if (/\n\s*\|\s*\d\.\s*\|/.test(nextChunk) || /\n\s*\|\s*\|\s*\[/.test(nextChunk)) {
        tableStart = idx;
      }
      searchFrom = idx + match.length;
    }
    if (tableStart === -1) continue;

    const blockEnd = text.indexOf("Classement avec colonne", tableStart);
    const block = blockEnd !== -1 ? text.slice(tableStart, blockEnd) : text.slice(tableStart, tableStart + 4000);

    const rowRe = /\|\s*(?:\d+\.)?\s*\|\s*(?:\[([^\]]+)\]\([^)]*\)|\*\*([^*]+)\*\*|([^|*]+))\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*\(\d+\)\s*\|\s*(\d+)\s*\|\s*:\s*\|\s*(\d+)\s*\|\s*(-?\d+)\s*\|\s*\*\*(\d+)\*\*/g;
    let rm: RegExpExecArray | null;
    const rows: StandingRow[] = [];
    while ((rm = rowRe.exec(block)) !== null) {
      const teamRaw = (rm[1] || rm[2] || rm[3] || "").trim();
      if (!teamRaw) continue;
      const isUs = /etoile/i.test(teamRaw) || !!rm[2];
      rows.push({
        team: teamRaw,
        isUs,
        played: parseInt(rm[4], 10),
        won: parseInt(rm[5], 10),
        drawn: parseInt(rm[6], 10),
        lost: parseInt(rm[7], 10),
        goalsFor: parseInt(rm[8], 10),
        goalsAgainst: parseInt(rm[9], 10),
        diff: parseInt(rm[10], 10),
        points: parseInt(rm[11], 10)
      });
    }
    if (rows.length > 0) standings[label] = rows;
  }

  return standings;
}

export default async (req: Request, context: Context) => {
  try {
    const { content, usedSource, isMarkdown } = await fetchFirstWorking();

    const url = new URL(req.url);
    if (url.searchParams.get("raw") === "1") {
      // temporary debug mode — returns a slice of the raw content around the first standings table
      const anchor = content.indexOf("4e ligue");
      const snippet = anchor !== -1 ? content.slice(anchor, anchor + 2500) : content.slice(0, 2500);
      return new Response(snippet, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    const matches = extractMatches(content, isMarkdown);

    let standings: Record<string, StandingRow[]> = {};
    try {
      standings = extractStandings(content, isMarkdown);
    } catch (e) {
      // standings are a bonus — never let a parsing issue break the matches response
      standings = {};
    }

    return new Response(
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        usedSource,
        matchCount: matches.length,
        matches,
        standings
      }),
      { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=120" } }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: true, message: String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};

export const config: Config = {
  path: "/api/asf-matches"
};
