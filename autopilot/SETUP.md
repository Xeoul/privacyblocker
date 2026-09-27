# Email autopilot — setup from your phone (about 10 minutes)

The autopilot is a free scheduled GitHub Actions job. Once a day it:

1. **Sends a California privacy-law deletion and opt-out request** from your opt-out Gmail to about 25 data brokers and people-search companies. It sends at most once every 180 days per broker, and finds past requests by searching your Sent mail. The list is in `brokers.json`. It sends at most 8 per day, so a new Gmail account isn't flagged as spam; the first round finishes in about 3 days. To change the limit, set a `MAX_SENDS_PER_RUN` variable.
2. **Opens confirmation links** in broker emails to that inbox, including emails that land in spam, then labels each one `privacyblocker-done`.
3. **Emails you a summary**, only when something happened: what it sent, what it confirmed, which links need your tap, and which broker replies to read.

It's free. GitHub Actions is free for public repos.

**Your privacy:**
- Your details live only in encrypted GitHub **secrets** and in your own mailbox. Nothing personal is written to the repo.
- The job's logs are public (this is a public repo), so the script only ever prints counts, like `sent=24 confirmed=3`.

## 1. Gmail: create an app password

Use the Gmail account you want brokers to see, ideally one used only for opt-outs.

1. Turn on 2-Step Verification: <https://myaccount.google.com/signinoptions/twosv>
2. Create an app password: <https://myaccount.google.com/apppasswords>. Name it `PrivacyBlocker` and copy the 16-letter code.

## 2. Copy your details from the app

In PrivacyBlocker, go to **Settings → Copy autopilot PROFILE**. It looks like this:

```
name: Jane Q Public
address: 1 Main St, San Jose, CA 95112
phone: 408-555-0100
drop: yes
share: name, address, phone
```

- `share:` controls what goes in each request. Only the fields listed are sent; the others are just stored.
- The options for `share:` are `name, other_name, address, past_address, phone, email, dob`.
- Sharing less means brokers learn less, but they may have a harder time finding your record.

## 3. Add three GitHub secrets

In Safari, open <https://github.com/Xeoul/privacyblocker/settings/secrets/actions>. You may need "Request Desktop Website" in the **aA** menu. Tap **New repository secret** three times:

| Name | Value |
|---|---|
| `OPTOUT_EMAIL` | your opt-out Gmail address |
| `OPTOUT_APP_PASSWORD` | the 16-letter app password |
| `PROFILE` | what you copied in step 2 |

## 4. Preview first (nothing is sent to brokers)

1. Open <https://github.com/Xeoul/privacyblocker/actions/workflows/autopilot.yml>.
2. Tap **Run workflow**, choose **preview**, then **Run workflow**.
3. Within a minute or two you'll get an email titled **"PrivacyBlocker autopilot preview"** containing every request it would send. Read one.

## 5. Go live

1. **Send now:** run the workflow again and choose **live**.
2. **Keep it running every day:** open <https://github.com/Xeoul/privacyblocker/settings/variables/actions>, tap **New repository variable**, name it `AUTOPILOT_MODE` and set the value to `live`.

## Stop or pause

- Change `AUTOPILOT_MODE` to `off`, or delete it.
- To cut off all access, also delete the app password at <https://myaccount.google.com/apppasswords>.

## What it can't do

- **Web-form-only sites.** Some brokers reply "please use our web form" or claim listings are public records. Those replies appear in your summary; handle them with the PrivacyBlocker checklist.
- **Pages that need a button press.** Some confirmation pages need a real tap, or block robots. The summary lists those links so you can tap them on your phone.
- **Gmail only.** It uses Gmail's search extensions.
