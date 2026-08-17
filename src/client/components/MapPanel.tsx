import { useEffect, useRef } from "react";
import L from "leaflet";
import type { Poi } from "../../shared/types.js";

/**
 * §9c — the map is support, not the product. It syncs with the rail: hovering a
 * stop highlights its pin, clicking a pin scrolls the rail to that stop. §9h
 * limits motion to exactly this sync and nothing else.
 */

export type MapStop = { poi: Poi; label: string };

type Props = {
  stops: MapStop[];
  hoveredPoiId: string | null;
  onHover: (poiId: string | null) => void;
  onSelect: (poiId: string) => void;
  basecamp: { lat: number; lng: number } | null;
};

export default function MapPanel({ stops, hoveredPoiId, onHover, onSelect, basecamp }: Props) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const markers = useRef<Map<string, L.Marker>>(new Map());
  const route = useRef<L.Polyline | null>(null);

  const reducedMotion =
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    if (!container.current || map.current) return;
    map.current = L.map(container.current, {
      zoomControl: true,
      attributionControl: true,
      scrollWheelZoom: false, // a map that eats the page scroll is hostile
    });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap contributors",
    }).addTo(map.current);
    return () => {
      map.current?.remove();
      map.current = null;
    };
  }, []);

  // Redraw markers and the day's route whenever the day changes.
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;

    for (const marker of markers.current.values()) marker.remove();
    markers.current.clear();
    route.current?.remove();
    route.current = null;

    if (stops.length === 0) return;

    const points: L.LatLngExpression[] = [];
    if (basecamp) {
      L.marker([basecamp.lat, basecamp.lng], {
        icon: L.divIcon({
          className: "map-pin map-pin--base",
          html: `<span aria-hidden="true">⌂</span>`,
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        }),
        keyboard: false,
      })
        .addTo(instance)
        .bindTooltip("Where you're staying");
      points.push([basecamp.lat, basecamp.lng]);
    }

    for (const { poi, label } of stops) {
      const marker = L.marker([poi.lat, poi.lng], {
        icon: L.divIcon({
          className: "map-pin",
          html: `<span>${label}</span>`,
          iconSize: [26, 26],
          iconAnchor: [13, 13],
        }),
        title: poi.name,
      })
        .addTo(instance)
        .bindTooltip(poi.name);

      marker.on("mouseover", () => onHover(poi.id));
      marker.on("mouseout", () => onHover(null));
      marker.on("click", () => onSelect(poi.id));
      markers.current.set(poi.id, marker);
      points.push([poi.lat, poi.lng]);
    }

    route.current = L.polyline(
      stops.map((s) => [s.poi.lat, s.poi.lng] as L.LatLngExpression),
      { className: "map-route", weight: 2, opacity: 0.75 },
    ).addTo(instance);

    instance.fitBounds(L.latLngBounds(points).pad(0.18), { animate: false });
  }, [stops, basecamp, onHover, onSelect]);

  // The sync itself: a hovered rail block lifts its pin.
  useEffect(() => {
    for (const [id, marker] of markers.current) {
      const element = marker.getElement();
      if (!element) continue;
      element.classList.toggle("map-pin--active", id === hoveredPoiId);
    }
    if (hoveredPoiId && map.current) {
      const marker = markers.current.get(hoveredPoiId);
      if (marker && !map.current.getBounds().contains(marker.getLatLng())) {
        map.current.panTo(marker.getLatLng(), { animate: !reducedMotion });
      }
    }
  }, [hoveredPoiId, stops, reducedMotion]);

  return (
    <div className="map-panel no-print">
      <div ref={container} className="map-panel__canvas" role="application" aria-label="Map of the day's route" />
    </div>
  );
}
