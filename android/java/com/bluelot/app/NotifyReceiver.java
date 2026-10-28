package com.bluelot.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public class NotifyReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String action = intent.getAction();
        if (StallAlerts.ACTION_IGNORE.equals(action)) {
            StallAlerts.ignore(context, intent.getStringExtra("stall"));
            return;
        }
        if (StallAlerts.ACTION_DISABLE.equals(action)) {
            StallAlerts.disable(context);
            return;
        }
        if (!StallAlerts.ACTION_POLL.equals(action) && !Intent.ACTION_BOOT_COMPLETED.equals(action)) return;
        if (!StallAlerts.enabled(context)) return;
        final PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                StallAlerts.poll(context.getApplicationContext());
            } finally {
                pending.finish();
            }
        }).start();
    }
}
