package com.bluelot.app;

import android.media.MediaDescription;
import android.media.browse.MediaBrowser;
import android.media.session.MediaSession;
import android.os.Bundle;
import android.service.media.MediaBrowserService;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Sideloadable Android Auto surface. Google only allows media apps, not Car App
 * Library screens, to run from an APK that was not installed by the Play Store.
 */
public class ChargerMediaService extends MediaBrowserService {
    private static final String ROOT = "open";
    private static final int STYLE_GRID = 2;
    private static final String STYLE_PLAYABLE = "android.media.browse.CONTENT_STYLE_PLAYABLE_HINT";

    private MediaSession session;

    @Override
    public void onCreate() {
        super.onCreate();
        session = new MediaSession(this, "BlueLot");
        session.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlayFromMediaId(String mediaId, Bundle extras) {
                /* Rows are status, not audio. */
            }
        });
        session.setActive(true);
        setSessionToken(session.getSessionToken());
    }

    @Override
    public void onDestroy() {
        if (session != null) {
            session.setActive(false);
            session.release();
        }
        super.onDestroy();
    }

    @Override
    public BrowserRoot onGetRoot(String clientPackageName, int clientUid, Bundle rootHints) {
        Bundle extras = new Bundle();
        extras.putInt(STYLE_PLAYABLE, STYLE_GRID);
        return new BrowserRoot(ROOT, extras);
    }

    @Override
    public void onLoadChildren(final String parentId, final Result<List<MediaBrowser.MediaItem>> result) {
        result.detach();
        new Thread(new Runnable() {
            @Override
            public void run() {
                List<MediaBrowser.MediaItem> items = new ArrayList<MediaBrowser.MediaItem>();
                if (ROOT.equals(parentId)) {
                    ChargerFeed.Snapshot snapshot = ChargerFeed.load(readFallback());
                    for (ChargerFeed.Stall stall : snapshot.openStalls()) {
                        String bank = stall.bank == null || stall.bank.length() == 0 ? "J1772" : "Bank " + stall.bank;
                        String floor = stall.floor == 0 ? "Unassigned" : "Floor " + stall.floor;
                        Bundle extras = new Bundle();
                        extras.putInt(STYLE_PLAYABLE, STYLE_GRID);
                        MediaDescription desc = new MediaDescription.Builder()
                                .setMediaId(stall.name)
                                .setTitle(stall.name)
                                .setSubtitle(floor + " · " + bank)
                                .setExtras(extras)
                                .build();
                        items.add(new MediaBrowser.MediaItem(desc, MediaBrowser.MediaItem.FLAG_PLAYABLE));
                    }
                }
                result.sendResult(items);
            }
        }).start();
    }

    private String readFallback() {
        try {
            InputStream in = getAssets().open("fallback-snapshot.json");
            try {
                return ChargerFeed.readStream(in);
            } finally {
                in.close();
            }
        } catch (Exception err) {
            return null;
        }
    }
}
