import { useState } from "react";
import type { CityStay, TripBrief } from "../../shared/types.js";
import { blankCity, daysBetween, isReadyToGenerate } from "../state/trip.js";
import { geocode, type GeocodeResult, ApiError } from "../api.js";

type Props = {
  brief: TripBrief;
  onChange: (brief: TripBrief) => void;
  onNext: () => void;
};

export default function TripSetup({ brief, onChange, onNext }: Props) {
  const setCity = (index: number, next: CityStay) =>
    onChange({ ...brief, cities: brief.cities.map((c, i) => (i === index ? next : c)) });

  const removeCity = (index: number) =>
    onChange({ ...brief, cities: brief.cities.filter((_, i) => i !== index) });

  const addCity = () => onChange({ ...brief, cities: [...brief.cities, blankCity()] });

  return (
    <main className="page">
      <p className="eyebrow">Step one</p>
      <h1 className="page__title">Where are you going?</h1>
      <p className="page__lede">
        Add each city and how long you're there. Wayfind plans within cities — getting between them
        is yours to arrange.
      </p>

      <div className="stack">
        <div className="field">
          <label htmlFor="trip-name">Trip name</label>
          <input
            id="trip-name"
            className="input"
            value={brief.name}
            placeholder="Ten days in Portugal"
            onChange={(e) => onChange({ ...brief, name: e.target.value })}
          />
        </div>

        <hr className="rule" />

        {brief.cities.length === 0 ? (
          <div className="notice">
            <p className="notice__title">Add a city to start planning</p>
            <p className="notice__body">
              One city or several. Each gets its own days, and you can give the address you're
              staying at so days start near your bed.
            </p>
          </div>
        ) : (
          brief.cities.map((city, i) => (
            <CityCard
              key={i}
              index={i}
              city={city}
              onChange={(next) => setCity(i, next)}
              onRemove={() => removeCity(i)}
            />
          ))
        )}

        <div className="actions actions--split">
          <button className="btn" onClick={addCity}>
            + Add {brief.cities.length > 0 ? "another " : ""}city
          </button>
          <button className="btn btn--primary" disabled={!isReadyToGenerate(brief)} onClick={onNext}>
            Next: your preferences
          </button>
        </div>
      </div>
    </main>
  );
}

