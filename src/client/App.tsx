import { useCallback, useState } from "react";
import type { Itinerary, Pin, TripBrief } from "../shared/types.js";
import { newTripBrief } from "./state/trip.js";
import TripSetup from "./screens/TripSetup.js";
import Interview from "./screens/Interview.js";
import ItineraryScreen from "./screens/ItineraryScreen.js";
import ExportScreen from "./screens/ExportScreen.js";

export type Screen = "setup" | "interview" | "itinerary" | "export";

export default function App() {
  const [screen, setScreen] = useState<Screen>("setup");
  const [brief, setBrief] = useState<TripBrief>(newTripBrief);
  const [itinerary, setItinerary] = useState<Itinerary | null>(null);
  const [pins, setPins] = useState<Pin[]>([]);

  const restart = useCallback(() => {
    setBrief(newTripBrief());
    setItinerary(null);
    setPins([]);
    setScreen("setup");
  }, []);

  return (
    <div className="shell">
      <header className="masthead no-print">
        <button className="masthead__mark" onClick={restart} title="Start a new trip">
          Wayfind
        </button>
        <span className="masthead__trip">
          {brief.name.trim() || (brief.cities.length > 0 ? "Untitled trip" : "No trip yet")}
        </span>
      </header>

      {screen === "setup" && (
        <TripSetup brief={brief} onChange={setBrief} onNext={() => setScreen("interview")} />
      )}

      {screen === "interview" && (
        <Interview
          brief={brief}
          onChange={setBrief}
          onBack={() => setScreen("setup")}
          onDone={() => setScreen("itinerary")}
        />
      )}

      {screen === "itinerary" && (
        <ItineraryScreen
          brief={brief}
          onChangeBrief={setBrief}
          itinerary={itinerary}
          onItinerary={setItinerary}
          pins={pins}
          onPins={setPins}
          onEditTrip={() => setScreen("setup")}
          onEditPreferences={() => setScreen("interview")}
          onExport={() => setScreen("export")}
        />
      )}

      {screen === "export" && (
        <ExportScreen
          brief={brief}
          itinerary={itinerary}
          onBack={() => setScreen("itinerary")}
        />
      )}
    </div>
  );
}
