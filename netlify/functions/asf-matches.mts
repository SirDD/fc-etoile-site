import type { Context, Config } from "@netlify/functions";

// Known categories for FC Etoile Biel (from the ASF match center)
const CATEGORIES = [
  "4e ligue",
  "5e ligue b",
  "Seniors 30+",
  "Juniors D-9",
  "Juniors E a",
  "Juniors F",
  "Juniors G"
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

function findNearestBefore(text: string, pos: number, needles: string[]): string | null {
  let best: { name: string; idx: number } | null = null;
  for (const name of needles) {
    const idx = text.lastIndexOf(name, pos);
    if (idx !== -1 && (!best || idx > best.idx)) best = { name, idx };
  }
  return best ? best.name : null;
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
    const category = findNearestBefore(fullText, pos, CATEGORIES);
    out.push({ date: nearestDate, time, home: isHome, ourTeam, opponent, category, detailUrl: href });
  }

  return matches;
}

export default async (req: Request, context: Context) => {
  try {
    const { content, usedSource, isMarkdown } = await fetchFirstWorking();
    const matches = extractMatches(content, isMarkdown);

    return new Response(
      JSON.stringify({ updatedAt: new Date().toISOString(), usedSource, matchCount: matches.length, matches }),
      { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=1800" } }
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
