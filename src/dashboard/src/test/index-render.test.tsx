import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { Route } from "@/routes/index";
import * as api from "@/lib/telemetry-sessions";

describe("Index Page Rendering with Session Data", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders with loaded sessions, laps, and telemetry", async () => {
    // Mock API data matching real backend
    vi.spyOn(api, "fetchSessions").mockResolvedValue([
      {
        session_id: "ses_1795281555422",
        device_id: "muie garda",
        track_name: "top G",
        created_at: "2026-11-21T17:19:20.053Z",
      },
      {
        session_id: "ses_1795271253119",
        device_id: "Alex - S23gg",
        track_name: "Circuit-Clujbbbd",
        created_at: "2026-11-21T14:27:33.522Z",
      },
    ]);

    vi.spyOn(api, "fetchLaps").mockResolvedValue([
      {
        lap_id: "ses_1795281555422_lap_01",
        lap_number: 1,
        duration_ms: 9199,
        max_speed_kmh: 3,
        max_g_lat: 0,
        max_g_brake: 0,
        avg_speed_kmh: 0.2,
      },
    ]);

    vi.spyOn(api, "fetchTelemetry").mockResolvedValue([
      {
        lap_id: "ses_1795281555422_lap_01",
        lap_offset_ms: 17,
        lat: 0,
        lon: 0,
        speed_kmh: 0,
        bearing: 0,
        g_lat: 0,
        g_lon: 0,
        is_corner_apex: 0,
        lap_number: 1,
      },
      {
        lap_id: "ses_1795281555422_lap_01",
        lap_offset_ms: 568,
        lat: 46.7738421,
        lon: 23.6206504,
        speed_kmh: 0,
        bearing: 0,
        g_lat: 0,
        g_lon: 0,
        is_corner_apex: 0,
        lap_number: 1,
      },
      {
        lap_id: "ses_1795281555422_lap_01",
        lap_offset_ms: 9199,
        lat: 46.7738433,
        lon: 23.6206502,
        speed_kmh: 3,
        bearing: 89.985,
        g_lat: 0,
        g_lon: 0,
        is_corner_apex: 0,
        lap_number: 1,
      },
    ]);

    vi.spyOn(api, "fetchLiveTelemetry").mockResolvedValue([]);

    const Component = Route.options.component!;
    render(<Component />);

    await waitFor(() => {
      expect(screen.getAllByText("top G").length).toBeGreaterThan(0);
    });
  });

  it("draws independent GPS segments and allows replaying all laps", async () => {
    const sessionId = "session-with-gps-gap";
    const lapId = sessionId + "_lap_01";
    const partialId = sessionId + "_lap_02";
    const lap = {
      lap_id: lapId,
      lap_number: 1,
      duration_ms: 20_000,
      is_complete: true,
      avg_speed_kmh: 36,
      max_speed_kmh: 36,
      max_g_lat: 0,
      max_g_brake: 0,
    };
    const point = {
      lap_id: lapId,
      lap_number: 1,
      lap_offset_ms: 0,
      session_offset_ms: 0,
      lat: 46.78,
      lon: 23.61,
      speed_kmh: 36,
      bearing: 0,
      g_lat: 0,
      g_lon: 0,
      is_corner_apex: 0 as const,
    };
    vi.spyOn(api, "fetchSessions").mockResolvedValue([
      { session_id: sessionId, device_id: "Driver", track_name: "Circuit", created_at: "2026-01-01T00:00:00Z" },
    ]);
    vi.spyOn(api, "fetchLaps").mockResolvedValue([
      lap,
      { ...lap, lap_id: partialId, lap_number: 2, duration_ms: 100, is_complete: false },
    ]);
    vi.spyOn(api, "fetchTelemetry").mockResolvedValue([
      point,
      { ...point, lap_offset_ms: 100, session_offset_ms: 100, lat: 46.78002 },
      { ...point, lap_offset_ms: 150, session_offset_ms: 150, lat: 46.784 },
      { ...point, lap_offset_ms: 250, session_offset_ms: 250, lat: 46.78402 },
      { ...point, lap_id: partialId, lap_number: 2, lap_offset_ms: 20, session_offset_ms: 20_020 },
      { ...point, lap_id: partialId, lap_number: 2, lap_offset_ms: 100, session_offset_ms: 20_100, lat: 46.78002 },
    ]);
    vi.spyOn(api, "fetchLiveTelemetry").mockResolvedValue([]);

    const Component = Route.options.component!;
    const { container } = render(<Component />);
    const reset = await screen.findByRole("button", { name: /reset to all laps/i });
    const segmentCount = () =>
      container.querySelector('path[stroke="#141416"]')?.getAttribute("d")?.match(/M/g)?.length;
    expect(segmentCount()).toBe(2);
    expect(screen.getByText("Incomplete")).toBeInTheDocument();

    fireEvent.click(reset);
    expect(segmentCount()).toBe(3);
    expect(screen.queryByRole("button", { name: /reset to all laps/i })).toBeNull();
  });
});
