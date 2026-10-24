package com.bluelot.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Shared stall parser for the phone app and the Android Auto panel. */
public final class ChargerFeed {
    public static final String SITE = "https://chargers.kitu.io/api/site/8";

    private static final int[] FALLBACK_IDS = {8, 9, 10, 11, 12, 13, 14, 15, 16};
    private static final int[] FALLBACK_FLOORS = {1, 2, 2, 3, 3, 5, 5, 6, 6};

    public static final class Stall {
        public final String name;
        public final int floor;
        public final String bank;
        public final String gateway;
        public final String availability;
        public final boolean pluggedIn;
        public final int amps;
        public final int volts;
        public final Long sessionSeconds;
        public final Long seenAt;

        Stall(String name, int floor, String bank, String gateway, String availability,
              boolean pluggedIn, int amps, int volts, Long sessionSeconds, Long seenAt) {
            this.name = name;
            this.floor = floor;
            this.bank = bank;
            this.gateway = gateway;
            this.availability = availability;
            this.pluggedIn = pluggedIn;
            this.amps = amps;
            this.volts = volts;
            this.sessionSeconds = sessionSeconds;
            this.seenAt = seenAt;
        }

        public String place() {
            String floorLabel = floor == 0 ? "Unassigned" : "Floor " + floor;
            return bank == null || bank.length() == 0 ? floorLabel : floorLabel + " · Bank " + bank;
        }

        public String power() {
            if (volts <= 0 || amps <= 0) return "J1772";
            double kw = (volts * (double) amps) / 1000.0;
            return amps + " A · " + String.format(java.util.Locale.US, "%.1f kW", kw);
        }
    }

    public static final class Snapshot {
        public final boolean live;
        public final List<Stall> stalls;

        Snapshot(boolean live, List<Stall> stalls) {
            this.live = live;
            this.stalls = stalls;
        }

        public List<Stall> openStalls() {
            List<Stall> open = new ArrayList<Stall>();
            for (Stall stall : stalls) {
                if ("open".equals(stall.availability)) open.add(stall);
            }
            return open;
        }
    }

    private ChargerFeed() {}

    public static Snapshot load(String fallbackJson) {
        try {
            String body = download(SITE);
            if (body != null) return new Snapshot(true, parse(body));
        } catch (Exception ignored) {
            /* fall through to the saved reading */
        }
        try {
            if (fallbackJson != null) return new Snapshot(false, parse(fallbackJson));
        } catch (Exception ignored) {
            /* empty board */
        }
        return new Snapshot(false, new ArrayList<Stall>());
    }

    public static String readStream(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) >= 0) out.write(buf, 0, n);
        return out.toString("UTF-8");
    }

    private static String download(String url) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(4000);
        conn.setReadTimeout(5000);
        conn.setRequestProperty("Accept", "application/json");
        conn.setRequestProperty("User-Agent", "BlueLot/1.0");
        try {
            if (conn.getResponseCode() != 200) return null;
            return readStream(conn.getInputStream());
        } finally {
            conn.disconnect();
        }
    }

    static List<Stall> parse(String body) throws Exception {
        JSONObject root = new JSONObject(body);
        JSONArray stations = root.optJSONArray("stations");
        if (stations == null && root.optJSONArray("stalls") != null) {
            return parseSaved(root.optJSONArray("stalls"));
        }
        Map<Integer, String> gateways = new HashMap<Integer, String>();
        JSONArray gatewayList = root.optJSONArray("gateways");
        if (gatewayList != null) {
            for (int i = 0; i < gatewayList.length(); i++) {
                JSONObject gateway = gatewayList.optJSONObject(i);
                if (gateway == null || !gateway.has("id")) continue;
                String name = gateway.optString("name", "");
                if (name.length() > 0) gateways.put(gateway.getInt("id"), name);
            }
        }
        List<Stall> stalls = new ArrayList<Stall>();
        if (stations == null) return stalls;
        for (int i = 0; i < stations.length(); i++) {
            JSONObject station = stations.optJSONObject(i);
            if (station == null || station.optString("name", "").length() == 0) continue;
            int gatewayId = station.optInt("gatewayId", 0);
            String gateway = gateways.containsKey(gatewayId) ? gateways.get(gatewayId) : "Gateway " + gatewayId;
            int floor = 0;
            String bank = "";
            java.util.regex.Matcher match = java.util.regex.Pattern.compile("KT-SX-(\\d+)([A-Z])?", java.util.regex.Pattern.CASE_INSENSITIVE).matcher(gateway);
            if (match.find()) {
                floor = Integer.parseInt(match.group(1));
                bank = match.group(2) == null ? "" : match.group(2).toUpperCase(java.util.Locale.US);
            } else {
                for (int f = 0; f < FALLBACK_IDS.length; f++) {
                    if (FALLBACK_IDS[f] == gatewayId) floor = FALLBACK_FLOORS[f];
                }
            }
            JSONObject info = station.optJSONObject("info");
            String availability = "offline";
            boolean plugged = false;
            int amps = 0;
            int volts = 0;
            Long session = null;
            Long seen = null;
            if (info != null) {
                if ("online".equals(info.optString("status"))) {
                    availability = "charging".equals(info.optString("chargeStatus")) ? "busy" : "open";
                }
                plugged = "connected".equals(info.optString("connection"));
                amps = info.optInt("max_charge_current", 0);
                volts = info.optInt("operating_voltage", 0);
                if ("busy".equals(availability) && info.has("current_session_duration")) {
                    long value = info.optLong("current_session_duration", 0);
                    if (value > 0) session = Long.valueOf(value);
                }
                if (info.has("timestamp")) seen = Long.valueOf(info.optLong("timestamp"));
            }
            stalls.add(new Stall(station.optString("name"), floor, bank, gateway, availability, plugged, amps, volts, session, seen));
        }
        Collections.sort(stalls, new Comparator<Stall>() {
            @Override
            public int compare(Stall a, Stall b) {
                if (a.floor != b.floor) return a.floor - b.floor;
                try {
                    return Integer.compare(Integer.parseInt(a.name), Integer.parseInt(b.name));
                } catch (NumberFormatException err) {
                    return a.name.compareTo(b.name);
                }
            }
        });
        return stalls;
    }

    private static List<Stall> parseSaved(JSONArray stalls) {
        List<Stall> out = new ArrayList<Stall>();
        for (int i = 0; i < stalls.length(); i++) {
            JSONObject stall = stalls.optJSONObject(i);
            if (stall == null) continue;
            Long session = stall.isNull("sessionSeconds") ? null : Long.valueOf(stall.optLong("sessionSeconds"));
            Long seen = stall.isNull("seenAt") ? null : Long.valueOf(stall.optLong("seenAt"));
            out.add(new Stall(
                    stall.optString("name"),
                    stall.optInt("floor"),
                    stall.optString("bank"),
                    stall.optString("gateway"),
                    stall.optString("availability", "offline"),
                    stall.optBoolean("pluggedIn"),
                    stall.optInt("amps"),
                    stall.optInt("volts"),
                    session,
                    seen));
        }
        return out;
    }
}
