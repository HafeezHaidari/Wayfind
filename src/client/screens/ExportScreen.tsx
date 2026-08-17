import { useState } from "react";
import type { Itinerary, TripBrief } from "../../shared/types.js";
import { buildStaticPage } from "../export/staticPage.js";

/**
 * §2 step 6 and §14 — export as JSON or as a static shareable page, generated
 * client-side. Nothing is uploaded: §1 means the trip never leaves this tab
 * except by the traveller's own hand.
 */

type Props = {
  brief: TripBrief;
  itinerary: Itinerary | null;
  onBack: () => void;
};

export default function ExportScreen({ brief, itinerary, onBack }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (!itinerary) {
    return (
      <main className="page">
        <h1 className="page__title">Nothing to export yet</h1>
        <p className="page__lede">Build an itinerary first, then come back here to save it.</p>
        <button className="btn btn--primary" onClick={onBack}>
          Back to the itinerary
        </button>
      </main>
    );
  }

  const slug =
    (brief.name.trim() || itinerary.cities.map((c) => c.cityName).join("-"))
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "wayfind-trip";

  const exportJson = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      exportedBy: "Wayfind",
      brief,
      itinerary,
    };
    download(`${slug}.json`, JSON.stringify(payload, null, 2), "application/json");
    setDone("json");
  };

  const exportPage = async () => {
    setBusy("page");
    try {
      const html = await buildStaticPage(brief, itinerary);
      download(`${slug}.html`, html, "text/html");
      setDone("page");
    } finally {
      setBusy(null);
    }
  };

  const totalStops = itinerary.cities.reduce(
    (sum, c) => sum + c.days.reduce((s, d) => s + d.stops.length, 0),
    0,
  );

  return (
    <main className="page">
      <p className="eyebrow">Take it with you</p>
      <h1 className="page__title">Export</h1>
      <p className="page__lede">
        {totalStops} stops across{" "}
        {itinerary.cities.reduce((sum, c) => sum + c.days.length, 0)} days. Closing this tab loses
        the trip, so save it before you go.
      </p>

      <div className="stack">
        <section className="export-option">
          <div>
            <h2 className="export-option__title">A page you can read offline</h2>
            <p className="export-option__body">
              One HTML file with the fonts, the route drawings and every stop inside it. Open it on
              a phone in flight mode and it renders completely. Print it and you get one day per
              page.
            </p>
          </div>
          <button className="btn btn--primary" onClick={() => void exportPage()} disabled={busy !== null}>
            {busy === "page" ? "Building…" : "Save the page"}
          </button>
        </section>

        <section className="export-option">
          <div>
            <h2 className="export-option__title">JSON</h2>
            <p className="export-option__body">
              The trip, your preferences and the full itinerary, including which places were
              considered and why they didn't fit. For feeding into something else.
            </p>
          </div>
          <button className="btn" onClick={exportJson} disabled={busy !== null}>
            Save the data
          </button>
        </section>

        <section className="export-option">
          <div>
            <h2 className="export-option__title">Print</h2>
            <p className="export-option__body">
              Prints the day you're looking at, times set large and the interactive parts removed.
            </p>
          </div>
          <button className="btn" onClick={() => window.print()} disabled={busy !== null}>
            Print
          </button>
        </section>
      </div>

      {done && (
        <p className="muted" style={{ marginTop: "1.5rem" }} aria-live="polite">
          Saved to your downloads.
        </p>
      )}

      <div className="actions" style={{ marginTop: "2rem" }}>
        <button className="btn btn--quiet" onClick={onBack}>
          ← Back to the itinerary
        </button>
      </div>
    </main>
  );
}

function download(filename: string, contents: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: `${type};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser a moment to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
