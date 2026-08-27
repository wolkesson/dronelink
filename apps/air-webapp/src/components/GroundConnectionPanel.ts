import "./GroundConnectionPanel.css";
import { createPanel } from "./Panel.js";
import { createStatRow, type StatRowHandle } from "./StatRow.js";
import { icons } from "./icons.js";

export type GroundConnectionMode = "view" | "binding";
export type BindingView = "choice" | "scan" | "phrase";

export interface GroundConnectionPanelOptions {
  qrSupported: boolean;
  onPair: (bundleText: string) => void;
  onStartScan: () => void;
  onCancelScan: () => void;
  onSwitchCamera: () => void;
}

export interface GroundConnectionPanelHandle {
  el: HTMLElement;
  videoEl: HTMLVideoElement;
  setMode(mode: GroundConnectionMode): void;
  setConnected(connected: boolean): void;
  setPairing(pairing: boolean): void;
  setLatency(text: string): void;
  setThroughput(text: string): void;
  setUptime(text: string): void;
  setError(message: string): void;
  setScanActive(active: boolean): void;
  setCameraSwitchAvailable(available: boolean): void;
}

/**
 * Ground connection panel — the first step of the workflow. "Binding" mode
 * opens on a choice screen (large "Scan QR" CTA + a smaller "enter binding
 * phrase" link); each option drills into its own sub-view (a self-contained
 * camera preview for scanning, or the textarea/Pair form for pasting the
 * bundle). "View" mode (once connected) shows live WebRTC link stats.
 *
 * The scan view owns its own camera stream rather than reusing the video
 * source panel's — binding now happens before a video source is picked, so
 * there is no feed to piggyback on, and a dedicated stream lets it default to
 * the rear camera and cycle through every available device independently of
 * whichever camera later gets bound as the outgoing feed.
 */