function CityCard({
  index,
  city,
  onChange,
  onRemove,
}: {
  index: number;
  city: CityStay;
  onChange: (city: CityStay) => void;
  onRemove: () => void;
}) {
  const [query, setQuery] = useState(city.cityName);
  const [results, setResults] = useState<GeocodeResult[] | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const [useDates, setUseDates] = useState(city.startDate !== null);
  const located = city.lat !== 0 || city.lng !== 0;

  async function lookup() {
    if (!query.trim()) return;
    setLooking(true);
    setLookupError(null);
    setResults(null);
    try {
      const found = await geocode(query.trim());
      if (found.length === 0) {
        setLookupError(`No place called "${query.trim()}" turned up. Try a different spelling.`);
      } else if (found.length === 1) {
        choose(found[0]);
      } else {
        setResults(found);
      }
    } catch (err) {
      setLookupError(
        err instanceof ApiError ? err.message : "The lookup failed. Try again in a moment.",
      );
    } finally {
      setLooking(false);
    }
  }

  function choose(result: GeocodeResult) {
    setQuery(result.cityName);
    setResults(null);
    onChange({
      ...city,
      cityName: result.cityName,
      lat: result.lat,
      lng: result.lng,
      countryCode: result.countryCode,
      englishName: result.englishName,
    });
  }

  return (
    <section className="city-card">
      <div className="city-card__index mono">{String(index + 1).padStart(2, "0")}</div>

      <div className="city-card__body stack--tight">
        <div className="field">
          <label htmlFor={`city-${index}`}>City</label>
          <div className="city-card__lookup">
            <input
              id={`city-${index}`}
              className="input"
              value={query}
              placeholder="Porto"
              onChange={(e) => {
                setQuery(e.target.value);
                onChange({ ...city, cityName: e.target.value, lat: 0, lng: 0 });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void lookup();
                }
              }}
            />
            <button className="btn" onClick={() => void lookup()} disabled={looking}>
              {looking ? "Looking…" : located ? "Located ✓" : "Find"}
            </button>
          </div>
          {located && (
            <p className="city-card__coords mono muted">
              {city.lat.toFixed(4)}, {city.lng.toFixed(4)}
            </p>
          )}
          {results && (
            <ul className="city-card__results">
              {results.map((r) => (
                <li key={`${r.lat},${r.lng}`}>
                  <button className="btn btn--quiet btn--small" onClick={() => choose(r)}>
                    {r.displayName}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {lookupError && (
            <p className="city-card__error">
              {lookupError} You can still plan this city by entering its coordinates below.
            </p>
          )}
        </div>

        <div className="city-card__when">
          <div className="choices">
            <button
              className="choice"
              aria-pressed={useDates}
              onClick={() => {
                setUseDates(true);
                if (!city.startDate) {
                  onChange({ ...city, startDate: new Date().toISOString().slice(0, 10) });
                }
              }}
            >
              <span className="choice__label">Dates</span>
              <span className="choice__note">Lets Wayfind respect weekday closures</span>
            </button>
            <button
              className="choice"
              aria-pressed={!useDates}
              onClick={() => {
                setUseDates(false);
                onChange({ ...city, startDate: null });
              }}
            >
              <span className="choice__label">Just a day count</span>
              <span className="choice__note">Dates unknown for now</span>
            </button>
          </div>

          {useDates ? (
            <div className="city-card__dates">
              <div className="field">
                <label htmlFor={`start-${index}`}>Arrive</label>
                <input
                  id={`start-${index}`}
                  className="input"
                  type="date"
                  value={city.startDate ?? ""}
                  onChange={(e) => onChange({ ...city, startDate: e.target.value || null })}
                />
              </div>
              <div className="field">
                <label htmlFor={`end-${index}`}>Leave</label>
                <input
                  id={`end-${index}`}
                  className="input"
                  type="date"
                  value={
                    city.startDate
                      ? new Date(Date.parse(city.startDate) + (city.days - 1) * 86_400_000)
                          .toISOString()
                          .slice(0, 10)
                      : ""
                  }
                  onChange={(e) => {
                    if (!city.startDate || !e.target.value) return;
                    onChange({ ...city, days: daysBetween(city.startDate, e.target.value) });
                  }}
                />
              </div>
              <p className="city-card__days mono muted">
                {city.days} {city.days === 1 ? "day" : "days"}
              </p>
            </div>
          ) : (
            <div className="field city-card__daycount">
              <label htmlFor={`days-${index}`}>Days here</label>
              <input
                id={`days-${index}`}
                className="input"
                type="number"
                min={1}
                max={30}
                value={city.days}
                onChange={(e) =>
                  onChange({ ...city, days: Math.max(1, Math.min(30, Number(e.target.value) || 1)) })
                }
              />
            </div>
          )}
        </div>

        <details className="city-card__extra">
          <summary>Where you're staying (optional)</summary>
          <p className="muted city-card__extra-note">
            Days will start and end nearer here. Coordinates, if you have them — otherwise leave it
            blank and Wayfind plans around the city centre.
          </p>
          <div className="city-card__coord-inputs">
            <div className="field">
              <label htmlFor={`blat-${index}`}>Latitude</label>
              <input
                id={`blat-${index}`}
                className="input mono"
                inputMode="decimal"
                value={city.basecampLat ?? ""}
                placeholder="41.1462"
                onChange={(e) =>
                  onChange({
                    ...city,
                    basecampLat: e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              />
            </div>
            <div className="field">
              <label htmlFor={`blng-${index}`}>Longitude</label>
              <input
                id={`blng-${index}`}
                className="input mono"
                inputMode="decimal"
                value={city.basecampLng ?? ""}
                placeholder="-8.6108"
                onChange={(e) =>
                  onChange({
                    ...city,
                    basecampLng: e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              />
            </div>
          </div>
          {!located && (
            <div className="city-card__coord-inputs">
              <div className="field">
                <label htmlFor={`clat-${index}`}>City latitude</label>
                <input
                  id={`clat-${index}`}
                  className="input mono"
                  inputMode="decimal"
                  value={city.lat || ""}
                  onChange={(e) => onChange({ ...city, lat: Number(e.target.value) || 0 })}
                />
              </div>
              <div className="field">
                <label htmlFor={`clng-${index}`}>City longitude</label>
                <input
                  id={`clng-${index}`}
                  className="input mono"
                  inputMode="decimal"
                  value={city.lng || ""}
                  onChange={(e) => onChange({ ...city, lng: Number(e.target.value) || 0 })}
                />
              </div>
            </div>
          )}
        </details>
      </div>

      <button className="btn btn--quiet btn--small city-card__remove" onClick={onRemove}>
        Remove
      </button>
    </section>
  );
}
