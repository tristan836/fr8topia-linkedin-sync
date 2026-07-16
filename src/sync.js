/**
 * Fr8topia LinkedIn to Webflow daily sync.
 *
 * Pulls recent posts from the Fr8topia LLC LinkedIn Company Page and creates
 * them as DRAFT items in the Webflow "LinkedIn Posts" CMS collection.
 * A human reviews and publishes in Webflow. This script never publishes.
 *
 * It also writes posts.json to the repo root: a compact feed of the posts a
 * human has APPROVED (published) in Webflow. The public homepage embed reads
 * that file to render the "Recent Updates" section. No API token ever reaches
 * the browser; the token stays here in GitHub Actions.
 *
 * Runs in GitHub Actions on a daily schedule. All configuration comes from
 * environment variables (GitHub Actions secrets). Nothing is hardcoded and
 * no secret is ever logged.
 *
 * Required environment variables:
 *   LINKEDIN_CLIENT_ID
 *   LINKEDIN_CLIENT_SECRET
 *   LINKEDIN_REFRESH_TOKEN
 *   LINKEDIN_ORG_URN          e.g. urn:li:organization:99349913
 *   WEBFLOW_API_TOKEN
 *   WEBFLOW_COLLECTION_ID
 *   WEBFLOW_SITE_ID
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { env, exit } from "node:process";

// LinkedIn versioned API header, format YYYYMM.
// If LinkedIn sunsets this version the API returns an error naming the
// supported versions. Update this one constant and nothing else.
const LINKEDIN_VERSION = "202606";

const LI_TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const LI_API = "https://api.linkedin.com/rest";
const WF_API = "https://api.webflow.com/v2";
const POST_FETCH_COUNT = 15;

// How many approved posts to publish into posts.json for the homepage.
const FEED_MAX = 12;
const FEED_FILE = "posts.json";

// Expected Webflow field display names. Actual slugs are resolved from the
// collection schema at runtime so a slug rename does not silently break us.
const FIELDS = {
  postText: "post text",
  postImage: "post image",
  postUrl: "post url",
  publishedDate: "published date",
  linkedinUrn: "linkedin urn",
};

function requireEnv(names) {
  const missing = names.filter((n) => !env[n]);
  if (missing.length > 0) {
    console.error("Missing required environment variables: " + missing.join(", "));
    exit(1);
  }
}

async function readBody(res) {
  const text = await res.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

function fail(label, status, bodyText) {
  console.error(`${label} failed with HTTP ${status}. Response body:`);
  console.error(bodyText);
  exit(1);
}

/* ---------------- LinkedIn ---------------- */

async function getAccessToken() {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: env.LINKEDIN_REFRESH_TOKEN,
    client_id: env.LINKEDIN_CLIENT_ID,
    client_secret: env.LINKEDIN_CLIENT_SECRET,
  });
  const res = await fetch(LI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const { text, json } = await readBody(res);
  if (!res.ok || !json || !json.access_token) {
    fail("LinkedIn token refresh", res.status, text);
  }
  console.log("LinkedIn access token refreshed.");
  return json.access_token;
}

function liHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "LinkedIn-Version": LINKEDIN_VERSION,
    "X-Restli-Protocol-Version": "2.0.0",
  };
}

async function fetchOrgPosts(accessToken) {
  const author = encodeURIComponent(env.LINKEDIN_ORG_URN);
  const url = `${LI_API}/posts?author=${author}&q=author&count=${POST_FETCH_COUNT}`;
  const res = await fetch(url, { headers: liHeaders(accessToken) });
  const { text, json } = await readBody(res);
  if (!res.ok || !json) {
    fail("LinkedIn posts fetch", res.status, text);
  }
  const elements = Array.isArray(json.elements) ? json.elements : [];
  const posts = elements.filter(
    (p) => p.lifecycleState === "PUBLISHED" && (p.visibility === "PUBLIC" || p.visibility === undefined)
  );
  posts.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
  console.log(`Fetched ${elements.length} posts from LinkedIn, ${posts.length} published and public.`);
  return posts;
}

function extractImageUrn(post) {
  const c = post.content;
  if (!c) return null;
  if (c.media && typeof c.media.id === "string" && c.media.id.startsWith("urn:li:image:")) {
    return c.media.id;
  }
  const multi = c.multiImage;
  if (multi && Array.isArray(multi.images) && multi.images.length > 0) {
    const first = multi.images[0];
    if (first && typeof first.id === "string" && first.id.startsWith("urn:li:image:")) {
      return first.id;
    }
  }
  return null;
}

async function resolveImageDownloadUrl(accessToken, imageUrn) {
  const url = `${LI_API}/images/${encodeURIComponent(imageUrn)}`;
  const res = await fetch(url, { headers: liHeaders(accessToken) });
  const { text, json } = await readBody(res);
  if (!res.ok || !json) {
    console.warn(`Could not resolve image ${imageUrn} (HTTP ${res.status}). Continuing without image.`);
    console.warn(text.slice(0, 500));
    return null;
  }
  return json.downloadUrl || null;
}

