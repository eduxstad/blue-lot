import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { usePageSwipe } from "./use-page-swipe";
import {
  BatteryCharging,
  Clock,
  MapPin,
  Plug,
  RefreshCw,
  Search,
  Star,
  Unplug,
  X,
} from "lucide-react";
import {
  formatAgo,
  formatDuration,
  formatLocal,
  formatUtc,
  getChargers,
  kwLabel,
  LONG_SESSION_SECONDS,
  newlyOpenStalls,
  openForSeconds,
  statusLabel,
  trackOpenSince,
  type Availability,
  type ChargerResult,
  type Stall,
} from "@/lib/chargers";

type Filter = "open" | "busy" | "offline" | "all" | "pinned";

const FILTERS: { id: Filter; label: string; icon: typeof Plug }[] = [
  { id: "open", label: "Open", icon: Plug },
  { id: "busy", label: "In use", icon: BatteryCharging },
  { id: "offline", label: "Offline", icon: Unplug },
  { id: "pinned", label: "Saved", icon: Star },
];

/** Mobile page order. Matches the bottom navigation, not the desktop "All" chip. */
const SWIPE_PAGES: readonly Filter[] = FILTERS.map((item) => item.id);

const PIN_KEY = "bluelot-pins";
const OPEN_KEY = "bluelot-open-since";
const NOTIFY_KEY = "bluelot-notify";
const IGNORED_KEY = "bluelot-notify-ignored";

type NativeAlerts = {
  notificationsEnabled?: () => boolean;
  setNotifications?: (on: boolean) => boolean;
};

function nativeAlerts(): NativeAlerts | null {
  if (typeof window === "undefined") return null;
  const native = (window as unknown as { BlueLotNative?: NativeAlerts }).BlueLotNative;
  return native ?? null;
}

function mapsHref(address: string, city: string, state: string, zip: string) {
  const query = [address, city, state, zip].filter(Boolean).join(", ");
  return `https://maps.google.com/?q=${encodeURIComponent(query || "12250 Crenshaw Blvd, Hawthorne, CA")}`;
}

