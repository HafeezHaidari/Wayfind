import type { Itinerary, TripBrief } from "../../shared/types.js";

type Props = {
  brief: TripBrief;
  itinerary: Itinerary | null;
  onBack: () => void;
};

// Built in §0d stage 8. Placeholder so stages 1-7 compile and run.
export default function ExportScreen(_props: Props) {
  return (
    <main className="page">
      <h1 className="page__title">Export</h1>
      <p className="page__lede">Not built yet — §0d stage 8.</p>
    </main>
  );
}