export function createGroundConnectionPanel(
  options: GroundConnectionPanelOptions,
): GroundConnectionPanelHandle {
  let mode: GroundConnectionMode = "binding";
  let view: BindingView = options.qrSupported ? "choice" : "phrase";

  const panel = createPanel({
    number: "01",
    title: "SERVER BINDING",
    toggle: {
      icon: icons.dot,
      ariaLabel: "Toggle ground connection details",
      active: true,
      onClick: () => setMode(mode === "binding" ? "view" : "binding"),
    },
  });

  // --- view mode ---

  const statusRow = document.createElement("div");
  statusRow.className = "dl-ground__row";
  statusRow.innerHTML = `
    <span class="dl-ground__row-left">
      <span class="dl-ground__row-icon">${icons.wifiBars}</span>
      <span>WebRTC Protocol</span>
    </span>
  `;
  const signalIcon = document.createElement("span");
  signalIcon.className = "dl-ground__signal";
  signalIcon.innerHTML = icons.wifiBars;
  statusRow.appendChild(signalIcon);

  const latencyRow: StatRowHandle = createStatRow("Network Latency", "—");
  const throughputRow: StatRowHandle = createStatRow("Relay Throughput", "—");
  const uptimeRow: StatRowHandle = createStatRow("Uptime Session", "00:00:00");

  // --- binding mode: choice screen ---

  const choiceWrap = document.createElement("div");
  choiceWrap.className = "dl-ground__choice";

  const scanButton = document.createElement("button");
  scanButton.type = "button";
  scanButton.className = "dl-ground__scan-cta";
  scanButton.innerHTML = `
    <span class="dl-ground__scan-cta-icon">${icons.qrCode}</span>
    <span class="dl-ground__scan-cta-label">Scan QR</span>
  `;
  scanButton.addEventListener("click", () => setView("scan"));

  const phraseLink = document.createElement("button");
  phraseLink.type = "button";
  phraseLink.className = "dl-ground__link-button";
  phraseLink.textContent = "Enter binding phrase";
  phraseLink.addEventListener("click", () => setView("phrase"));

  if (options.qrSupported) {
    choiceWrap.append(scanButton, phraseLink);
  } else {
    choiceWrap.hidden = true;
  }

  // --- binding mode: scan view (self-contained camera preview) ---

  const scanWrap = document.createElement("div");
  scanWrap.className = "dl-ground__scan-wrap";

  const scanBackLink = document.createElement("button");
  scanBackLink.type = "button";
  scanBackLink.className = "dl-ground__link-button dl-ground__back-link";
  scanBackLink.textContent = "‹ Back";
  scanBackLink.addEventListener("click", () => setView("choice"));

  const scanVideoWrap = document.createElement("div");
  scanVideoWrap.className = "dl-ground__scan-video-wrap";

  const videoEl = document.createElement("video");
  videoEl.className = "dl-ground__scan-video";
  videoEl.autoplay = true;
  videoEl.playsInline = true;
  videoEl.muted = true;

  const scanPlaceholder = document.createElement("div");
  scanPlaceholder.className = "dl-ground__scan-placeholder";
  scanPlaceholder.textContent = "Opening camera…";

  const scanReticle = document.createElement("div");
  scanReticle.className = "dl-ground__scan-reticle";
  scanReticle.innerHTML = `
    <span class="dl-ground__scan-corner dl-ground__scan-corner--tl"></span>
    <span class="dl-ground__scan-corner dl-ground__scan-corner--tr"></span>
    <span class="dl-ground__scan-corner dl-ground__scan-corner--bl"></span>
    <span class="dl-ground__scan-corner dl-ground__scan-corner--br"></span>
  `;

  const switchCameraButton = document.createElement("button");
  switchCameraButton.type = "button";
  switchCameraButton.className = "dl-ground__scan-switch";
  switchCameraButton.innerHTML = icons.refresh;
  switchCameraButton.setAttribute("aria-label", "Switch camera");
  switchCameraButton.hidden = true;
  switchCameraButton.addEventListener("click", () => options.onSwitchCamera());

  const scanHint = document.createElement("p");
  scanHint.className = "dl-ground__scan-hint";
  scanHint.textContent = "Point the camera at the ground station's QR code";

  scanVideoWrap.append(videoEl, scanPlaceholder, scanReticle, switchCameraButton, scanHint);
  scanWrap.append(scanBackLink, scanVideoWrap);
  scanWrap.hidden = true;

  // --- binding mode: phrase view ---

  const phraseWrap = document.createElement("div");
  phraseWrap.className = "dl-ground__phrase-wrap";

  const phraseBackLink = document.createElement("button");
  phraseBackLink.type = "button";
  phraseBackLink.className = "dl-ground__link-button dl-ground__back-link";
  phraseBackLink.textContent = "‹ Back";
  phraseBackLink.addEventListener("click", () => setView("choice"));
  if (!options.qrSupported) phraseBackLink.hidden = true;

  const bundleInput = document.createElement("textarea");
  bundleInput.className = "dl-ground__bundle-input";
  bundleInput.rows = 5;
  bundleInput.placeholder =
    '{"sessionId":"...","token":"...","host":"localhost","port":8443}';

  const pairButton = document.createElement("button");
  pairButton.type = "button";
  pairButton.className = "dl-ground__pair-button";
  pairButton.textContent = "Pair";
  pairButton.addEventListener("click", () => options.onPair(bundleInput.value));

  phraseWrap.append(phraseBackLink, bundleInput, pairButton);
  phraseWrap.hidden = true;

  const helper = document.createElement("p");
  helper.className = "dl-ground__helper";
  helper.textContent = "Scan the ground station's QR code, or enter its binding phrase manually.";

  const errorEl = document.createElement("p");
  errorEl.className = "dl-ground__error";
  errorEl.hidden = true;

  panel.bodyEl.append(
    statusRow,
    latencyRow.el,
    throughputRow.el,
    uptimeRow.el,
    choiceWrap,
    scanWrap,
    phraseWrap,
    helper,
    errorEl,
  );

  function render() {
    const showView = mode === "view";
    statusRow.hidden = !showView;
    latencyRow.el.hidden = !showView;
    throughputRow.el.hidden = !showView;
    uptimeRow.el.hidden = !showView;

    const showBinding = !showView;
    choiceWrap.hidden = !(showBinding && view === "choice" && options.qrSupported);
    scanWrap.hidden = !(showBinding && view === "scan");
    phraseWrap.hidden = !(showBinding && view === "phrase");
    helper.hidden = !(showBinding && view === "choice" && options.qrSupported);

    panel.setTitle(showView ? "GROUND CONNECTION" : "SERVER BINDING");
    panel.setToggleActive(!showView);
  }

  function setView(next: BindingView) {
    if (view === next) return;
    if (view === "scan") options.onCancelScan();
    view = next;
    if (next === "scan") {
      scanPlaceholder.hidden = false;
      switchCameraButton.hidden = true;
      options.onStartScan();
    }
    render();
  }

  function setMode(next: GroundConnectionMode) {
    if (mode === "binding" && view === "scan" && next !== "binding") {
      options.onCancelScan();
    }
    mode = next;
    if (next === "binding") {
      view = options.qrSupported ? "choice" : "phrase";
    }
    render();
  }

  render();

  return {
    el: panel.el,
    videoEl,
    setMode,
    setConnected(connected: boolean) {
      signalIcon.classList.toggle("dl-ground__signal--active", connected);
      if (connected) {
        setMode("view");
      }
    },
    setPairing(pairing: boolean) {
      pairButton.disabled = pairing;
      pairButton.textContent = pairing ? "Pairing…" : "Pair";
    },
    setLatency(text: string) {
      latencyRow.setValue(text);
    },
    setThroughput(text: string) {
      throughputRow.setValue(text);
    },
    setUptime(text: string) {
      uptimeRow.setValue(text);
    },
    setError(message: string) {
      errorEl.hidden = message.length === 0;
      errorEl.textContent = message;
    },
    setScanActive(active: boolean) {
      scanPlaceholder.hidden = active;
    },
    setCameraSwitchAvailable(available: boolean) {
      switchCameraButton.hidden = !available;
    },
  };
}
