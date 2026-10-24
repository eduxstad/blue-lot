import { createFileRoute } from "@tanstack/react-router";
import { BlueLot } from "@/components/blue-lot";
import { loadRouteChargers } from "@/lib/chargers";

export const Route = createFileRoute("/")({
  loader: () => loadRouteChargers(),
  component: Home,
});

function Home() {
  const initial = Route.useLoaderData();
  return <BlueLot initial={initial} />;
}
