package com.bluelot.app;

import android.content.Intent;
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
import androidx.car.app.model.GridItem;
import androidx.car.app.model.GridTemplate;
import androidx.car.app.model.ItemList;
import androidx.car.app.model.OnClickListener;
import androidx.car.app.model.Template;
import androidx.car.app.validation.HostValidator;
import androidx.core.graphics.drawable.IconCompat;

import java.io.InputStream;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Android Auto charging panel: open stalls as glanceable cards. */
public class ChargerCarService extends CarAppService {
    @Override
    public HostValidator createHostValidator() {
        return HostValidator.ALLOW_ALL_HOSTS_VALIDATOR;
    }

    @Override
    public Session onCreateSession() {
        return new Session() {
            @Override
            public Screen onCreateScreen(Intent intent) {
                return new OpenStallsScreen(getCarContext());
            }
        };
    }

    static final class OpenStallsScreen extends Screen {
        private final ExecutorService executor = Executors.newSingleThreadExecutor();
        private final Handler main = new Handler(Looper.getMainLooper());
        private boolean loading = true;
        private boolean live = false;
        private String error = null;
        private int page = 0;
        private List<ChargerFeed.Stall> open = new java.util.ArrayList<ChargerFeed.Stall>();
        private CarIcon openIcon;

        OpenStallsScreen(CarContext context) {
            super(context);
            reload();
        }

        private void reload() {
            loading = true;
            error = null;
            invalidate();
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
                                loading = false;
                                error = "Couldn't reach the charger feed.";
                                invalidate();
                            }
                        });
                        return;
                    }
                    main.post(new Runnable() {
                        @Override
                        public void run() {
                            loading = false;
                            live = snapshot.live;
                            open = snapshot.openStalls();
                            int pages = pageCount();
                            if (page >= pages) page = pages - 1;
                            if (page < 0) page = 0;
                            invalidate();
                        }
                    });
                }
            });
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
                ConstraintManager limits = (ConstraintManager) getCarContext().getCarService(ConstraintManager.class);
                int limit = limits.getContentLimit(ConstraintManager.CONTENT_LIMIT_TYPE_GRID);
                if (limit > 0) return limit;
            } catch (Exception ignored) {
                /* host has not published a limit yet */
            }
            return 6;
        }

        private int pageCount() {
            int size = pageSize();
            if (open.isEmpty()) return 1;
            return (open.size() + size - 1) / size;
        }

        private CarIcon openIcon() {
            if (openIcon == null) {
                openIcon = new CarIcon.Builder(IconCompat.createWithResource(getCarContext(), R.drawable.ic_open)).build();
            }
            return openIcon;
        }

        private Action stripAction(String title, int icon, final Runnable action) {
            return new Action.Builder()
                    .setTitle(title)
                    .setIcon(new CarIcon.Builder(IconCompat.createWithResource(getCarContext(), icon)).build())
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
            GridTemplate.Builder template = new GridTemplate.Builder()
                    .setTitle(title())
                    .setHeaderAction(Action.APP_ICON)
                    .setItemSize(GridTemplate.ITEM_SIZE_LARGE)
                    .setActionStrip(strip());
            if (loading) return template.setLoading(true).build();

            ItemList.Builder list = new ItemList.Builder();
            if (error != null) {
                list.setNoItemsMessage(error);
            } else if (open.isEmpty()) {
                list.setNoItemsMessage("Nothing open right now");
            } else {
                int size = pageSize();
                int start = page * size;
                int end = Math.min(open.size(), start + size);
                for (int i = start; i < end; i++) {
                    ChargerFeed.Stall stall = open.get(i);
                    String bank = stall.bank == null || stall.bank.length() == 0 ? "J1772" : "Bank " + stall.bank;
                    String floor = stall.floor == 0 ? "Unassigned" : "Floor " + stall.floor;
                    list.addItem(new GridItem.Builder()
                            .setTitle(stall.name)
                            .setText(floor + " · " + bank)
                            .setImage(openIcon(), GridItem.IMAGE_TYPE_ICON)
                            .build());
                }
            }
            return template.setSingleList(list.build()).build();
        }

        private ActionStrip strip() {
            ActionStrip.Builder strip = new ActionStrip.Builder();
            int pages = pageCount();
            boolean hasPrev = !loading && pages > 1 && page > 0;
            boolean hasNext = !loading && pages > 1 && page < pages - 1;
            if (hasPrev) {
                strip.addAction(stripAction("Previous", R.drawable.ic_prev, new Runnable() {
                    @Override
                    public void run() {
                        if (page > 0) {
                            page -= 1;
                            invalidate();
                        }
                    }
                }));
            }
            if (hasNext) {
                strip.addAction(stripAction("Next", R.drawable.ic_next, new Runnable() {
                    @Override
                    public void run() {
                        if (page < pageCount() - 1) {
                            page += 1;
                            invalidate();
                        }
                    }
                }));
            }
            if (!hasPrev || !hasNext) {
                strip.addAction(stripAction("Refresh", R.drawable.ic_refresh, new Runnable() {
                    @Override
                    public void run() {
                        reload();
                    }
                }));
            }
            return strip.build();
        }

        private String title() {
            if (loading || error != null) return "Open stalls";
            if (open.isEmpty()) return live ? "0 open" : "0 open · saved";
            int pages = pageCount();
            String label = open.size() + " open";
            if (pages > 1) label = label + " · " + (page + 1) + "/" + pages;
            if (!live) label = label + " · saved";
            return label;
        }
    }
}
