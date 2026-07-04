# pbde-log.ts

## Purpose
Central registry and localStorage adapter for PBDE debug/timing logs. Normalizes log names, resolves persisted on/off state, and exposes helpers so callers can read or bulk-change log toggles from one place.

## Exports

### Variables / Constants
- `pbdeLogNames` -- canonical names for every PBDE log toggle used by the load pipeline

### Functions / Methods
- `setPbdeLogEnabled(name, enabled)` -- writes one toggle to localStorage using the canonical normalized key
- `setAllPbdeLogsEnabled(enabled)` -- enables or disables every registered PBDE log toggle
- `getPbdeLogDefaultEnabled(name)` -- returns the registry default for a log name
- `getPbdeLogNames()` -- returns the registered log names
- `isPbdeLogEnabled(name, defaultEnabled?)` -- resolves the active on/off state for a log toggle

## Internal State
- `pbdeLogDefinitions` stores per-log default enabled values
- `TRUE_VALUES` and `FALSE_VALUES` define accepted string states from localStorage
- Storage lookup accepts legacy key shapes and normalized keys so older settings still work

## Notes
- Canonical writes use `pdeLog.<normalized-name>` while reads still accept older alias keys.
- `Final load time` and `Processing items` default to enabled; the rest default to disabled.
