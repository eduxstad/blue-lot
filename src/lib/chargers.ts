import { createIsomorphicFn, createServerFn } from "@tanstack/react-start";

import fallbackSnapshot from "@/lib/fallback-snapshot.json";

const SITE_URL = "https://chargers.kitu.io/api/site/8";

const FALLBACK_FLOOR: Record<number, number> = {
  8: 1,
  9: 2,
  10: 2,
  11: 3,
  12: 3,
  13: 5,
  14: 5,
  15: 6,
  16: 6,
};

export type Availability = "open" | "busy" | "offline";

export type Stall = {
  name: string;
  floor: number;
  bank: string;
  gateway: string;
  availability: Availability;
  pluggedIn: boolean;
  amps: number;
  volts: number;
  sessionSeconds: number | null;
  seenAt: number | null;
  portId: string | null;
};

export type Snapshot = {
  site: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  fetchedAt: string;
  live: boolean;
  stalls: Stall[];
};

export type ChargerResult =
  | { ok: true; snapshot: Snapshot }
  | { ok: false; error: string };

type RawInfo = {
  status?: string;
  chargeStatus?: string;
  connection?: string;
  operating_voltage?: number;
  max_charge_current?: number;
  timestamp?: number;
  current_session_duration?: number;
};

type RawStation = {
  name?: string;
  gatewayId?: number;
  portId?: string | null;
  info?: RawInfo;
};

type RawGateway = {
  id?: number;
  name?: string;
};

type RawSite = {
  name?: string;
  address?: string;
  city?: string;
  state?: string;
  zipcode?: string;
  stations?: RawStation[];
  gateways?: RawGateway[];
};

function bankAndFloor(gatewayName: string, gatewayId: number) {
  const match = /KT-SX-(\d+)([A-Z])?/i.exec(gatewayName);
  if (match) {
    return {
      floor: Number(match[1]),
      bank: (match[2] ?? "").toUpperCase(),
    };
  }
  return { floor: FALLBACK_FLOOR[gatewayId] ?? 0, bank: "" };
}

function availabilityOf(info: RawInfo | undefined): Availability {
  if (!info || info.status !== "online") return "offline";
  if (info.chargeStatus === "charging") return "busy";
  return "open";
}

export function kwLabel(stall: Stall) {
  const kw = (stall.volts * stall.amps) / 1000;
  if (!Number.isFinite(kw) || kw <= 0) return "J1772";
  return `${kw.toFixed(1)} kW`;
}

export const LONG_SESSION_SECONDS = 16 * 60 * 60;

export function formatDuration(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) {
    const parts = [`${days}d`, `${hours}h`];
    if (minutes > 0) parts.push(`${minutes}m`);
    return parts.join(" ");
  }
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${total}s`;
}

export function formatUtc(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${months[date.getUTCMonth()]} ${date.getUTCDate()}, ${hh}:${mm} UTC`;
}

export function formatLocal(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

export function formatAgo(iso: string, now: number) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "unknown";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function trackOpenSince(
  stalls: { name: string; availability: Availability }[],
  previous: Record<string, number>,
  now: number,
) {
  const next: Record<string, number> = {};
  for (const stall of stalls) {
    if (stall.availability !== "open") continue;
    const prior = previous[stall.name];
    next[stall.name] = typeof prior === "number" && Number.isFinite(prior) ? prior : now;
  }
  return next;
}

export function openForSeconds(since: number | undefined, now: number) {
  if (typeof since !== "number" || !Number.isFinite(since)) return null;
  return Math.max(0, Math.round((now - since) / 1000));
}

export function newlyOpenStalls(
  previous: Record<string, string> | null,
  stalls: { name: string; availability: string }[],
  ignored: readonly string[],
) {
  if (!previous) return [];
  const skip = new Set(ignored);
  return stalls
    .filter((stall) => {
      if (stall.availability !== "open" || skip.has(stall.name)) return false;
      const prior = previous[stall.name];
      return typeof prior === "string" && prior.length > 0 && prior !== "open";
    })
    .map((stall) => stall.name);
}

export function statusLabel(availability: Availability) {
  if (availability === "open") return "Open";
  if (availability === "busy") return "In use";
  return "Offline";
}

function staleSnapshot(): Snapshot {
  return {
    site: fallbackSnapshot.site,
    address: fallbackSnapshot.address,
    city: fallbackSnapshot.city,
    state: fallbackSnapshot.state,
    zip: fallbackSnapshot.zip,
    fetchedAt: fallbackSnapshot.fetchedAt,
    live: false,
    stalls: fallbackSnapshot.stalls as Stall[],
  };
}

export async function loadChargers(timeoutMs = 7000): Promise<ChargerResult> {
  try {
    const response = await fetch(SITE_URL, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: true, snapshot: staleSnapshot() };
    const data = (await response.json()) as RawSite;
    const gateways = new Map<number, string>();
    for (const gateway of data.gateways ?? []) {
      if (typeof gateway.id === "number" && gateway.name) gateways.set(gateway.id, gateway.name);
    }

    const stalls: Stall[] = (data.stations ?? [])
      .filter((station) => station.name)
      .map((station) => {
        const gatewayId = station.gatewayId ?? 0;
        const gateway = gateways.get(gatewayId) ?? `Gateway ${gatewayId}`;
        const place = bankAndFloor(gateway, gatewayId);
        const info = station.info;
        const availability = availabilityOf(info);
        const session = info?.current_session_duration;
        return {
          name: String(station.name),
          floor: place.floor,
          bank: place.bank,
          gateway,
          availability,
          pluggedIn: info?.connection === "connected",
          amps: info?.max_charge_current ?? 0,
          volts: info?.operating_voltage ?? 0,
          sessionSeconds:
            availability === "busy" && typeof session === "number" && session > 0 ? session : null,
          seenAt: typeof info?.timestamp === "number" ? info.timestamp : null,
          portId: station.portId ?? null,
        };
      })
      .sort((a, b) => a.floor - b.floor || Number(a.name) - Number(b.name) || a.name.localeCompare(b.name));

    return {
      ok: true,
      snapshot: {
        site: data.name?.trim() || "Blue Lot",
        address: (data.address ?? "").trim(),
        city: (data.city ?? "").trim(),
        state: (data.state ?? "").trim(),
        zip: (data.zipcode ?? "").trim(),
        fetchedAt: new Date().toISOString(),
        live: true,
        stalls,
      },
    };
  } catch {
    return { ok: true, snapshot: staleSnapshot() };
  }
}

export const getChargers = createServerFn({ method: "GET" }).handler(async () => loadChargers(7000));

export const loadRouteChargers = createIsomorphicFn()
  .server(() => loadChargers(1000))
  .client(() => getChargers());
