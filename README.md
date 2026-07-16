# fr8topia-linkedin-sync

Daily sync of Fr8topia LLC LinkedIn Company Page posts into the Webflow CMS.

Once a day, a GitHub Actions job pulls the most recent posts from the
Fr8topia LLC LinkedIn Page and creates them as DRAFT items in the Webflow
"LinkedIn Posts" collection. A human reviews and publishes them in Webflow.
Nothing is ever auto-published. Post images are re-hosted to Webflow Assets
so they never break when LinkedIn's temporary image links expire.

## How it works

1. `.github/workflows/sync.yml` runs daily (and on demand via Run workflow).
2. `src/sync.js` refreshes the LinkedIn access token from the stored refresh
   token, fetches the page's recent posts, skips any post already synced
   (matched by LinkedIn URN), re-hosts images to Webflow Assets, and creates
   new items as drafts in the Webflow collection.
3. You review the drafts in Webflow's CMS and publish the ones you want live.

There are no runtime dependencies. Node 20 or newer is all that is needed.

## Required GitHub Actions secrets

Set these under Repo > Settings > Secrets and variables > Actions:

| Secret | What it is |
| --- | --- |
| `LINKEDIN_CLIENT_ID` | From the LinkedIn app's Auth tab |
| `LINKEDIN_CLIENT_SECRET` | From the LinkedIn app's Auth tab |
| `LINKEDIN_REFRESH_TOKEN` | Produced by the one-time authorize step below |
| `LINKEDIN_ORG_URN` | Full URN, e.g. `urn:li:organization:99349913` |
| `WEBFLOW_API_TOKEN` | Webflow site API token with CMS read and write |
| `WEBFLOW_SITE_ID` | Webflow site ID |
| `WEBFLOW_COLLECTION_ID` | The "LinkedIn Posts" collection ID |

## One-time authorization (mints the refresh token)

Requires Node 20+ installed locally (https://nodejs.org, LTS version).
The person running this must be an admin of the Fr8topia LLC LinkedIn Page.

```
npm run authorize
```

The script prints a LinkedIn URL. Open it, sign in, click Allow, then copy
the `code` value from the redirected URL in the browser address bar (the
callback page may show a 404; that is expected). Paste the code back into
the script. On success it prints the refresh token.

Store that value as the GitHub secret `LINKEDIN_REFRESH_TOKEN` immediately,
then close the terminal. Do not save the token anywhere else.

Notes:

- The authorization code is single use and expires within minutes. A failed
  exchange invalidates it. If anything goes wrong, re-run the script for a
  fresh code. Never retry an old code.
- The refresh token lasts about 365 days. Set a calendar reminder to re-run
  this authorization in about 11 months. Access tokens (60 days) are
  refreshed automatically by the daily job; no action needed for those.

## Running and testing

- Manual run: repo > Actions > "LinkedIn to Webflow Sync" > Run workflow.
- The job log shows counts of items created and skipped. Running it twice in
  a row should create zero duplicates the second time.
- New items appear in Webflow > CMS > LinkedIn Posts as drafts.

## Maintenance

- Annual: re-run the authorize step and update `LINKEDIN_REFRESH_TOKEN`.
- Rare: if LinkedIn retires the API version, the job fails with an error
  naming supported versions. Update the `LINKEDIN_VERSION` constant at the
  top of `src/sync.js` and commit.
- If the LinkedIn client secret is ever exposed, rotate it in the LinkedIn
  Developer Portal and update the `LINKEDIN_CLIENT_SECRET` secret here.
