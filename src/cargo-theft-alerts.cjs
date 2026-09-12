// Fr8topia Cargo Theft Alerts sync
// Pulls trade press and law enforcement RSS feeds, filters for cargo theft and
// freight fraud coverage, dedupes against the Webflow collection, and creates
// DRAFT items for human review. Nothing publishes without approval.
//
// Zero external dependencies beyond rss-parser. Node 20+.

const Parser = require("rss-parser");

const WEBFLOW_API_TOKEN = process.env.WEBFLOW_API_TOKEN;
const ALERTS_COLLECTION_ID = process.env.ALERTS_COLLECTION_ID || "6aa2af69859d0a554be01493";
const MAX_AGE_DAYS = Number(process.env.MAX_AGE_DAYS || 21);
const MAX_NEW_PER_RUN = Number(process.env.MAX_NEW_PER_RUN || 12);

// Option ids from the Alert type field in Webflow.
const TYPE = {
  incident: "1460f93f29dede5516a9c238856ec77e",
  fraud: "afa3cf0d9b16b9f0015ff115457d63b2",
  report: "f333f165baaf8e2d1807015b070aa5f6",
  law: "85766e16b26e8b9811ae035f5963185d",
};

// Topic-specific archive feeds. These are already about cargo theft, so the
// keyword filter below is a safety net rather than the primary filter.
// CCJ and Overdrive were removed: both return 403 to automated requests.
const FEEDS = [
  { name: "FreightWaves", url: "https://www.freightwaves.com/news/tag/cargo-theft/feed" },
  { name: "FreightWaves", url: "https://www.freightwaves.com/news/tag/freight-fraud/feed" },
  { name: "Land Line", url: "https://landline.media/tag/cargo-theft/feed/" },
  { name: "Transport Topics", url: "https://www.ttnews.com/rss.xml" },
];

const KEYWORDS = [
  "cargo theft", "freight theft", "fictitious pickup", "fictitious pick-up",
  "freight fraud", "double broker", "double-broker", "double brokering",
  "stolen load", "stolen trailer", "stolen cargo", "strategic theft",
  "cargo thieves", "load board fraud", "identity theft carrier", "carrier identity",
  "cargonet", "ic3", "hijack",
];

const REGIONS = [
  "Southern California", "Inland Empire", "Los Angeles", "Ontario, California",
  "California", "Texas", "Dallas", "Illinois", "Chicago", "Georgia", "Atlanta",
  "Florida", "New Jersey", "Tennessee", "Memphis", "Arizona", "Phoenix",
];

function log(...a) { console.log(new Date().toISOString(), ...a); }

function classify(title, desc) {
  const t = `${title} ${desc}`.toLowerCase();
  if (/(fbi|ic3|police|sheriff|arrest|indict|charged|law enforcement|department of justice)/.test(t)) return TYPE.law;
  if (/(quarterly|q[1-4] |report|annual|index|trends|data show)/.test(t)) return TYPE.report;
  if (/(fraud|scam|phish|fictitious|impersonat|spoof|double.?broker)/.test(t)) return TYPE.fraud;
  return TYPE.incident;
}

function region(title, desc) {
  const t = `${title} ${desc}`;
  for (const r of REGIONS) if (t.includes(r)) return r;
  return "";
}

function matches(title, desc, isTopicFeed) {
  if (isTopicFeed) return true;           // archive feed is already on topic
  const t = `${title} ${desc}`.toLowerCase();
  return KEYWORDS.some(k => t.includes(k));
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 6);
}

function normalizeUrl(u) {
  try {
    const x = new URL(u);
    x.search = ""; x.hash = "";
    return x.toString().replace(/\/$/, "");
  } catch { return (u || "").trim(); }
}

async function wf(path, opts = {}) {
  const res = await fetch(`https://api.webflow.com/v2${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${WEBFLOW_API_TOKEN}`,
      accept: "application/json",
      "content-type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Webflow ${opts.method || "GET"} ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function existingUrls() {
  const seen = new Set();
  let offset = 0;
  while (true) {
    const data = await wf(`/collections/${ALERTS_COLLECTION_ID}/items?limit=100&offset=${offset}`);
    for (const it of data.items || []) {
      const u = it.fieldData?.["source-url"];
      if (u) seen.add(normalizeUrl(u));
    }
    const total = data.pagination?.total ?? 0;
    offset += 100;
    if (offset >= total) break;
  }
  return seen;
}

async function createDraft(entry, feedName) {
  const title = (entry.title || "").trim().slice(0, 200);
  const desc = (entry.contentSnippet || entry.content || "").replace(/\s+/g, " ").trim();
  const link = normalizeUrl(entry.link);
  const published = entry.isoDate || (entry.pubDate ? new Date(entry.pubDate).toISOString() : new Date().toISOString());

  const fieldData = {
    name: title,
    slug: `${slugify(title)}-${hash(link)}`,
    source: feedName,
    "source-url": link,
    published,
    "alert-type": classify(title, desc),
    region: region(title, desc),
    // summary intentionally left empty: the approver writes one line in our own words.
  };

  return wf(`/collections/${ALERTS_COLLECTION_ID}/items`, {
    method: "POST",
    body: JSON.stringify({ isDraft: true, fieldData }),
  });
}

async function main() {
  if (!WEBFLOW_API_TOKEN) throw new Error("WEBFLOW_API_TOKEN is not set");
  const parser = new Parser({ timeout: 15000, headers: { "User-Agent": "Fr8topiaAlertsBot/1.0" } });
  const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
  const seen = await existingUrls();
  log(`Existing alerts in collection: ${seen.size}`);

  const candidates = [];
  for (const feed of FEEDS) {
    try {
      const data = await parser.parseURL(feed.url);
      let hits = 0;
      for (const e of data.items || []) {
        const when = e.isoDate ? Date.parse(e.isoDate) : (e.pubDate ? Date.parse(e.pubDate) : NaN);
        if (Number.isFinite(when) && when < cutoff) continue;
        const desc = e.contentSnippet || e.content || "";
        const isTopicFeed = feed.url.includes("/tag/");
        if (!matches(e.title || "", desc, isTopicFeed)) continue;
        const link = normalizeUrl(e.link);
        if (!link || seen.has(link)) continue;
        seen.add(link);
        candidates.push({ entry: e, feedName: feed.name, when: when || 0 });
        hits++;
      }
      log(`${feed.name}: ${hits} new match(es)`);
    } catch (err) {
      log(`${feed.name}: skipped (${err.message})`);
    }
  }

  candidates.sort((a, b) => b.when - a.when);
  const batch = candidates.slice(0, MAX_NEW_PER_RUN);

  let created = 0, failed = 0;
  for (const c of batch) {
    try {
      await createDraft(c.entry, c.feedName);
      created++;
      log(`Draft created: ${c.entry.title}`);
    } catch (err) {
      failed++;
      log(`FAILED: ${c.entry.title} -> ${err.message}`);
    }
  }
  log(`Done. Created: ${created}, skipped as duplicate/old: ${candidates.length - batch.length}, failed: ${failed}`);
  if (failed) process.exitCode = 1;
}

main().catch(err => { console.error(err); process.exit(1); });
