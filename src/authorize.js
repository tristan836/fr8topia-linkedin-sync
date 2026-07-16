/**
 * One-time LinkedIn OAuth authorization helper for Fr8topia.
 *
 * Run with:  npm run authorize   (or: node src/authorize.js)
 *
 * What it does:
 *   1. Prints a LinkedIn authorization URL for you to open in a browser.
 *   2. You sign in as a Fr8topia LLC Page admin and click Allow.
 *   3. LinkedIn redirects to https://www.fr8topia.com/linkedin-callback/?code=...
 *      That page may show a 404. That is fine. The code is in the address bar.
 *   4. You paste the code back here. This script exchanges it for tokens
 *      and prints the refresh token to store as the GitHub secret
 *      LINKEDIN_REFRESH_TOKEN.
 *
 * IMPORTANT: The authorization code is SINGLE USE and SHORT LIVED.
 *   - It expires within a few minutes.
 *   - A failed exchange attempt invalidates it permanently.
 *   If the exchange fails for any reason, re-run this script to get a
 *   fresh URL and a fresh code. Do not retry an old code.
 *
 * This script never writes tokens to disk and never logs your client secret.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout, env, exit } from "node:process";
import { randomBytes } from "node:crypto";

const REDIRECT_URI = "https://www.fr8topia.com/linkedin-callback/"; // must match the app config byte for byte, trailing slash included
const SCOPES = "r_organization_social"; // read the organization's posts; only request scopes the app actually has
const AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";

async function ask(rl, question) {
  const answer = await rl.question(question);
  return answer.trim();
}

async function main() {
  const rl = createInterface({ input: stdin, output: stdout });

  // Client credentials: prefer environment variables, fall back to interactive prompt.
  let clientId = env.LINKEDIN_CLIENT_ID || "";
  let clientSecret = env.LINKEDIN_CLIENT_SECRET || "";

  if (!clientId) {
    clientId = await ask(rl, "Enter your LinkedIn Client ID: ");
  }
  if (!clientSecret) {
    console.log("\nThe Client Secret is found in the LinkedIn app's Auth tab.");
    console.log("It will not be stored or logged by this script.");
    clientSecret = await ask(rl, "Enter your LinkedIn Client Secret: ");
  }
  if (!clientId || !clientSecret) {
    console.error("Client ID and Client Secret are both required. Exiting.");
    exit(1);
  }

  const state = randomBytes(16).toString("hex");

  const authorizeUrl =
    `${AUTH_URL}?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&state=${state}` +
    `&scope=${encodeURIComponent(SCOPES)}`;

  console.log("\n================ STEP 1: AUTHORIZE ================\n");
  console.log("Open this URL in your browser. Sign in as an admin of the");
  console.log("Fr8topia LLC LinkedIn Page, then click Allow:\n");
  console.log(authorizeUrl);
  console.log("\nAfter you approve, the browser lands on:");
  console.log("  https://www.fr8topia.com/linkedin-callback/?code=XXXX&state=YYYY");
  console.log("The page itself may show a 404. That is expected and fine.");
  console.log("Copy ONLY the value of the code parameter from the address bar.");
  console.log("(Everything between code= and the next & sign.)\n");
  console.log("REMINDER: the code is single use and expires in minutes.");
  console.log("A failed exchange kills it. If anything goes wrong, re-run this script.\n");

  const code = await ask(rl, "Paste the code here: ");
  const returnedState = await ask(rl, "Paste the state value from the URL (or press Enter to skip check): ");
  rl.close();

  if (!code) {
    console.error("No code entered. Exiting.");
    exit(1);
  }
  if (returnedState && returnedState !== state) {
    console.error("\nState mismatch. The state in the URL does not match the one this");
    console.error("script generated. For safety, re-run and use a fresh authorization URL.");
    exit(1);
  }

  console.log("\n================ STEP 2: EXCHANGE ================\n");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    client_secret: clientSecret,
  });

  let res;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (err) {
    console.error("Network error calling the token endpoint:", err.message);
    console.error("The code is now likely invalidated. Re-run this script for a fresh code.");
    exit(1);
  }

  const text = await res.text();

  if (!res.ok) {
    // Print the FULL response body so the failure is debuggable.
    console.error(`Token exchange failed with HTTP ${res.status}. Full response body:\n`);
    console.error(text);
    console.error("\nThe authorization code is single use and is now invalidated.");
    console.error("Fix the issue above, then re-run this script to get a fresh code.");
    exit(1);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.error("Token endpoint returned a non-JSON response:\n");
    console.error(text);
    exit(1);
  }

  console.log("Token exchange succeeded.\n");

  if (data.refresh_token) {
    const days = data.refresh_token_expires_in
      ? Math.round(data.refresh_token_expires_in / 86400)
      : null;
    console.log("================ YOUR REFRESH TOKEN ================\n");
    console.log(data.refresh_token);
    console.log("\n====================================================\n");
    console.log("Store this now as a GitHub Actions repository secret named:");
    console.log("  LINKEDIN_REFRESH_TOKEN");
    console.log("(Repo > Settings > Secrets and variables > Actions > New repository secret)");
    if (days) {
      console.log(`\nThis refresh token expires in about ${days} days.`);
      console.log("Set a calendar reminder to re-run this authorization before then.");
    } else {
      console.log("\nRefresh tokens typically last about 365 days.");
      console.log("Set a calendar reminder to re-run this authorization in about 11 months.");
    }
    console.log("\nDo not paste this token into chat tools, screenshots, files, or code.");
  } else {
    console.log("NOTE: LinkedIn returned an access token but NO refresh token.");
    console.log("Access token expires in about " + Math.round((data.expires_in || 0) / 86400) + " days.");
    console.log("\nRefresh tokens are issued to apps with Community Management API access.");
    console.log("If this keeps happening, check the app's product access in the");
    console.log("LinkedIn Developer Portal, then re-run this script.");
    console.log("\nFull response keys received: " + Object.keys(data).join(", "));
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err.message);
  exit(1);
});
