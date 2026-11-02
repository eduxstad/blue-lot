package com.bluelot.app;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;

import androidx.car.app.CarAppService;
import androidx.car.app.CarContext;
import androidx.car.app.Screen;
import androidx.car.app.Session;
import androidx.car.app.constraints.ConstraintManager;
import androidx.car.app.model.Action;
import androidx.car.app.model.ActionStrip;
import androidx.car.app.model.CarIcon;
import androidx.car.app.model.ItemList;
import androidx.car.app.model.ListTemplate;
import androidx.car.app.model.OnClickListener;
import androidx.car.app.model.Pane;
import androidx.car.app.model.PaneTemplate;
import androidx.car.app.model.Row;
import androidx.car.app.model.Template;
import androidx.car.app.validation.HostValidator;
import androidx.core.graphics.drawable.IconCompat;
import androidx.lifecycle.Lifecycle;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Android Auto charging app. Lists stalls from the same feed as the phone,
 * then a detail screen can start navigation when the template allows it.
 */
public class ChargerCarService extends CarAppService {
    @Override
    public HostValidator createHostValidator() {
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            return HostValidator.ALLOW_ALL_HOSTS_VALIDATOR;
        }
        return new HostValidator.Builder(this)
                .addAllowedHosts(R.array.hosts_allowlist)
                .build();
    }

    @Override
    public Session onCreateSession() {
        return new Session() {
            @Override
            public Screen onCreateScreen(Intent intent) {
                return new StallListScreen(getCarContext());
            }
        };
    }

    static String whereLabel(ChargerFeed.Stall stall) {
        String bank = stall.bank == null || stall.bank.length() == 0 ? "J1772" : "Bank " + stall.bank;
        String floor = stall.floor == 0 ? "Unassigned" : "Floor " + stall.floor;
        return floor + " · " + bank;
    }

    static String statusLabel(ChargerFeed.Stall stall) {
        if ("open".equals(stall.availability)) return "Open";
        if ("busy".equals(stall.availability)) return "In use";
        return "Offline";
    }

    static final class DurationText {
        final String title;
        final String label;

        DurationText(String title, String label) {
            this.title = title;
            this.label = label;
        }
    }

    static DurationText durationText(ChargerFeed.Stall stall, long openSeconds) {
        if ("open".equals(stall.availability)) {
            return new DurationText(ChargerFeed.formatWatched(Math.max(0, openSeconds)), "Open for");
        }
        if ("busy".equals(stall.availability)) {
            if (stall.sessionSeconds != null && stall.sessionSeconds.longValue() > 0) {
                return new DurationText(
                        ChargerFeed.formatDuration(stall.sessionSeconds.longValue()),
                        "In use");
            }
            return new DurationText("In use", "Session");
        }
        return new DurationText("Offline", "Status");
    }

    static String statusLine(ChargerFeed.Stall stall, long openSeconds) {
        DurationText duration = durationText(stall, openSeconds);
        if ("open".equals(stall.availability)) return "Open · " + duration.title;
        if ("busy".equals(stall.availability)
                && stall.sessionSeconds != null
                && stall.sessionSeconds.longValue() > 0) {
            return "In use · " + duration.title;
        }
        return duration.title;
    }

    static int statusIcon(ChargerFeed.Stall stall) {
        if ("open".equals(stall.availability)) return R.drawable.ic_open;
        if ("busy".equals(stall.availability)) return R.drawable.ic_busy;
        return R.drawable.ic_offline;
    }

    /** Every stall from the feed, paged to the host's list limit. */
    static final class StallListScreen extends Screen {
        private final ExecutorService executor = Executors.newSingleThreadExecutor();
        private final Handler main = new Handler(Looper.getMainLooper());
        private final Map<Integer, CarIcon> icons = new HashMap<Integer, CarIcon>();
        private boolean loading = true;
        private boolean live = false;
        private String error = null;
        private int page = 0;
        private int generation = 0;
        private List<ChargerFeed.Stall> stalls = new ArrayList<ChargerFeed.Stall>();
        private Map<String, Long> openFor = new HashMap<String, Long>();
        private String directions = "12250 Crenshaw Blvd, Hawthorne, CA";

        StallListScreen(CarContext context) {
            super(context);
            reload();
        }

        private void reload() {
            loading = true;
            error = null;
            final int gen = ++generation;
            invalidate();
            final CarContext context = getCarContext();
            executor.execute(new Runnable() {
                @Override
                public void run() {
                    final ChargerFeed.Snapshot snapshot;
                    try {
                        snapshot = ChargerFeed.load(readFallback());
                    } catch (Exception err) {
                        main.post(new Runnable() {
                            @Override
                            public void run() {
                                if (gen != generation || !alive()) return;
                                loading = false;
                                error = "Couldn't reach the charger feed.";
                                invalidate();
                            }
                        });
                        return;
                    }
                    final Map<String, Long> seen = new HashMap<String, Long>();
                    long nowMs = System.currentTimeMillis();
                    for (ChargerFeed.Stall stall : snapshot.stalls) {
                        long seconds = ChargerFeed.rememberOpen(
                                context,
                                stall.name,
                                "open".equals(stall.availability),
                                nowMs);
                        if (seconds >= 0) seen.put(stall.name, Long.valueOf(seconds));
                    }
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            if (gen != generation || !alive()) return;
                            loading = false;
                            live = snapshot.live;
                            stalls = snapshot.stalls;
                            openFor = seen;
                            directions = snapshot.site.directionsQuery();
                            int pages = pageCount();
                            if (page >= pages) page = pages - 1;
                            if (page < 0) page = 0;
                            invalidate();
                        }
                    });
                }
            });
        }

        private boolean alive() {
            return getLifecycle().getCurrentState() != Lifecycle.State.DESTROYED;
        }

        private String readFallback() {
            try {
                InputStream in = getCarContext().getAssets().open("fallback-snapshot.json");
                try {
                    return ChargerFeed.readStream(in);
                } finally {
                    in.close();
                }
            } catch (Exception err) {
                return null;
            }
        }

        private int pageSize() {
            try {
                ConstraintManager limits =
                        (ConstraintManager) getCarContext().getCarService(ConstraintManager.class);
                int limit = limits.getContentLimit(ConstraintManager.CONTENT_LIMIT_TYPE_LIST);
                if (limit > 0) return limit;
            } catch (Exception ignored) {
                /* host has not published a limit yet */
            }
            return 6;
        }

        private int pageCount() {
            int size = pageSize();
            if (stalls.isEmpty()) return 1;
            return (stalls.size() + size - 1) / size;
        }

        private long openSeconds(ChargerFeed.Stall stall) {
            Long value = openFor.get(stall.name);
            return value == null ? 0 : value.longValue();
        }

        private CarIcon icon(int res) {
            Integer key = Integer.valueOf(res);
            CarIcon cached = icons.get(key);
            if (cached != null) return cached;
            CarIcon created = new CarIcon.Builder(
                    IconCompat.createWithResource(getCarContext(), res)).build();
            icons.put(key, created);
            return created;
        }

        private Action iconAction(int icon, final Runnable action) {
            return new Action.Builder()
                    .setIcon(icon(icon))
                    .setOnClickListener(new OnClickListener() {
                        @Override
                        public void onClick() {
                            action.run();
                        }
                    })
                    .build();
        }

        private Action labeledAction(String title, int icon, final Runnable action) {
            return new Action.Builder()
                    .setTitle(title)
                    .setIcon(icon(icon))
                    .setOnClickListener(new OnClickListener() {
                        @Override
                        public void onClick() {
                            action.run();
                        }
                    })
                    .build();
        }

        @Override
        public Template onGetTemplate() {
            ListTemplate.Builder template = new ListTemplate.Builder()
                    .setTitle(title())
                    .setHeaderAction(Action.APP_ICON)
                    .setActionStrip(strip());
            if (loading) return template.setLoading(true).build();

            ItemList.Builder list = new ItemList.Builder();
            if (error != null) {
                list.setNoItemsMessage(error);
            } else if (stalls.isEmpty()) {
                list.setNoItemsMessage("No stalls right now");
            } else {
                int size = pageSize();
                int start = page * size;
                int end = Math.min(stalls.size(), start + size);
                for (int i = start; i < end; i++) {
                    final ChargerFeed.Stall stall = stalls.get(i);
                    final long seenOpen = openSeconds(stall);
                    list.addItem(new Row.Builder()
                            .setTitle(stall.name)
                            .addText(whereLabel(stall))
                            .addText(statusLine(stall, seenOpen))
                            .setImage(icon(statusIcon(stall)), Row.IMAGE_TYPE_ICON)
                            .setBrowsable(true)
                            .setOnClickListener(new OnClickListener() {
                                @Override
                                public void onClick() {
                                    getScreenManager().push(new StallDetailScreen(
                                            getCarContext(), stall, seenOpen, directions));
                                }
                            })
                            .build());
                }
            }
            return template.setSingleList(list.build()).build();
        }

        /**
         * The list action strip allows two actions, and only one of them may have a title.
         * Middle pages keep previous and next. Refresh is the labeled action on the ends.
         */
        private ActionStrip strip() {
            ActionStrip.Builder strip = new ActionStrip.Builder();
            int pages = pageCount();
            boolean hasPrev = !loading && error == null && pages > 1 && page > 0;
            boolean hasNext = !loading && error == null && pages > 1 && page < pages - 1;
            Runnable refresh = new Runnable() {
                @Override
                public void run() {
                    reload();
                }
            };
            if (hasPrev && hasNext) {
                strip.addAction(iconAction(R.drawable.ic_prev, new Runnable() {
                    @Override
                    public void run() {
                        if (page > 0) {
                            page -= 1;
                            invalidate();
                        }
                    }
                }));
                strip.addAction(iconAction(R.drawable.ic_next, new Runnable() {
                    @Override
                    public void run() {
                        if (page < pageCount() - 1) {
                            page += 1;
                            invalidate();
                        }
                    }
                }));
            } else if (hasPrev) {
                strip.addAction(iconAction(R.drawable.ic_prev, new Runnable() {
                    @Override
                    public void run() {
                        if (page > 0) {
                            page -= 1;
                            invalidate();
                        }
                    }
                }));
                strip.addAction(labeledAction("Refresh", R.drawable.ic_refresh, refresh));
            } else if (hasNext) {
                strip.addAction(iconAction(R.drawable.ic_next, new Runnable() {
                    @Override
                    public void run() {
                        if (page < pageCount() - 1) {
                            page += 1;
                            invalidate();
                        }
                    }
                }));
                strip.addAction(labeledAction("Refresh", R.drawable.ic_refresh, refresh));
            } else {
                strip.addAction(labeledAction("Refresh", R.drawable.ic_refresh, refresh));
            }
            return strip.build();
        }

        private String title() {
            if (loading || error != null) return "Stalls";
            int open = 0;
            for (ChargerFeed.Stall stall : stalls) {
                if ("open".equals(stall.availability)) open += 1;
            }
            String label = open + " open";
            int pages = pageCount();
            if (pages > 1) label = label + " · " + (page + 1) + "/" + pages;
            if (!live) label = label + " · saved";
            return label;
        }
    }

    /**
     * Stall facts. Pane rows cannot start navigation themselves; the pane action can,
     * which is the template that allows handing the garage address to the nav app.
     */
    static final class StallDetailScreen extends Screen {
        private final ChargerFeed.Stall stall;
        private final String directions;
        private final String durationTitle;
        private final String durationLabel;
        private String navError = null;

        StallDetailScreen(CarContext context, ChargerFeed.Stall stall, long openSeconds, String directions) {
            super(context);
            this.stall = stall;
            this.directions = directions;
            DurationText duration = durationText(stall, openSeconds);
            this.durationTitle = duration.title;
            this.durationLabel = duration.label;
        }

        private int paneLimit() {
            try {
                ConstraintManager limits =
                        (ConstraintManager) getCarContext().getCarService(ConstraintManager.class);
                int limit = limits.getContentLimit(ConstraintManager.CONTENT_LIMIT_TYPE_PANE);
                if (limit > 0) return limit;
            } catch (Exception ignored) {
                /* host has not published a limit yet */
            }
            return 4;
        }

        private void navigate() {
            String query = directions == null ? "" : directions.trim().replace(" ", "+");
            if (query.length() == 0) query = "12250+Crenshaw+Blvd,+Hawthorne,+CA";
            Intent intent = new Intent(CarContext.ACTION_NAVIGATE);
            intent.setData(Uri.parse("geo:0,0?q=" + query));
            try {
                getCarContext().startCarApp(intent);
            } catch (RuntimeException err) {
                navError = "Navigation isn't available in this car.";
                invalidate();
            }
        }

        @Override
        public Template onGetTemplate() {
            List<Row> rows = new ArrayList<Row>();
            Row.Builder where = new Row.Builder().setTitle(whereLabel(stall));
            if (stall.gateway != null && stall.gateway.length() > 0) where.addText(stall.gateway);
            rows.add(where.build());

            Row.Builder duration = new Row.Builder().setTitle(durationTitle).addText(durationLabel);
            if (navError != null) duration.addText(navError);
            rows.add(duration.build());

            rows.add(new Row.Builder()
                    .setTitle(stall.pluggedIn ? "Vehicle connected" : "Plug free")
                    .addText("Plug")
                    .build());

            Row.Builder power = new Row.Builder().setTitle(stall.power());
            power.addText(stall.volts > 0 ? stall.volts + " V" : "Power");
            rows.add(power.build());

            Pane.Builder pane = new Pane.Builder();
            int limit = Math.min(paneLimit(), rows.size());
            for (int i = 0; i < limit; i++) pane.addRow(rows.get(i));
            pane.addAction(new Action.Builder()
                    .setTitle("Navigate")
                    .setOnClickListener(new OnClickListener() {
                        @Override
                        public void onClick() {
                            navigate();
                        }
                    })
                    .build());

            return new PaneTemplate.Builder(pane.build())
                    .setTitle(stall.name + " · " + statusLabel(stall))
                    .setHeaderAction(Action.BACK)
                    .build();
        }
    }
}
