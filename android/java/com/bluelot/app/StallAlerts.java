package com.bluelot.app;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.SystemClock;

import org.json.JSONObject;

import java.util.List;

public final class StallAlerts {
    static final String ACTION_POLL = "com.bluelot.app.POLL";
    static final String ACTION_IGNORE = "com.bluelot.app.IGNORE";
    static final String ACTION_DISABLE = "com.bluelot.app.DISABLE";
    private static final String PREFS = "bluelot-notify";
    private static final String CHANNEL = "open-stalls";
    private static final long INTERVAL_MS = 60_000L;

    private StallAlerts() {}

    public static boolean enabled(Context context) {
        return prefs(context).getBoolean("enabled", false);
    }

    public static void enable(Context context) {
        prefs(context).edit().putBoolean("enabled", true).apply();
        seedBaseline(context);
        schedule(context);
    }

    public static void disable(Context context) {
        prefs(context).edit().putBoolean("enabled", false).apply();
        cancelAlarm(context);
        NotificationManager manager = manager(context);
        if (manager != null) manager.cancelAll();
    }

    public static void ignore(Context context, String name) {
        if (name == null || name.length() == 0) return;
        SharedPreferences prefs = prefs(context);
        String raw = prefs.getString("ignored", "");
        if (!contains(raw, name)) {
            prefs.edit().putString("ignored", raw.length() == 0 ? name : raw + "," + name).apply();
        }
        NotificationManager manager = manager(context);
        if (manager != null) manager.cancel(name.hashCode());
    }

    public static void observe(Context context, String body) {
        if (!enabled(context) || body == null) return;
        try {
            apply(context, ChargerFeed.parse(body));
        } catch (Exception ignored) {
            /* a bad payload must not erase the baseline */
        }
    }

    public static void poll(Context context) {
        if (!enabled(context)) return;
        ChargerFeed.Snapshot snapshot = ChargerFeed.load(null);
        if (snapshot.live) apply(context, snapshot.stalls);
        schedule(context);
    }

    private static void seedBaseline(Context context) {
        ChargerFeed.Snapshot snapshot = ChargerFeed.load(null);
        if (!snapshot.live) return;
        JSONObject next = new JSONObject();
        try {
            for (ChargerFeed.Stall stall : snapshot.stalls) next.put(stall.name, stall.availability);
            prefs(context).edit().putString("baseline", next.toString()).apply();
        } catch (Exception ignored) {
            /* the next live poll becomes the baseline */
        }
    }

    private static void apply(Context context, List<ChargerFeed.Stall> stalls) {
        ensureChannel(context);
        SharedPreferences prefs = prefs(context);
        JSONObject previous = readBaseline(prefs);
        boolean haveBaseline = previous.length() > 0;
        String ignored = prefs.getString("ignored", "");
        JSONObject next = new JSONObject();
        try {
            for (ChargerFeed.Stall stall : stalls) {
                String prior = previous.optString(stall.name, "");
                if (haveBaseline
                        && "open".equals(stall.availability)
                        && prior.length() > 0
                        && !"open".equals(prior)
                        && !contains(ignored, stall.name)) {
                    notifyOpen(context, stall);
                }
                next.put(stall.name, stall.availability);
            }
            prefs.edit().putString("baseline", next.toString()).apply();
        } catch (Exception ignoredError) {
            /* keep the previous baseline */
        }
    }

    private static void notifyOpen(Context context, ChargerFeed.Stall stall) {
        NotificationManager manager = manager(context);
        if (manager == null) return;
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;

        Intent ignore = new Intent(context, NotifyReceiver.class);
        ignore.setAction(ACTION_IGNORE);
        ignore.putExtra("stall", stall.name);
        PendingIntent ignorePi = PendingIntent.getBroadcast(context, stall.name.hashCode(), ignore, flags);

        Intent disable = new Intent(context, NotifyReceiver.class);
        disable.setAction(ACTION_DISABLE);
        PendingIntent disablePi = PendingIntent.getBroadcast(context, 1, disable, flags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(context, CHANNEL)
                : new Notification.Builder(context);
        builder.setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle("Stall " + stall.name + " is open")
                .setContentText(stall.place())
                .setAutoCancel(true)
                .addAction(new Notification.Action(0, "Ignore Stall", ignorePi))
                .addAction(new Notification.Action(0, "Disable Notifications", disablePi));
        manager.notify(stall.name.hashCode(), builder.build());
    }

    static void schedule(Context context) {
        if (!enabled(context)) return;
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms == null) return;
        long when = SystemClock.elapsedRealtime() + INTERVAL_MS;
        if (Build.VERSION.SDK_INT >= 23) {
            alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, when, alarmIntent(context));
        } else {
            alarms.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, when, alarmIntent(context));
        }
    }

    private static void cancelAlarm(Context context) {
        AlarmManager alarms = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarms != null) alarms.cancel(alarmIntent(context));
    }

    private static PendingIntent alarmIntent(Context context) {
        Intent intent = new Intent(context, NotifyReceiver.class);
        intent.setAction(ACTION_POLL);
        return PendingIntent.getBroadcast(
                context,
                42,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = manager(context);
        if (manager == null || manager.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Open stalls", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("A stall just became free");
        manager.createNotificationChannel(channel);
    }

    private static JSONObject readBaseline(SharedPreferences prefs) {
        try {
            return new JSONObject(prefs.getString("baseline", "{}"));
        } catch (Exception err) {
            return new JSONObject();
        }
    }

    private static boolean contains(String csv, String name) {
        if (csv == null || csv.length() == 0) return false;
        String[] parts = csv.split(",");
        for (String part : parts) {
            if (name.equals(part)) return true;
        }
        return false;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static NotificationManager manager(Context context) {
        return (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
    }
}
