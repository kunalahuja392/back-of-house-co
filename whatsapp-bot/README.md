# Back of House Co — WhatsApp bot

Sends every Back of House Co notification (orders, allocations, reminders, payments, daily report)
from **your own WhatsApp number**, using WhatsApp Web. Free — but read the warning.

> ⚠️ **Risk:** this is not WhatsApp's official API. WhatsApp's rules don't allow automated use of
> normal accounts, and the number **can be banned**. Use a **separate business SIM** (not your personal
> or main business number), keep the volume reasonable, and keep email notifications on as a backup.

## What you need
- A computer that stays **on and connected** during working hours (Windows, Mac or Linux), or a small cloud server.
- **Node.js 18 or newer** — download the "LTS" version from https://nodejs.org and install it.
- A phone with WhatsApp on the number you'll send from.

## Set up (once)
1. Download this `whatsapp-bot` folder (GitHub → Code → Download ZIP, then unzip).
2. In Back of House Co, sign in as **super admin** → **Settings → Notifications** → copy the **Bot key**.
3. In the `whatsapp-bot` folder, copy `config.example.json` to `config.json`, open it and paste the key into `botKey`.
4. Start it:
   - **Windows:** double-click `start-windows.bat`
   - **Mac / Linux:** open Terminal in the folder and run `./start-mac-linux.sh`
5. The first time, it installs itself (a few minutes) and shows a **QR code**. On the business phone open
   WhatsApp → **Settings → Linked devices → Link a device** and scan it.
6. You'll see "WhatsApp is ready". Leave the window open. In the app, **Settings → Notifications** shows the bot as
   **online**. Use **Send test WhatsApp** to check.

After that it remembers the login. If the computer restarts, just run the start file again.

## Good to know
- Messages wait in a queue — if the bot is off, they're sent when it comes back.
- It pauses 4–10 seconds between messages and sends at most 120 an hour (change in `config.json`).
- Numbers not on WhatsApp are marked failed in **Notifications** in the app.
- Indian numbers without a country code get `91` added automatically.
- To log out: WhatsApp on the phone → Linked devices → remove it, then delete the `.wa-session` folder.
- If you change the bot key in the app, update `config.json` too.
