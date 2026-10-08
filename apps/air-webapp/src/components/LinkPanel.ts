import "./LinkPanel.css";
import { createPanel } from "./Panel.js";
import { createStatRow, type StatRowHandle } from "./StatRow.js";
import { createStatusPill } from "./StatusPill.js";
import { createDropdown } from "./Dropdown.js";
import { icons } from "./icons.js";

export interface LinkPanelOptions {
  qrSupported: boolean;
  onPair: (bundleText: string) => void;
  onStartScan: () => void;
  onCancelScan: () => void;
  onSwitchCamera: () => void;
  onDeviceChange: (deviceId: string) => void;
}

export interface LinkPanelHandle {
  el: HTMLElement;
  /** The outgoing video feed's local preview. */
  videoEl: HTMLVideoElement;
  /** The QR scan view's own camera preview. */
  scanVideoEl: HTMLVideoElement;
  setConnected(connected: boolean): void;
  /** Gates the auto-started QR scan until the app is ready to hand the camera over to it. */
  setScanAllowed(allowed: boolean): void;
  /** Forgets whether a scan is running and restarts it if the panel is showing the scan view
   * -- for when the app stopped the scan itself (e.g. on a scan result whose pairing failed). */
  resyncScan(): void;
  setPairing(pairing: boolean): void;
  setLatency(text: string): void;
  setThroughput(text: string): void;
  setUptime(text: string): void;
  setError(message: string): void;
  setScanActive(active: boolean): void;
  setCameraSwitchAvailable(available: boolean): void;
  populateDevices(devices: MediaDeviceInfo[]): void;
  setSelectedDevice(deviceId: string): void;
  setStreaming(streaming: boolean): void;
  setResolution(text: string | null): void;
  setFps(text: string | null): void;
  setBitrate(text: string | null): void;
  setVideoError(message: string): void;
}

const NO_VIDEO_VALUE = "";

/**
 * Ground link panel, merging server binding and the video feed. While not
 * connected it goes straight to scanning the ground station's QR code; the
 * header's keyboard button swaps that for the binding-phrase form instead.
 * Once connected it shows the outgoing feed's preview plus live WebRTC link
 * stats. The header's camera button opens video source selection in either
 * state.
 *
 * The scan view owns its own camera stream rather than reusing the video
 * feed's -- there may be no feed yet to piggyback on, and a dedicated stream
 * lets it default to the rear camera and cycle through every available device
 * independently of whichever camera is bound as the outgoing feed.
 */
