# WOOPP Print Production Management System 5.0

Professional multi-project 3D print production management & smart scheduling application for **WOOPP Art & Craft**, connected to the `woopp-tracker` Firebase project with non-destructive v1 migration.

## Key Capabilities
- **Smart Production ETA & Multi-Printer Scheduling**:
  - Manual Bambu Studio duration input (`Hours` + `Minutes`) per plate, plus printer-specific duration overrides and speed multipliers (`P1S` vs `A1`).
  - Firebase `serverTimestamp()` start/completion reconciliation with live `HH:MM:SS` countdowns.
  - Pause/Resume support with manual remaining-duration override and strictly frozen countdowns while paused.
  - Global cross-project scheduling engine across all Bambu printers (`Idle`, `Printing`, `Maintenance` windows) with configurable turnaround buffer (plate removal, bed cleaning, restart).
  - Parallel-aware project completion ETAs (computed from each project's final outstanding plate across parallel printers, never naively summed) and automatic deadline warnings.
  - Dedicated **ETA Dashboard** and **Production Timeline** (Gantt schedule) views, formatted in `DD/MM/YYYY` in the selected IANA timezone (`Asia/Kuala_Lumpur` default).
- **Multi-Project Production Management**: Create, edit, and archive unlimited projects across sales channels (`Klebang Walk`, `Vintage Night Market`, `Supply Kedai`, `Corporate/Event`, `Other`), priorities, deadlines, and custom plate capacities.
- **Custom Alphabet Inventory Planner & Presets**: Editable A–Z grid with reusable saved presets and configurable plate capacity (138 pcs/plate default).
- **Intelligent Auto Plate Generator**: Packs requested letters into exact-capacity plates without ever adding unwanted filler letters, protects Completed/Printing plates, handles remainders via carry-forward or partial plates, and lets operators manually adjust plates before saving.
- **Printer Fleet Management**: Supports customizable printers (`Bambu P1S #1`, `Bambu A1 - 01`..`04`), tracks `Idle`, `Printing`, `Completed`, `Maintenance`, and `Offline` states, prevents overlapping active prints on the same printer, and logs print duration and failures.
- **Production Kanban**: Visual 5-column board (`Planned`, `Ready to Print`, `Printing`, `Completed`, `Failed / Reprint`) plus table mode.
- **Idempotent Inventory & Channel Allocation**: Tracks physical produced stock, project-reserved stock, available unallocated stock, wastage/rejects, and safe reversal if a Completed plate is corrected.
- **Dashboard & Analytics**: Multi-dimensional filtering (date, project, channel, machine, color) and CSV export.

## Non-Destructive Schema & Migration Strategy
- Legacy v1 records at `users/{uid}/tracker/main` are **never overwritten or deleted**.
- Existing `users/{uid}/tracker/v5_workspace` records remain 100% compatible: all Smart ETA fields (`startedAtMs`, `isPaused`, `remainingSecondsAtPause`, `estimatedFinishAtMs`, `actualCompletedAtMs`, `machineDurationOverrides`, `turnaroundBufferMinutes`, `timezone`, and optional top-level `serverUpdatedAt`) are additive with safe defaults applied in memory by `normalizeWorkspaceV5`.
