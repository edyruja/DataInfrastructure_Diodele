import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
});
