# Blue Lot

Blue Lot shows which Level 2 chargers are free in the SpaceX Hawthorne garage. It reads the same live feed as the [Blue Lot dashboard](https://spxchargers.streamlit.app/), `https://chargers.kitu.io/api/site/8`.

Stalls are grouped by floor. Bank A and Bank B are the two rows on a floor, taken from the gateway name (`KT-SX-2A` is floor 2, bank A). A stall with no bank letter is labeled J1772. Each stall shows its number, bank, and status.

- **Open** stalls are green. The app times how long it has seen the stall free. The charger feed does not report that, so the clock starts the first time this app sees the stall open and resets when the stall is taken. Under a minute shows as `<1m`.
- **In use** stalls are red. Session length includes days and hours. A clock badge appears after 16 hours.
- **Offline** stalls are dashed.
- **Last seen** is relative. Tap it to show the absolute time in the phone's time zone.

The list refreshes every 30 seconds. Filters are Open, In use, Offline, and Saved. On a phone, swipe sideways to move between those filters. Search is by stall number. Tap a stall for power, plug state, session or open time, and a directions link. Star a stall to keep it on Saved. Feedback opens an email to `bluelotfeedback@mail.grokbot.com`. The footer shows the app version, currently **1.12.0**.

## Alerts

The notify toggle watches for a busy or offline stall to become free. Stalls that are already open do not alert. Each notification names the stall, floor, and bank.

- Tap the notification to open that stall.
- **Ignore Stall** stops future alerts for that stall.
- **Disable Notifications** turns the toggle off.

The phone checks about once a minute, and also on each refresh while the app is open. Android can delay the check while the phone is idle. A failed refresh does not overwrite a live reading the app already has.

## Install

The sideloadable APK is [public/Blue-Lot.apk](public/Blue-Lot.apk). It installs over the previous signed build. The phone screen is a WebView of the same UI.

```bash
npm install
npm test
npm run dev
```

The Android project is in [android/](android/). `android/build.sh` builds the APK.

## Android Auto

Android Auto runs Blue Lot as a charging app from the Android for Cars App Library. Google only runs that kind of app when it was installed from the Play Store. The internal testing track counts. The Play application id is `com.duxstad.bluelotchargers`. A sideloaded APK still opens the phone screen, and it does not show this car app. The unknown-sources switch does not cover it.

The car screen reads the same charger feed as the phone. Each stall shows its number, floor, bank, and status. An open stall also shows how long this car app has seen it free. That clock is not in the feed: it starts the first time this app sees the stall open and resets when the stall is taken. Under a minute shows as `<1m`. An in-use stall shows the session length from the feed. Offline stalls are labeled offline. The action strip pages through the list and refreshes it. When the live feed does not answer, the title marks the list as a saved reading.

Tap a stall for the floor and bank, the gateway row, plug state, power, and the open or in-use duration. Navigate sends the garage address from the feed to the car's navigation app. That is the same place the phone's directions link uses. Stalls do not have their own coordinates, so the template starts navigation to the garage.

## Layout

| Path | What it is |
| --- | --- |
| `src/components/blue-lot.tsx` | Phone UI |
| `src/components/page-swipe.ts` | Horizontal filter swipe |
| `src/lib/chargers.ts` | Feed parsing, durations, open-stall clock |
| `src/lib/chargers.test.ts` | Unit tests |
| `src/components/blue-lot.stories.test.tsx` | UI tests |
| `android/` | WebView shell, notifications, and the Android Auto charging app |
