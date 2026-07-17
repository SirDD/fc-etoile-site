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
const WIDGET_URL = "https://widget.football.ch/Widgets.aspx/v-1316/a-rr/";
const PROXY_URL = "https://api.allorigins.win/raw?url=" + encodeURIComponent(SOURCE_URL);

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "Accept-Language": "fr-CH,fr;q=0.9,en;q=0.8,de;q=0.7",
  "Referer": "https://matchcenter.fvbj-afbj.ch/"
};

async function fetchFirstWorking(): Promise<{ html: string; usedSource: string }> {
  const attempts: { url: string; label: string }[] = [
    { url: WIDGET_URL, label: "widget.football.ch" },
    { url: SOURCE_URL, label: "matchcenter direct" },
    { url: PROXY_URL, label: "matchcenter via proxy" }
  ];
  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      const res = await fetch(attempt.url, { headers: BROWSER_HEADERS });
      if (!res.ok) {
        errors.push(`${attempt.label}: HTTP ${res.status}`);
        continue;
      }
      const html = await res.text();
      if (html && html.length > 500) {
        return { html, usedSource: attempt.label };
      }
      errors.push(`${attempt.label}: réponse trop courte`);
    } catch (e) {
      errors.push(`${attempt.label}: ${String(e)}`);
    }
  }
  throw new Error("Toutes les sources ont échoué — " + errors.join(" | "));
}

interface MatchInfo {
  date: string | null;
  time: string | null;
  home: boolean;
  ourTeam: string;
  opponent: string;
  category: string | null;
  detailUrl: string;
}

function findNearestCategoryBefore(html: string, pos: number): string | null {
  let best: { name: string; idx: number } | null = null;
  for (const name of CATEGORIES) {
    const idx = html.lastIndexOf(name, pos);
    if (idx !== -1 && (!best || idx > best.idx)) best = { name, idx };
  }
  return best ? best.name : null;
}

export default async (req: Request, context: Context) => {
  try {
    const { html, usedSource } = await fetchFirstWorking();

    // collect date marker positions (e.g. "Sa 15.08.2026")
    const dateRe = /(?:Lu|Ma|Me|Je|Ve|Sa|Di)\s\d{2}\.\d{2}\.\d{4}/g;
    const dateMarkers: { text: string; idx: number }[] = [];
    let dm: RegExpExecArray | null;
    while ((dm = dateRe.exec(html)) !== null) {
      dateMarkers.push({ text: dm[0], idx: dm.index });
    }

    // find match links — ASF marks these with title="Télégramme"
    const linkRe = /<a[^>]*title="Télégramme"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const matches: MatchInfo[] = [];
    let lm: RegExpExecArray | null;
    while ((lm = linkRe.exec(html)) !== null) {
      const href = lm[1].replace(/&amp;/g, "&");
      const rawInner = lm[2];
      const text = rawInner.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
      if (!/etoile/i.test(text)) continue; // keep only matches involving our club

      const timeMatch = text.match(/(\d{2}:\d{2})/);
      const time = timeMatch ? timeMatch[1] : null;
      const withoutTime = text.replace(/\d{2}:\d{2}/, "").trim();
      const parts = withoutTime.split(" - ").map((s) => s.trim()).filter(Boolean);
      if (parts.length < 2) continue;
      const [teamA, teamB] = parts;
      const isHome = /etoile/i.test(teamA);
      const ourTeam = isHome ? teamA : teamB;
      const opponent = isHome ? teamB : teamA;

      let nearestDate: string | null = null;
      let bestIdx = -1;
      for (const d of dateMarkers) {
        if (d.idx < lm.index && d.idx > bestIdx) {
          bestIdx = d.idx;
          nearestDate = d.text;
        }
      }

      const category = findNearestCategoryBefore(html, lm.index);

      matches.push({ date: nearestDate, time, home: isHome, ourTeam, opponent, category, detailUrl: href });
    }

    return new Response(
      JSON.stringify({ updatedAt: new Date().toISOString(), usedSource, matches }),
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