export function BlueLot({ initial }: { initial: ChargerResult }) {
  const fetchChargers = useServerFn(getChargers);
  const [result, setResult] = useState(initial);
  const [pending, setPending] = useState(false);
  const [filter, setFilter] = useState<Filter>("open");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [pageMotion, setPageMotion] = useState<"next" | "prev" | null>(null);
  const [motionNonce, setMotionNonce] = useState(0);
  const { shellRef, boardRef } = usePageSwipe({
    pages: SWIPE_PAGES,
    page: filter,
    enabled: selected == null && query.trim() === "",
    onPage: (next, direction) => {
      setPageMotion(direction);
      setMotionNonce((nonce) => nonce + 1);
      setFilter(next);
    },
  });
  const [now, setNow] = useState<number | null>(null);
  const [pins, setPins] = useState<string[]>([]);
  const [pinsReady, setPinsReady] = useState(false);
  const [openSince, setOpenSince] = useState<Record<string, number>>({});
  const [notify, setNotify] = useState(false);
  const [ignored, setIgnored] = useState<string[]>([]);
  const seenAvailability = useRef<Record<string, string> | null>(null);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    setNow(Date.now());
    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(PIN_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) setPins(parsed.filter((item) => typeof item === "string"));
      }
    } catch {
      /* ignore broken local pins */
    }
    setPinsReady(true);
  }, []);

  useEffect(() => {
    if (!pinsReady) return;
    localStorage.setItem(PIN_KEY, JSON.stringify(pins));
  }, [pins, pinsReady]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      void refresh();
    }, 30_000);
    return () => window.clearInterval(id);
  }, []);

  async function refresh(manual = false) {
    if (manual) setPending(true);
    try {
      const next = await fetchChargers();
      setResult((current) => {
        if (!next.ok) return current.ok ? current : next;
        if (current.ok && current.snapshot.live && !next.snapshot.live) return current;
        return next;
      });
    } catch {
      setResult((current) =>
        current.ok ? current : { ok: false, error: "Couldn't refresh the charger feed." },
      );
    } finally {
      if (manual) setPending(false);
    }
  }

  useEffect(() => {
    const native = nativeAlerts();
    if (native?.notificationsEnabled) {
      setNotify(native.notificationsEnabled());
      return;
    }
    try {
      setNotify(localStorage.getItem(NOTIFY_KEY) === "1");
      const raw = localStorage.getItem(IGNORED_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) setIgnored(parsed.filter((item) => typeof item === "string"));
      }
    } catch {
      setNotify(false);
    }
  }, []);

  const snapshot = result.ok ? result.snapshot : null;

  useEffect(() => {
    if (!snapshot) return;
    const prior = seenAvailability.current;
    const current: Record<string, string> = {};
    for (const stall of snapshot.stalls) current[stall.name] = stall.availability;
    seenAvailability.current = current;
    if (!notify || !snapshot.live || !prior) return;
    if (nativeAlerts()) return;
    const opened = newlyOpenStalls(prior, snapshot.stalls, ignored);
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    for (const name of opened) {
      const stall = snapshot.stalls.find((item) => item.name === name);
      const where = stall ? (stall.floor === 0 ? "Unassigned" : `Floor ${stall.floor}`) : "";
      const bank = stall?.bank ? ` · Bank ${stall.bank}` : "";
      const note = new Notification(`Stall ${name} is open`, { body: `${where}${bank}` });
      note.onclick = () => setSelected(name);
    }
  }, [snapshot, notify, ignored]);
  const stalls = snapshot?.stalls ?? [];

  useEffect(() => {
    if (!snapshot) return;
    let previous: Record<string, number> = {};
    try {
      const raw = localStorage.getItem(OPEN_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object") {
          for (const [name, value] of Object.entries(parsed)) {
            if (typeof value === "number" && Number.isFinite(value)) previous[name] = value;
          }
        }
      }
    } catch {
      previous = {};
    }
    const next = trackOpenSince(snapshot.stalls, previous, Date.now());
    localStorage.setItem(OPEN_KEY, JSON.stringify(next));
    setOpenSince(next);
  }, [snapshot]);
  const counts = useMemo(() => {
    return {
      open: stalls.filter((stall) => stall.availability === "open").length,
      busy: stalls.filter((stall) => stall.availability === "busy").length,
      offline: stalls.filter((stall) => stall.availability === "offline").length,
      all: stalls.length,
    };
  }, [stalls]);

  const pinSet = useMemo(() => new Set(pins), [pins]);

  const visible = useMemo(() => {
    const needle = query.trim();
    return stalls.filter((stall) => {
      if (needle && !stall.name.includes(needle)) return false;
      if (needle) return true;
      if (filter === "pinned") return pinSet.has(stall.name);
      if (filter === "all") return true;
      return stall.availability === filter;
    });
  }, [stalls, query, filter, pinSet]);

  const floors = useMemo(() => {
    const groups = new Map<number, Stall[]>();
    for (const stall of visible) {
      const list = groups.get(stall.floor) ?? [];
      list.push(stall);
      groups.set(stall.floor, list);
    }
    return [...groups.entries()].sort((a, b) => a[0] - b[0]);
  }, [visible]);

  const active = stalls.find((stall) => stall.name === selected) ?? null;
  const updated =
    snapshot && now != null
      ? formatAgo(snapshot.fetchedAt, now)
      : snapshot
        ? formatUtc(snapshot.fetchedAt)
        : "";

  function selectFilter(next: Filter) {
    setPageMotion(null);
    setFilter(next);
  }

  function togglePin(name: string) {
    setPins((current) =>
      current.includes(name) ? current.filter((item) => item !== name) : [...current, name],
    );
  }

  async function setNotifyEnabled(on: boolean) {
    const native = nativeAlerts();
    if (native?.setNotifications) {
      setNotify(native.setNotifications(on));
      return;
    }
    if (!on) {
      localStorage.setItem(NOTIFY_KEY, "0");
      setNotify(false);
      return;
    }
    if (typeof Notification === "undefined") {
      setNotify(false);
      return;
    }
    const permission = await Notification.requestPermission();
    const granted = permission === "granted";
    localStorage.setItem(NOTIFY_KEY, granted ? "1" : "0");
    setNotify(granted);
  }

  return (
    <div
      ref={shellRef}
      className="page-swipe min-h-dvh touch-pan-y overflow-x-clip overscroll-x-none bg-bg text-fg"
    >
      <div className="mx-auto grid max-w-6xl gap-6 px-4 pt-5 pb-28 md:grid-cols-[17rem_1fr] md:px-8 md:pt-8 md:pb-10">
        <aside className="flex flex-col gap-5 md:sticky md:top-6 md:self-start">
          <header className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">Open stalls</h1>
              <p className="mt-1 text-sm text-muted">
                {snapshot
                  ? `${snapshot.city || "Hawthorne"} J1772 · ${snapshot.site}`
                  : "Hawthorne garage"}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <a
                href="mailto:bluelotfeedback@mail.grokbot.com?subject=Blue%20Lot%20feedback"
                className="inline-flex h-11 items-center justify-center rounded-full border border-line bg-transparent px-3 text-sm font-medium"
              >
                Feedback
              </a>
              <button
                type="button"
                onClick={() => void refresh(true)}
                disabled={pending}
                className="inline-flex size-11 items-center justify-center rounded-full border border-line bg-transparent text-fg disabled:opacity-60"
                aria-label="Refresh chargers"
              >
                <RefreshCw
                  className={pending ? "size-5 animate-spin motion-reduce:animate-none" : "size-5"}
                />
              </button>
            </div>
          </header>

          <div className="hidden flex-wrap gap-2 md:flex">
            <FilterButton
              active={filter === "all"}
              label="All"
              count={counts.all}
              onClick={() => selectFilter("all")}
            />
            {FILTERS.map((item) => (
              <FilterButton
                key={item.id}
                active={filter === item.id}
                label={item.label}
                count={item.id === "pinned" ? pins.length : counts[item.id]}
                tone={item.id === "busy" ? "busy" : "open"}
                onClick={() => selectFilter(item.id)}
              />
            ))}
          </div>

          <section className="rounded-3xl border border-line bg-surface p-5">
            <p className="font-mono text-6xl font-medium leading-none tracking-tight text-open">
              {result.ok ? counts.open : "–"}
            </p>
            <p className="mt-2 text-sm text-muted">
              {result.ok ? (
                <>
                  open of {counts.all} stalls ·{" "}
                  <span className="text-busy">{counts.busy} in use</span>
                  {" · "}
                  {counts.offline} offline
                </>
              ) : (
                "waiting on the feed"
              )}
            </p>
            <p className="mt-3 text-xs text-muted">
              {snapshot?.live ? `Updated ${updated || "—"}` : `Saved reading · ${updated || "—"}`}
            </p>
            {snapshot && !snapshot.live ? (
              <p className="mt-2 text-sm text-fg">
                Live feed didn't answer. This is the last full reading, not the current second.
              </p>
            ) : null}
            {snapshot ? (
              <a
                className="mt-4 inline-flex items-center gap-2 text-sm text-fg underline-offset-4 hover:underline"
                href={mapsHref(snapshot.address, snapshot.city, snapshot.state, snapshot.zip)}
                target="_blank"
                rel="noreferrer"
              >
                <MapPin className="size-4 text-open" />
                {[snapshot.address, snapshot.city].filter(Boolean).join(", ") || "Hawthorne"}
              </a>
            ) : null}
            <label
              className="mt-4 flex items-center justify-between gap-3 text-sm"
              data-swipe-ignore
            >
              <span>Notify when a stall opens</span>
              <span className="relative inline-flex h-[26px] w-11 shrink-0">
                <input
                  type="checkbox"
                  role="switch"
                  aria-checked={notify}
                  className="peer absolute inset-0 z-10 m-0 cursor-pointer opacity-0"
                  checked={notify}
                  onChange={(event) => {
                    void setNotifyEnabled(event.target.checked);
                  }}
                />
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 rounded-full bg-line transition-colors peer-checked:bg-open"
                />
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute top-[3px] left-[3px] size-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-[18px]"
                />
              </span>
            </label>
          </section>

          <label
            className="flex items-center gap-2 rounded-2xl border border-line bg-surface px-3"
            data-swipe-ignore
          >
            <Search className="size-4 text-muted" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value.replace(/[^\d]/g, ""))}
              inputMode="numeric"
              placeholder="Stall number"
              aria-label="Search stall number"
              className="h-12 w-full bg-transparent font-mono text-base text-fg outline-none placeholder:text-muted"
            />
          </label>
        </aside>

        <main className="min-w-0 overflow-x-clip">
          <div
            key={motionNonce}
            ref={boardRef}
            className={
              pageMotion === "next"
                ? "page-enter-next"
                : pageMotion === "prev"
                  ? "page-enter-prev"
                  : undefined
            }
          >
            {!result.ok ? (
              <div className="rounded-3xl border border-line bg-surface p-6">
                <h2 className="text-lg font-medium">Feed unavailable</h2>
                <p className="mt-2 text-sm text-muted">{result.error}</p>
                <button
                  type="button"
                  onClick={() => void refresh(true)}
                  className="mt-4 inline-flex h-11 items-center rounded-full bg-open px-4 text-sm font-medium text-open-ink"
                >
                  Try again
                </button>
              </div>
            ) : floors.length === 0 ? (
              <div className="rounded-3xl border border-dashed border-line bg-surface p-6">
                <h2 className="text-lg font-medium">
                  {filter === "open" ? "Nothing open right now" : "No stalls match"}
                </h2>
                <p className="mt-2 text-sm text-muted">
                  {filter === "pinned"
                    ? "Star a stall to keep it here."
                    : query
                      ? `No stall numbered ${query}.`
                      : "Try another filter, or check back after the next refresh."}
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-8">
                {floors.map(([floor, group]) => (
                  <section key={floor} aria-labelledby={`floor-${floor}`}>
                    <div className="mb-3 flex items-baseline justify-between gap-3">
                      <h2 id={`floor-${floor}`} className="text-lg font-medium">
                        {floor === 0 ? "Unassigned" : `Floor ${floor}`}
                      </h2>
                      <p className="text-sm text-muted">{group.length} shown</p>
                    </div>
                    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                      {group.map((stall) => (
                        <li key={stall.name}>
                          <StallCard
                            stall={stall}
                            pinned={pinSet.has(stall.name)}
                            openSeconds={
                              now == null ? null : openForSeconds(openSince[stall.name], now)
                            }
                            onOpen={() => setSelected(stall.name)}
                          />
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}

            <p className="mt-8 text-xs text-muted">
              Same live feed as the{" "}
              <a
                className="underline-offset-4 hover:underline"
                href="https://spxchargers.streamlit.app/"
                target="_blank"
                rel="noreferrer"
              >
                Blue Lot dashboard
              </a>
              . Refreshes every 30 seconds. Free Level 2, up to 6.6 kW.
            </p>
          </div>
        </main>
      </div>

      <nav
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/95 px-2 backdrop-blur dock md:hidden"
        aria-label="Stall filters"
      >
        <div className="mx-auto grid max-w-lg grid-cols-4">
          {FILTERS.map((item) => {
            const Icon = item.icon;
            const active = filter === item.id;
            const count = item.id === "pinned" ? pins.length : counts[item.id];
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={active}
                onClick={() => selectFilter(item.id)}
                className={
                  active
                    ? item.id === "busy"
                      ? "flex h-16 flex-col items-center justify-center gap-1 text-busy"
                      : "flex h-16 flex-col items-center justify-center gap-1 text-open"
                    : "flex h-16 flex-col items-center justify-center gap-1 text-muted"
                }
              >
                <Icon className="size-5" />
                <span className="text-xs">
                  {item.label}
                  <span className="font-mono"> {count}</span>
                </span>
              </button>
            );
          })}
        </div>
      </nav>

      {active && snapshot ? (
        <StallSheet
          stall={active}
          now={now}
          openSeconds={now == null ? null : openForSeconds(openSince[active.name], now)}
          pinned={pinSet.has(active.name)}
          maps={mapsHref(snapshot.address, snapshot.city, snapshot.state, snapshot.zip)}
          onClose={() => setSelected(null)}
          onPin={() => togglePin(active.name)}
        />
      ) : null}
    </div>
  );
}

function FilterButton({
  active,
  label,
  count,
  tone = "open",
  onClick,
}: {
  active: boolean;
  label: string;
  count: number;
  tone?: "open" | "busy";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={
        active
          ? tone === "busy"
            ? "inline-flex h-10 items-center gap-2 rounded-full bg-busy px-3 text-sm font-medium text-busy-ink"
            : "inline-flex h-10 items-center gap-2 rounded-full bg-open px-3 text-sm font-medium text-open-ink"
          : "inline-flex h-10 items-center gap-2 rounded-full border border-line bg-surface px-3 text-sm text-fg"
      }
    >
      {label}
      <span className="font-mono">{count}</span>
    </button>
  );
}

function StallCard({
  stall,
  pinned,
  openSeconds,
  onOpen,
}: {
  stall: Stall;
  pinned: boolean;
  openSeconds: number | null;
  onOpen: () => void;
}) {
  const open = stall.availability === "open";
  const long =
    stall.availability === "busy" &&
    stall.sessionSeconds != null &&
    stall.sessionSeconds > LONG_SESSION_SECONDS;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={
        open
          ? "flex min-h-28 w-full flex-col rounded-2xl border border-open/40 bg-open/10 p-3 text-left"
          : stall.availability === "offline"
            ? "flex min-h-28 w-full flex-col rounded-2xl border border-dashed border-line bg-surface p-3 text-left"
            : "flex min-h-28 w-full flex-col rounded-2xl border border-busy/45 bg-busy/10 p-3 text-left"
      }
    >
      <span className="flex items-start justify-between gap-2">
        <span className="font-mono text-2xl font-medium tracking-tight">{stall.name}</span>
        {pinned ? <Star className="size-4 fill-open text-open" aria-label="Saved" /> : null}
      </span>
      {open && openSeconds != null ? (
        <span className="mt-2 inline-flex max-w-full items-center gap-1 self-start rounded-full bg-open px-2 py-0.5 text-xs font-medium text-open-ink">
          <Clock className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{openSeconds < 60 ? "<1m" : sessionBadge(openSeconds)}</span>
        </span>
      ) : null}
      {long && stall.sessionSeconds != null ? (
        <span className="mt-2 inline-flex max-w-full items-center gap-1 self-start rounded-full bg-busy px-2 py-0.5 text-xs font-medium text-busy-ink">
          <Clock className="size-3 shrink-0" aria-hidden="true" />
          <span className="truncate">{sessionBadge(stall.sessionSeconds)}</span>
        </span>
      ) : null}
      <span className="mt-auto flex items-center justify-between gap-2 pt-3">
        <span className="text-xs text-muted">{stall.bank ? `Bank ${stall.bank}` : "J1772"}</span>
        <StatusPill availability={stall.availability} />
      </span>
    </button>
  );
}

function sessionBadge(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  if (days > 0) {
    const hours = Math.floor((total % 86400) / 3600);
    return `${days}d ${hours}h`;
  }
  return formatDuration(seconds);
}

function StatusPill({ availability }: { availability: Availability }) {
  const label = statusLabel(availability);
  if (availability === "open") {
    return (
      <span className="rounded-full bg-open px-2 py-0.5 text-xs font-medium text-open-ink">
        {label}
      </span>
    );
  }
  if (availability === "busy") {
    return (
      <span className="rounded-full bg-busy px-2 py-0.5 text-xs font-medium text-busy-ink">
        {label}
      </span>
    );
  }
  return <span className="rounded-full bg-raised px-2 py-0.5 text-xs text-muted">{label}</span>;
}

function StallSheet({
  stall,
  now,
  openSeconds,
  pinned,
  maps,
  onClose,
  onPin,
}: {
  stall: Stall;
  now: number | null;
  openSeconds: number | null;
  pinned: boolean;
  maps: string;
  onClose: () => void;
  onPin: () => void;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center md:items-center"
      data-swipe-ignore
    >
      <button
        type="button"
        aria-label="Close stall details"
        className="absolute inset-0 bg-bg/70"
        onClick={onClose}
      />
      <article
        role="dialog"
        aria-modal="true"
        aria-labelledby="stall-title"
        className="relative z-10 w-full max-w-md rounded-t-3xl border border-line bg-surface p-5 sheet-pad md:rounded-3xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm text-muted">
              {stall.floor === 0 ? "Unassigned" : `Floor ${stall.floor}`}
              {stall.bank ? ` · Bank ${stall.bank}` : ""}
            </p>
            <h2 id="stall-title" className="font-mono text-4xl font-medium tracking-tight">
              {stall.name}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex size-11 items-center justify-center rounded-full border border-line"
            aria-label="Close"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <StatusPill availability={stall.availability} />
          {stall.availability === "busy" &&
          stall.sessionSeconds != null &&
          stall.sessionSeconds > LONG_SESSION_SECONDS ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-busy px-2 py-0.5 text-xs font-medium text-busy-ink">
              <Clock className="size-3" aria-hidden="true" />
              {formatDuration(stall.sessionSeconds)}
            </span>
          ) : null}
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
          <Detail term="Plug" value={stall.pluggedIn ? "Vehicle connected" : "Plug free"} />
          <Detail term="Power" value={`${stall.amps || "—"} A · ${kwLabel(stall)}`} />
          <Detail term="Voltage" value={stall.volts ? `${stall.volts} V` : "—"} />
          <Detail
            term={stall.availability === "open" ? "Open for" : "Session"}
            value={
              stall.availability === "open"
                ? openSeconds == null
                  ? "—"
                  : openSeconds < 60
                    ? "<1m"
                    : formatDuration(openSeconds)
                : stall.sessionSeconds != null
                  ? formatDuration(stall.sessionSeconds)
                  : "—"
            }
          />
          <Detail term="Row" value={stall.gateway} />
          <LastSeen seenAt={stall.seenAt} now={now} />
        </dl>

        <div className="mt-5 flex gap-2">
          <button
            type="button"
            onClick={onPin}
            className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-full border border-line text-sm font-medium"
          >
            <Star className={pinned ? "size-4 fill-open text-open" : "size-4"} />
            {pinned ? "Saved" : "Save stall"}
          </button>
          <a
            href={maps}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-12 flex-1 items-center justify-center gap-2 rounded-full bg-open text-sm font-medium text-open-ink"
          >
            <MapPin className="size-4" />
            Directions
          </a>
        </div>
      </article>
    </div>
  );
}

function LastSeen({ seenAt, now }: { seenAt: number | null; now: number | null }) {
  const [absolute, setAbsolute] = useState(false);

  useEffect(() => {
    setAbsolute(false);
  }, [seenAt]);

  if (seenAt == null) {
    return (
      <div className="col-span-2 rounded-2xl bg-raised px-3 py-3">
        <div className="text-xs text-muted">Last seen</div>
        <div className="mt-1 text-sm">No recent telemetry</div>
      </div>
    );
  }

  const iso = new Date(seenAt * 1000).toISOString();
  const relative = now != null ? formatAgo(iso, now) : "—";
  const local = formatLocal(iso);

  return (
    <button
      type="button"
      onClick={() => setAbsolute((value) => !value)}
      aria-pressed={absolute}
      className="col-span-2 rounded-2xl bg-raised px-3 py-3 text-left"
    >
      <span className="text-xs text-muted">Last seen</span>
      <span className="mt-1 block text-sm">{absolute ? local : relative}</span>
    </button>
  );
}

function Detail({ term, value }: { term: string; value: string }) {
  return (
    <div className="rounded-2xl bg-raised px-3 py-3">
      <dt className="text-xs text-muted">{term}</dt>
      <dd className="mt-1 text-sm">{value}</dd>
    </div>
  );
}
