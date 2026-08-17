import type { Itinerary, Pin, TripBrief } from "../../shared/types.js";

type Props = {
  brief: TripBrief;
  onChangeBrief: (brief: TripBrief) => void;
  itinerary: Itinerary | null;
  onItinerary: (itinerary: Itinerary | null) => void;
  pins: Pin[];
  onPins: (pins: Pin[]) => void;
  onEditTrip: () => void;
  onEditPreferences: () => void;
  onExport: () => void;
};

// Built in §0d stage 6. Placeholder so stages 1-5 compile and run.
export default function ItineraryScreen(_props: Props) {
  return (
    <main className="page">
      <h1 className="page__title">Itinerary</h1>
      <p className="page__lede">Not built yet — §0d stage 6.</p>
    </main>
  );
}
