# Ground-truth OAuth walkthroughs (agent-executed)

Real console attempts behind the guide library. Each row feeds the README
ground-truth audit and the "verified by testing" badge tier.

## GitHub (2026-11-03) - walked through app registration + client credential issuance

Created a real OAuth app ("OAuth Guides Walkthrough Test") on a free GitHub
account: https://github.com/settings/applications/3989320 (Client ID issued
instantly, one client secret generated). Total hands-on time: ~4 minutes.

What the docs get right:
- App creation is instant and self-serve: name, homepage URL, one callback
  URL. No review, no paid tier, no domain or privacy-policy requirement.

What the docs omit or understate:
- The client secret is a SECOND explicit step ("Generate a new client
  secret") and GitHub forces a sudo-mode password re-confirmation before
  issuing it. An agent needs the account password (or the user, with 2FA) to
  pass this step - a credential-dependent gate the quickstart never mentions.
  The walkthrough held the account password and completed it.
- Scopes are not configured in the console at all; they are requested at
  authorize-time. First-time console users look for a scopes section that
  does not exist.
- In this single-account walkthrough no user cap, verification program, or
  app review gate was encountered for an OAuth App (contrast Google's
  documented verification program). One console observation is not proof
  none exists; GitHub's docs reserve review for GitHub Apps and Marketplace
  listings, a different product that was not exercised.
- The only client secret cannot be deleted without generating a
  replacement first (fine print on the settings page).

Consequence for the guide: the "5-minute setup" reputation held for dev
credentials in this walkthrough, and no production approval wait was
encountered (scope: one OAuth App registration; Marketplace/GitHub App review
paths were not exercised).


## Linear (walkthrough 2026-11-03)

Executed: Google sign-up -> forced onboarding wizard -> OAuth application created
(Settings > API > New application) -> client ID + client secret issued.

Ground-truth deltas vs docs-only research:
- New accounts pass a forced onboarding wizard (profile, invite teammates,
  connect GitHub, connect Slack, newsletter); every step has a Skip, and the
  profile step pre-fills the Google account name.
- The OAuth app form asks for: application name, developer name, developer URL
  (required for PUBLIC apps only), description, redirect URIs (newline
  separated), optional GitHub username (actor=app commit attribution), and
  checkboxes for Public availability, client_credentials grant support, and
  webhooks.
- No approval, review, or waiting period for workspace-private apps: the
  client ID is issued instantly and a client secret is auto-generated
  (masked, rotatable). No sudo-style password re-confirmation (contrast
  GitHub, which requires it for secret generation).
- Apps default to "Private to this workspace"; making an app installable by
  other workspaces is an explicit Public checkbox.
