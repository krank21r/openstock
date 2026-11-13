"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { StopMode } from "@/lib/stock-types";

interface StopModeState {
  stopMode: StopMode;
  setStopMode: (mode: StopMode) => void;
}

/**
 * Global stop-loss placement preference.
 *
 *  - "tight" (default): 1×ATR or just-below the last swing pivot — small risk
 *    per trade, R:R expands, but a higher share of trades get stopped out.
 *  - "balanced": farther of the 20-day S/R and 2×ATR — more room, fewer
 *    noise stop-outs, smaller R:R.
 *
 * Persisted to localStorage so it survives reloads. Applies to every displayed
 * setup and to what "I Took This Trade" records for that trade.
 */
export const useStopModeStore = create<StopModeState>()(
  persist(
    (set) => ({
      stopMode: "tight",
      setStopMode: (stopMode) => set({ stopMode }),
    }),
    { name: "openstock.stopMode" },
  ),
);