export function createLinkPanel(options: LinkPanelOptions): LinkPanelHandle {
  let connected = false;
  let phraseOpen = !options.qrSupported;
  let sourceOpen = false;
  let streaming = false;
  let scanAllowed = false;
  let scanning = false;

  const panel = createPanel({
    number: "01",
    title: "SERVER BINDING",
    toggles: [
      {
        icon: icons.keyboard,
        ariaLabel: "Enter binding phrase",
        active: phraseOpen,
        onClick: () => {
          phraseOpen = !phraseOpen || !options.qrSupported;
          sourceOpen = false;
          render();
        },
      },
      {
        icon: icons.camera,
        ariaLabel: "Choose video source",
        active: false,
        onClick: () => {
          sourceOpen = !sourceOpen;
          render();
        },
      },
    ],
  });
  const [phraseToggle, sourceToggle] = panel.toggles;

  // --- video preview (feed + source views) ---

  const videoWrap = document.createElement("div");
  videoWrap.className = "dl-video";

  const videoEl = document.createElement("video");
  videoEl.className = "dl-video__el";
  videoEl.autoplay = true;
  videoEl.playsInline = true;
  videoEl.muted = true;

  const placeholder = document.createElement("div");
  placeholder.className = "dl-video__placeholder";
  placeholder.textContent = "No active video feed";

  const livePill = createStatusPill({ label: "LIVE", tone: "red", variant: "solid" });
  livePill.classList.add("dl-video__live");

  const tags = document.createElement("div");
  tags.className = "dl-video__tags";

  const leftTags = document.createElement("div");
  leftTags.className = "dl-video__tag-group";
  const resolutionTag = document.createElement("span");
  resolutionTag.className = "dl-video__tag";
  resolutionTag.hidden = true;
  const fpsTag = document.createElement("span");
  fpsTag.className = "dl-video__tag";
  fpsTag.hidden = true;
  leftTags.append(resolutionTag, fpsTag);

  const rightTags = document.createElement("div");
  rightTags.className = "dl-video__tag-group";
  const bitrateTag = document.createElement("span");
  bitrateTag.className = "dl-video__tag";
  bitrateTag.hidden = true;
  rightTags.append(bitrateTag);

  tags.append(leftTags, rightTags);
  videoWrap.append(videoEl, placeholder, livePill, tags);

  // --- feed view: link stats ---

  const statusRow = document.createElement("div");
  statusRow.className = "dl-link__row";
  statusRow.innerHTML = `
    <span class="dl-link__row-left">
      <span class="dl-link__row-icon">${icons.wifiBars}</span>
      <span>WebRTC Protocol</span>
    </span>
  `;
  const signalIcon = document.createElement("span");
  signalIcon.className = "dl-link__signal";
  signalIcon.innerHTML = icons.wifiBars;
  statusRow.appendChild(signalIcon);

  const latencyRow: StatRowHandle = createStatRow("Network Latency", "—");
  const throughputRow: StatRowHandle = createStatRow("Relay Throughput", "—");
  const uptimeRow: StatRowHandle = createStatRow("Uptime Session", "00:00:00");

  // --- source view ---

  const selectRow = document.createElement("div");
  selectRow.className = "dl-video__select-row";

  const dropdown = createDropdown({
    icon: icons.camera,
    onChange: (value) => options.onDeviceChange(value),
  });
  dropdown.setOptions([{ value: NO_VIDEO_VALUE, label: "No Video (Data Only)" }]);
  selectRow.append(dropdown.el);

  const sourceHelper = document.createElement("p");
  sourceHelper.className = "dl-link__helper";
  sourceHelper.textContent = "Choose a connected camera to bind a video feed.";

  const videoErrorEl = document.createElement("p");
  videoErrorEl.className = "dl-link__error";
  videoErrorEl.hidden = true;

  // --- binding: scan view ---

  const scanWrap = document.createElement("div");
  scanWrap.className = "dl-link__scan-wrap";

  const scanVideoWrap = document.createElement("div");
  scanVideoWrap.className = "dl-link__scan-video-wrap";

  const scanVideoEl = document.createElement("video");
  scanVideoEl.className = "dl-link__scan-video";
  scanVideoEl.autoplay = true;
  scanVideoEl.playsInline = true;
  scanVideoEl.muted = true;

  const scanPlaceholder = document.createElement("div");
  scanPlaceholder.className = "dl-link__scan-placeholder";
  scanPlaceholder.textContent = "Opening camera…";

  const scanReticle = document.createElement("div");
  scanReticle.className = "dl-link__scan-reticle";
  scanReticle.innerHTML = `
    <span class="dl-link__scan-corner dl-link__scan-corner--tl"></span>
    <span class="dl-link__scan-corner dl-link__scan-corner--tr"></span>
    <span class="dl-link__scan-corner dl-link__scan-corner--bl"></span>
    <span class="dl-link__scan-corner dl-link__scan-corner--br"></span>
  `;

  const switchCameraButton = document.createElement("button");
  switchCameraButton.type = "button";
  switchCameraButton.className = "dl-link__scan-switch";
  switchCameraButton.innerHTML = icons.refresh;
  switchCameraButton.setAttribute("aria-label", "Switch camera");
  switchCameraButton.hidden = true;
  switchCameraButton.addEventListener("click", () => options.onSwitchCamera());

  const scanHint = document.createElement("p");
  scanHint.className = "dl-link__scan-hint";
  scanHint.textContent = "Point the camera at the ground station's QR code";

  scanVideoWrap.append(scanVideoEl, scanPlaceholder, scanReticle, switchCameraButton, scanHint);
  scanWrap.append(scanVideoWrap);

  // --- binding: phrase view ---

  const phraseWrap = document.createElement("div");
  phraseWrap.className = "dl-link__phrase-wrap";

  const bundleInput = document.createElement("textarea");
  bundleInput.className = "dl-link__bundle-input";
  bundleInput.rows = 5;
  bundleInput.placeholder = '{"sessionId":"...","token":"...","host":"localhost","port":8443}';

  const pairButton = document.createElement("button");
  pairButton.type = "button";
  pairButton.className = "dl-link__pair-button";
  pairButton.textContent = "Pair";
  pairButton.addEventListener("click", () => options.onPair(bundleInput.value));

  phraseWrap.append(bundleInput, pairButton);

  const bindingHelper = document.createElement("p");
  bindingHelper.className = "dl-link__helper";
  bindingHelper.textContent = "Can't scan? Use the keyboard button above to enter the binding phrase.";

  const errorEl = document.createElement("p");
  errorEl.className = "dl-link__error";
  errorEl.hidden = true;

  panel.bodyEl.append(
    scanWrap,
    phraseWrap,
    bindingHelper,
    selectRow,
    sourceHelper,
    videoWrap,
    statusRow,
    latencyRow.el,
    throughputRow.el,
    uptimeRow.el,
    errorEl,
    videoErrorEl,
  );

  function syncScan() {
    const shouldScan = scanAllowed && !connected && !sourceOpen && !phraseOpen;
    if (shouldScan === scanning) return;
    scanning = shouldScan;
    if (shouldScan) {
      scanPlaceholder.hidden = false;
      switchCameraButton.hidden = true;
      options.onStartScan();
    } else {
      options.onCancelScan();
    }
  }

  function render() {
    const showSource = sourceOpen;
    const showFeed = connected && !sourceOpen;
    const showBinding = !connected && !sourceOpen;

    scanWrap.hidden = !(showBinding && !phraseOpen);
    phraseWrap.hidden = !(showBinding && phraseOpen);
    bindingHelper.hidden = !(showBinding && !phraseOpen);

    selectRow.hidden = !showSource;
    sourceHelper.hidden = !showSource;

    videoWrap.hidden = !(showFeed || showSource);
    placeholder.hidden = streaming;
    videoEl.hidden = !streaming;
    livePill.hidden = !streaming;
    tags.hidden = !streaming;

    statusRow.hidden = !showFeed;
    latencyRow.el.hidden = !showFeed;
    throughputRow.el.hidden = !showFeed;
    uptimeRow.el.hidden = !showFeed;

    panel.setTitle(showSource ? "VIDEO SOURCE" : showFeed ? "GROUND LINK" : "SERVER BINDING");
    phraseToggle.setHidden(connected || !options.qrSupported);
    phraseToggle.setActive(showBinding && phraseOpen);
    sourceToggle.setActive(sourceOpen);

    syncScan();
  }

  render();

  return {
    el: panel.el,
    videoEl,
    scanVideoEl,
    setConnected(next: boolean) {
      connected = next;
      signalIcon.classList.toggle("dl-link__signal--active", next);
      sourceOpen = false;
      phraseOpen = !options.qrSupported;
      render();
    },
    setScanAllowed(allowed: boolean) {
      scanAllowed = allowed;
      render();
    },
    resyncScan() {
      scanning = false;
      render();
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
    populateDevices(devices: MediaDeviceInfo[]) {
      const previous = dropdown.getValue();
      dropdown.setOptions([
        { value: NO_VIDEO_VALUE, label: "No Video (Data Only)" },
        ...devices.map((device, index) => ({
          value: device.deviceId,
          label: device.label || `Camera ${index + 1}`,
        })),
      ]);
      dropdown.setValue(previous);
    },
    setSelectedDevice(deviceId: string) {
      dropdown.setValue(deviceId);
    },
    setStreaming(next: boolean) {
      streaming = next;
      render();
    },
    setResolution(text: string | null) {
      resolutionTag.hidden = text === null;
      resolutionTag.textContent = text ?? "";
    },
    setFps(text: string | null) {
      fpsTag.hidden = text === null;
      fpsTag.textContent = text ?? "";
    },
    setBitrate(text: string | null) {
      bitrateTag.hidden = text === null;
      bitrateTag.textContent = text ?? "";
    },
    setVideoError(message: string) {
      videoErrorEl.hidden = message.length === 0;
      videoErrorEl.textContent = message;
    },
  };
}
