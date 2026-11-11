# Keys and accounts

The app runs with **no keys**. Each key below switches on one more capability.
Put values in `.env` (never commit that file), then run `make up`.

| Priority | Service | What it unlocks | Cost | Where to get it | `.env` name |
|---|---|---|---|---|---|
| 1 | Anthropic | Claude reads free-text requests, the analyst (Ask tab) and outreach drafts | Pay per use, a few cents per request | console.anthropic.com → API keys | `ANTHROPIC_API_KEY` |
| 2 | Jira Cloud | **Connected.** Real ops tickets on approval | Free plan (10 users) | atlassian.com/software/jira/free, then id.atlassian.com/manage-profile/security/api-tokens | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY` |
| 3 | Slack | **Code ready.** Messages for new orders, decisions and events scoring 30+ | Free workspace | api.slack.com/apps → Create app → Incoming Webhooks | `SLACK_WEBHOOK_URL` |
| 4 | Salesforce | Real CRM deals instead of simulated ones | Free Developer Edition | developer.salesforce.com/signup, then create an External Client App with the client-credentials flow | `SALESFORCE_INSTANCE_URL`, `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET` |
| 5 | AISStream | Live ship positions near ports (port-monitoring customers) | Free | aisstream.io → sign in with GitHub → API keys | `AISSTREAM_API_KEY` |
| 6 | NASA FIRMS | Satellite-detected fire hotspots, more precise than the current wildfire feed | Free | firms.modaps.eosdis.nasa.gov/api/map_key | `FIRMS_MAP_KEY` |
| done | AWS | Deploying it: see `infra/README.md` (Terraform, ECS Fargate, Aurora, CloudFront) | Free-plan credits; a budget alarm is part of the bootstrap | aws.amazon.com/free | none in `.env`: `aws login`, short-lived credentials only |

Already in use, no key needed: CelesTrak (orbits), USGS (earthquakes), GDACS
(disaster alerts and floods), NASA EONET (storms, wildfires), NOAA GFS (cloud
forecast, whole-world files), NOAA SWPC (space weather), GeoNames (bundled city
list), Natural Earth (bundled borders).

Jira and Slack are built: they switch on as soon as their `.env` values are
present (restart with `make up`). Salesforce, AISStream and FIRMS have `.env`
slots but no code yet; each gets built and tested once its key exists.
