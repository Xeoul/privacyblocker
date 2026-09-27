# privacyblocker

A private, local-first tool for getting your personal information off data brokers and people-search sites. Built for California residents.

- **No server, no account.** Everything runs in your browser. What you enter is encrypted with your passphrase (PBKDF2-SHA256, 600k iterations, then AES-256-GCM) and stored only in that browser.
- **Can't send data anywhere.** The page's Content Security Policy sets `connect-src 'none'`, so the app itself cannot make network requests. The only data that leaves is what you paste into a broker's form or send in an email.
- **No dependencies.** Plain HTML/CSS/JS modules with no build step and no third-party code.

## What it does

1. **California DROP first.** DROP (Delete Request and Opt-out Platform, <https://consumer.drop.privacy.ca.gov/>) is the state's free portal. One request goes to every registered data broker (500+). Brokers have had to process these requests since Aug 1, 2026 and must check DROP again at least every 45 days. The dashboard tracks whether you've submitted and stores your DROP ID.
2. **Opt-out checklist.** About 40 people-search sites, marketing brokers and extra protections (credit freeze, Google "Results about you", OptOutPrescreen, Do Not Call), in priority order. Each one lists its opt-out link, steps, what it requires (CAPTCHA, email confirmation, phone call…) and the sister sites it also covers.
3. **Status tracking with reminders.** Mark each site *not listed / listed / submitted / removed*. The dashboard shows what's due: whether a submitted request went through (after about 14 days) and re-checks for re-listing (about 90 days after removal).
4. **One-tap copy.** Your name, opt-out email, address and phone numbers appear as copy buttons on every broker page.
5. **CCPA request emails.** Generates a deletion and opt-out request citing Cal. Civ. Code §§ 1798.105, .120, .121 and .130, with only the details you choose to include. It opens in your email app.
6. **Encrypted backups.** Download the encrypted vault file and restore it on another device.

## Email autopilot (free, hands-off)

`autopilot/` is a scheduled GitHub Actions job. It emails about 25 brokers a California deletion request from your opt-out Gmail, opens their confirmation links, and emails you a summary. Contact addresses come from the California Data Broker Registry. Setup takes about 10 minutes from a phone: see [autopilot/SETUP.md](autopilot/SETUP.md).

## Run it

Requires Node 20+.

```sh
npm start        # http://localhost:8080
npm test                                   # web app
python3 -m unittest discover -s autopilot  # autopilot
```

Opening `index.html` directly from disk (`file://`) won't work. Browsers block ES modules and clipboard access there, so use `npm start` or the hosted copy.

## Hosted copy (GitHub Pages)

Every push to `main` runs the tests and publishes the app (only `index.html`, `styles.css`, `src/`, `icons/` and the manifest) to <https://xeoul.github.io/privacyblocker/>.

- **Your data still never goes to GitHub.** Pages serves the code; the encrypted vault lives in each device's browser. Your phone and laptop keep separate vaults, so use **Settings → Download encrypted backup / Restore** to move progress between them.
- **Install it on your phone.** In Safari, tap Share → **Add to Home Screen**. It then opens full-screen like an app.
- The site is public, but it contains nothing personal: it's the same code as this repo.
- All `xeoul.github.io/*` project sites share one browser origin. Only host code you trust there. The vault is encrypted either way.

One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**. Pages from a private repo needs GitHub Pro; the alternative is making the repo public, which is safe because no personal data is in it.

## Tips

- Use an **email alias** (iCloud Hide My Email, SimpleLogin, Firefox Relay) as your opt-out email.
- **Only give a broker information it already shows about you.**
- Brokers re-list people. Keep doing the re-checks.
- There is **no passphrase recovery**. Keep a backup and remember the passphrase.

## Credits

The broker opt-out links and steps are based on the [Big Ass Data Broker Opt-Out List](https://github.com/yaelwrites/Big-Ass-Data-Broker-Opt-Out-List) by Yael Grauer and contributors (CC BY-NC-SA 4.0), revision of 2026-08-27. Broker opt-out pages change often. If a link breaks, update `src/brokers.js`.
