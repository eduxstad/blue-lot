# Blue Lot

Live stall availability for the SpaceX Hawthorne Blue Lot chargers, from the same feed as [spxchargers.streamlit.app](https://spxchargers.streamlit.app/).

Open stalls are green. In-use stalls are red. A clock badge marks a session longer than 16 hours, and the length includes days. Last seen is relative until you tap it, which shows the absolute time in your local zone.

## Phone

The web app is the phone UI. A sideloadable APK is checked in at [src/Blue-Lot.apk](src/Blue-Lot.apk) and [public/Blue-Lot.apk](public/Blue-Lot.apk). The Android project that builds it is in [android/](android/).

```bash
npm install
npm test
npm run dev
```

## Android Auto

A custom charging screen cannot be sideloaded. Google only runs Android for Cars App Library apps that were installed from the Play Store, including a private internal-test track. The unknown-sources switch does not cover those apps.

The APK in this repo is the workaround: a media app. With Android Auto’s unknown-sources option on, it shows up with the other media apps and can stay on screen while driving. Each row is a stall number with the floor and bank underneath. The car draws that list. Colors, cards, and custom buttons are not available in a sideloaded media app.

## Layout

| Path | What it is |
| --- | --- |
| `src/components/blue-lot.tsx` | Phone UI |
| `src/lib/chargers.ts` | Feed parsing, durations, last-seen formatting |
| `src/lib/chargers.test.ts` | Unit tests |
| `src/components/blue-lot.stories.test.tsx` | UI tests |
| `android/` | WebView shell and the Android Auto media service |
