/** Styles for the flight-control panel, injected once by mountFlightControl(). */
export const FLIGHT_CONTROL_CSS = `
.fcp {
  --fcp-bg: #f6f7f9;
  --fcp-panel: #ffffff;
  --fcp-text: #1b1f24;
  --fcp-dim: #5b6470;
  --fcp-border: #d6dbe1;
  --fcp-ok: #18794e;
  --fcp-ok-bg: #e6f6ee;
  --fcp-warn: #9a5b00;
  --fcp-warn-bg: #fff4e0;
  --fcp-danger: #c62828;
  --fcp-danger-bg: #fdecec;
  box-sizing: border-box;
  max-width: 960px;
  margin: 1rem 0;
  padding: 1rem;
  border: 1px solid var(--fcp-border);
  border-radius: 10px;
  background: var(--fcp-panel);
  color: var(--fcp-text);
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) {
  .fcp {
    --fcp-bg: #11151a;
    --fcp-panel: #171c22;
    --fcp-text: #e6edf3;
    --fcp-dim: #9aa5b1;
    --fcp-border: #2c3540;
    --fcp-ok: #4ade80;
    --fcp-ok-bg: rgba(74, 222, 128, 0.12);
    --fcp-warn: #fbbf24;
    --fcp-warn-bg: rgba(251, 191, 36, 0.12);
    --fcp-danger: #f87171;
    --fcp-danger-bg: rgba(248, 113, 113, 0.14);
  }
}
.fcp *, .fcp *::before, .fcp *::after { box-sizing: inherit; }
.fcp [hidden] { display: none !important; }
.fcp-header { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
.fcp-title { margin: 0; font-size: 1.15rem; }
.fcp-subtitle { margin: 1rem 0 0.4rem; font-size: 0.8rem; letter-spacing: 0.06em; text-transform: uppercase; color: var(--fcp-dim); }
.fcp-stale { padding: 2px 8px; border-radius: 999px; background: var(--fcp-danger); color: #fff; font-weight: 700; letter-spacing: 0.08em; font-size: 0.75rem; }
.fcp--stale > :not(.fcp-header) { opacity: 0.45; filter: grayscale(1); }
.fcp-banner { margin: 0.75rem 0; padding: 0.7rem 0.9rem; border-radius: 8px; font-size: 1.15rem; font-weight: 700; background: var(--fcp-bg); }
.fcp-banner[data-tone="ok"] { background: var(--fcp-ok-bg); color: var(--fcp-ok); }
.fcp-banner[data-tone="warn"] { background: var(--fcp-warn-bg); color: var(--fcp-warn); }
.fcp-banner[data-tone="danger"] { background: var(--fcp-danger-bg); color: var(--fcp-danger); }
.fcp-row { display: flex; justify-content: space-between; gap: 1rem; padding: 0.3rem 0; border-bottom: 1px solid var(--fcp-border); }
.fcp-row__label { color: var(--fcp-dim); flex: none; }
.fcp-row__value { text-align: right; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
[data-tone="ok"] { color: var(--fcp-ok); }
[data-tone="warn"] { color: var(--fcp-warn); }
[data-tone="danger"] { color: var(--fcp-danger); }
.fcp-setting { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.75rem; font-weight: 600; }
.fcp-setting input { width: 18px; height: 18px; }
.fcp-hint { margin: 0.3rem 0; color: var(--fcp-dim); font-size: 0.85rem; }
.fcp-hint:empty { display: none; }
.fcp-error { margin: 0.5rem 0; color: var(--fcp-danger); font-weight: 600; }
.fcp-go { display: inline-block; padding: 2px 12px; border-radius: 6px; font-weight: 800; letter-spacing: 0.08em; color: #fff; }
.fcp-go[data-tone="ok"] { background: var(--fcp-ok); color: #fff; }
.fcp-go[data-tone="danger"] { background: var(--fcp-danger); color: #fff; }
.fcp-go-list { list-style: none; margin: 0.4rem 0 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 2px 1rem; }
.fcp-ok { color: var(--fcp-ok); }
.fcp-bad { color: var(--fcp-danger); }
.fcp-detail { color: var(--fcp-dim); }
.fcp-telemetry, .fcp-health { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); column-gap: 1.5rem; }
.fcp-controls { display: grid; gap: 0.6rem; }
.fcp-take { display: flex; align-items: center; gap: 0.75rem; width: 100%; padding: 0.6rem 0.9rem; border: 2px solid var(--fcp-warn); border-radius: 10px; background: var(--fcp-warn-bg); color: var(--fcp-text); font: inherit; font-size: 1.05rem; font-weight: 700; cursor: pointer; user-select: none; -webkit-user-select: none; touch-action: none; }
.fcp-take:disabled { opacity: 0.5; cursor: not-allowed; }
.fcp-take svg { width: 44px; height: 44px; flex: none; transform: rotate(-90deg); }
.fcp-take__track { fill: none; stroke: var(--fcp-border); stroke-width: 5; }
.fcp-take__ring { fill: none; stroke: var(--fcp-warn); stroke-width: 5; stroke-linecap: round; }
.fcp-actions { display: flex; gap: 0.6rem; align-items: stretch; flex-wrap: wrap; }
.fcp-abort { flex: 1 1 260px; min-height: 64px; border: none; border-radius: 10px; background: var(--fcp-danger); color: #fff; font: inherit; font-size: 1.6rem; font-weight: 900; letter-spacing: 0.12em; cursor: pointer; touch-action: manipulation; }
.fcp-abort:disabled { background: var(--fcp-border); color: var(--fcp-dim); cursor: not-allowed; }
.fcp--unlocked { padding-bottom: 104px; }
.fcp--unlocked .fcp-actions {
  position: fixed;
  left: 50%;
  bottom: 12px;
  z-index: 1000;
  width: min(928px, calc(100% - 24px));
  transform: translateX(-50%);
  padding: 8px;
  border: 1px solid var(--fcp-border);
  border-radius: 12px;
  background: var(--fcp-panel);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25);
}
.fcp-handback { flex: 0 1 auto; padding: 0.5rem 0.9rem; border: 1px solid var(--fcp-border); border-radius: 8px; background: transparent; color: var(--fcp-text); font: inherit; cursor: pointer; }
.fcp-handback:disabled { opacity: 0.5; cursor: not-allowed; }
.fcp-deadman { margin: 0; padding: 0.5rem 0.7rem; border-radius: 8px; background: var(--fcp-danger-bg); color: var(--fcp-danger); font-weight: 600; }
.fcp kbd { margin-left: 0.35rem; padding: 0 4px; border: 1px solid var(--fcp-border); border-radius: 4px; font: 0.75rem ui-monospace, monospace; color: var(--fcp-dim); }
.fcp-pads { display: flex; flex-wrap: wrap; justify-content: space-around; gap: 1rem; margin-top: 0.8rem; }
.fcp-pad__title { text-align: center; color: var(--fcp-dim); font-size: 0.85rem; margin-bottom: 0.3rem; }
.fcp-pad__grid { display: grid; grid-template-columns: repeat(3, 64px); grid-template-rows: repeat(3, 64px); grid-template-areas: ". up ." "left . right" ". down ."; gap: 4px; }
.fcp-pad__btn { display: flex; flex-direction: column; align-items: center; justify-content: center; border: 1px solid var(--fcp-border); border-radius: 10px; background: var(--fcp-bg); color: var(--fcp-text); font-size: 1.4rem; cursor: pointer; user-select: none; -webkit-user-select: none; touch-action: none; }
.fcp-pad__btn kbd { margin: 0; font-size: 0.7rem; }
.fcp-pad__btn:active:not(:disabled), .fcp-pad__btn--engaged { background: var(--fcp-ok-bg); border-color: var(--fcp-ok); color: var(--fcp-ok); }
.fcp-pad__btn:disabled { opacity: 0.4; cursor: not-allowed; }
.fcp-pad__btn--up { grid-area: up; }
.fcp-pad__btn--down { grid-area: down; }
.fcp-pad__btn--left { grid-area: left; }
.fcp-pad__btn--right { grid-area: right; }
.fcp-sliders { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 0.4rem 1.5rem; margin-top: 0.8rem; }
.fcp-slider { display: grid; grid-template-columns: 3.5rem 1fr 3rem; align-items: center; gap: 0.5rem; }
.fcp-slider input { width: 100%; }
.fcp-slider__value { text-align: right; font-variant-numeric: tabular-nums; color: var(--fcp-dim); }
`;
