# Ground-truth OAuth walkthroughs (agent-executed)

Real console attempts behind the guide library. Each row feeds the README
ground-truth audit and the "verified by testing" badge tier.

## GitHub (2026-11-03) - walked through to a working app + client secret

Created a real OAuth app ("OAuth Guides Walkthrough Test") on a free GitHub
account: https://github.com/settings/applications/3989320 (Client ID issued
instantly, one client secret generated). Total hands-on time: ~4 minutes.

What the docs get right:
- App creation is instant and self-serve: name, homepage URL, one callback
  URL. No review, no paid tier, no domain or privacy-policy requirement.

What the docs omit or understate:
- The client secret is a SECOND explicit step ("Generate a new client
  secret") and GitHub forces a sudo-mode password re-confirmation before
  issuing it. An agent without the account password (or a user with 2FA)
  stops here - this is a hard human-handoff point the quickstart never
  mentions.
- Scopes are not configured in the console at all; they are requested at
  authorize-time. First-time console users look for a scopes section that
  does not exist.
- No user cap, no verification program, no app review for OAuth Apps
  (unlike Google). Learned by absence: nothing in the console or docs gates
  external users.
- The only client secret cannot be deleted without generating a
  replacement first (fine print on the settings page).

Consequence for the guide: GitHub's "5-minute setup" reputation is accurate
for dev credentials, and there is no production approval wait at all.