function cleanCommentary(raw) {
  if (!raw) return "";
  let out = raw;
  out = out.replace(/\{hashtag\|\\?#\|([^}]*)\}/g, "#$1");
  out = out.replace(/@\[([^\]]+)\]\(urn:[^)]*\)/g, "$1");
  out = out.replace(/\\([(){}<>|~*@\[\]_#])/g, "$1");
  return out.trim();
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toRichTextHtml(text) {
  if (!text) return "";
  const paragraphs = escapeHtml(text).split(/\n{2,}/);
  return paragraphs.map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");
}

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function postPermalink(postUrn) {
  return `https://www.linkedin.com/feed/update/${postUrn}/`;
}

function makeName(text, postUrn) {
  const flat = (text || "").replace(/\s+/g, " ").trim();
  if (flat.length === 0) {
    return "LinkedIn update " + postUrn.split(":").pop();
  }
  return flat.length <= 60 ? flat : flat.slice(0, 57).trimEnd() + "...";
}

function makeSlug(postUrn) {
  const id = postUrn.split(":").pop().replace(/[^a-zA-Z0-9]/g, "");
  return `linkedin-post-${id}`;
}

/* ---------------- Webflow ---------------- */

function wfHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${env.WEBFLOW_API_TOKEN}`,
    accept: "application/json",
    ...extra,
  };
}

async function getFieldSlugMap() {
  const res = await fetch(`${WF_API}/collections/${env.WEBFLOW_COLLECTION_ID}`, {
    headers: wfHeaders(),
  });
  const { text, json } = await readBody(res);
  if (!res.ok || !json) {
    fail("Webflow collection schema fetch", res.status, text);
  }
  const map = {};
  for (const f of json.fields || []) {
    map[(f.displayName || "").toLowerCase().trim()] = f.slug;
  }
  const resolved = {};
  const missing = [];
  for (const [key, displayName] of Object.entries(FIELDS)) {
    if (map[displayName]) {
      resolved[key] = map[displayName];
    } else {
      missing.push(displayName);
    }
  }
  if (missing.length > 0) {
    console.error("Webflow collection is missing expected fields (by display name): " + missing.join(", "));
    console.error("Fields found: " + Object.keys(map).join(", "));
    exit(1);
  }
  console.log("Webflow field slugs resolved.");
  return resolved;
}

async function getExistingUrns(urnSlug) {
  const existing = new Set();
  let offset = 0;
  const limit = 100;
  for (;;) {
    const res = await fetch(
      `${WF_API}/collections/${env.WEBFLOW_COLLECTION_ID}/items?limit=${limit}&offset=${offset}`,
      { headers: wfHeaders() }
    );
    const { text, json } = await readBody(res);
    if (!res.ok || !json) {
      fail("Webflow items list", res.status, text);
    }
    const items = json.items || [];
    for (const item of items) {
      const urn = item.fieldData ? item.fieldData[urnSlug] : null;
      if (urn) existing.add(urn);
    }
    if (items.length < limit) break;
    offset += limit;
  }
  console.log(`Found ${existing.size} existing LinkedIn URNs in Webflow.`);
  return existing;
}

/**
 * Read the APPROVED (published) items from the collection. These are the posts
 * a human clicked Publish on. Used to build posts.json for the homepage.
 *
 * We fetch the standard items list and keep only items that are published:
 * not draft, not archived, and carrying a lastPublished timestamp. This is
 * more portable across API versions than the /items/live path.
 */
async function getLivePosts(slugs) {
  const out = [];
  let offset = 0;
  const limit = 100;
  for (;;) {
    const res = await fetch(
      `${WF_API}/collections/${env.WEBFLOW_COLLECTION_ID}/items?limit=${limit}&offset=${offset}`,
      { headers: wfHeaders() }
    );
    const { text, json } = await readBody(res);
    if (!res.ok || !json) {
      fail("Webflow items list (for feed)", res.status, text);
    }
    const items = json.items || [];
    for (const item of items) {
      const isDraft = item.isDraft === true;
      const isArchived = item.isArchived === true;
      const published = Boolean(item.lastPublished);
      if (isDraft || isArchived || !published) continue;

      const fd = item.fieldData || {};
      const image = fd[slugs.postImage];
      out.push({
        urn: fd[slugs.linkedinUrn] || "",
        name: fd.name || "",
        text: stripHtml(fd[slugs.postText] || ""),
        url: (fd[slugs.postUrl] && fd[slugs.postUrl].url) || fd[slugs.postUrl] || "",
        date: fd[slugs.publishedDate] || "",
        image: image && image.url ? image.url : null,
      });
    }
    if (items.length < limit) break;
    offset += limit;
  }
  out.sort((a, b) => new Date(b.date) - new Date(a.date));
  return out.slice(0, FEED_MAX);
}

function writeFeedJson(posts) {
  const payload = {
    updated: new Date().toISOString(),
    count: posts.length,
    posts,
  };
  writeFileSync(FEED_FILE, JSON.stringify(payload, null, 2));
  console.log(`Wrote ${FEED_FILE} with ${posts.length} approved posts.`);
}

function extFromContentType(ct) {
  if (!ct) return "jpg";
  if (ct.includes("png")) return "png";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("webp")) return "webp";
  return "jpg";
}

async function rehostImage(downloadUrl, postUrn) {
  try {
    const imgRes = await fetch(downloadUrl);
    if (!imgRes.ok) {
      console.warn(`Image download failed (HTTP ${imgRes.status}) for ${postUrn}. Skipping image.`);
      return null;
    }
    const contentType = imgRes.headers.get("content-type") || "image/jpeg";
    const buffer = Buffer.from(await imgRes.arrayBuffer());
    const fileName = `${makeSlug(postUrn)}.${extFromContentType(contentType)}`;
    const fileHash = createHash("md5").update(buffer).digest("hex");

    const regRes = await fetch(`${WF_API}/sites/${env.WEBFLOW_SITE_ID}/assets`, {
      method: "POST",
      headers: wfHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ fileName, fileHash }),
    });
    const { text: regText, json: reg } = await readBody(regRes);
    if (!regRes.ok || !reg) {
      console.warn(`Webflow asset registration failed (HTTP ${regRes.status}) for ${postUrn}. Skipping image.`);
      console.warn(regText.slice(0, 500));
      return null;
    }

    const hostedUrl = reg.hostedUrl || (reg.assetUrl ? reg.assetUrl : null);
    const uploadUrl = reg.uploadUrl;
    const details = reg.uploadDetails || {};

    if (uploadUrl) {
      const form = new FormData();
      for (const [k, v] of Object.entries(details)) {
        form.append(k, String(v));
      }
      form.append("file", new Blob([buffer], { type: contentType }), fileName);
      const upRes = await fetch(uploadUrl, { method: "POST", body: form });
      if (!upRes.ok && upRes.status !== 201 && upRes.status !== 204) {
        const upText = await upRes.text();
        console.warn(`Asset byte upload failed (HTTP ${upRes.status}) for ${postUrn}. Skipping image.`);
        console.warn(upText.slice(0, 500));
        return null;
      }
    }

    if (!hostedUrl) {
      console.warn(`No hosted URL returned for asset on ${postUrn}. Skipping image.`);
      return null;
    }
    return hostedUrl;
  } catch (err) {
    console.warn(`Image re-host error for ${postUrn}: ${err.message}. Skipping image.`);
    return null;
  }
}

async function createDraftItem(slugs, fields) {
  const res = await fetch(`${WF_API}/collections/${env.WEBFLOW_COLLECTION_ID}/items`, {
    method: "POST",
    headers: wfHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      isArchived: false,
      isDraft: true,
      fieldData: fields,
    }),
  });
  const { text, json } = await readBody(res);
  if (!res.ok || !json) {
    console.error(`Webflow item create failed with HTTP ${res.status}. Response body:`);
    console.error(text);
    return false;
  }
  return true;
}

/* ---------------- Main ---------------- */

async function main() {
  requireEnv([
    "LINKEDIN_CLIENT_ID",
    "LINKEDIN_CLIENT_SECRET",
    "LINKEDIN_REFRESH_TOKEN",
    "LINKEDIN_ORG_URN",
    "WEBFLOW_API_TOKEN",
    "WEBFLOW_COLLECTION_ID",
    "WEBFLOW_SITE_ID",
  ]);

  const accessToken = await getAccessToken();
  const slugs = await getFieldSlugMap();
  const existingUrns = await getExistingUrns(slugs.linkedinUrn);
  const posts = await fetchOrgPosts(accessToken);

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const post of posts) {
    const urn = post.id;
    if (!urn) continue;

    if (existingUrns.has(urn)) {
      skipped += 1;
      continue;
    }

    const text = cleanCommentary(post.commentary || "");
    const name = makeName(text, urn);

    let imageUrl = null;
    const imageUrn = extractImageUrn(post);
    if (imageUrn) {
      const downloadUrl = await resolveImageDownloadUrl(accessToken, imageUrn);
      if (downloadUrl) {
        imageUrl = await rehostImage(downloadUrl, urn);
      }
    }

    const fieldData = {
      name,
      slug: makeSlug(urn),
      [slugs.postText]: toRichTextHtml(text),
      [slugs.postUrl]: postPermalink(urn),
      [slugs.publishedDate]: new Date(post.publishedAt || Date.now()).toISOString(),
      [slugs.linkedinUrn]: urn,
    };
    if (imageUrl) {
      fieldData[slugs.postImage] = imageUrl;
    }

    const ok = await createDraftItem(slugs, fieldData);
    if (ok) {
      created += 1;
      existingUrns.add(urn);
      console.log(`Created draft: ${name}`);
    } else {
      failed += 1;
    }
  }

  console.log("----------------------------------------");
  console.log(`Draft sync complete. Created: ${created}, skipped (already synced): ${skipped}, failed: ${failed}.`);

  // Build the public feed from APPROVED posts for the homepage.
  const livePosts = await getLivePosts(slugs);
  writeFeedJson(livePosts);
  console.log("New items are DRAFTS in Webflow. Approved (published) items now feed the homepage.");

  if (failed > 0) {
    exit(1);
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err.message);
  exit(1);
});
