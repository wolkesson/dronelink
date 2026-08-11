import "./VideoFeedPanel.css";
import { createPanel } from "./Panel.js";
import { createStatusPill } from "./StatusPill.js";
import { createDropdown } from "./Dropdown.js";
import { icons } from "./icons.js";

export type VideoFeedMode = "view" | "select";

export interface VideoFeedPanelOptions {
  onDeviceChange: (deviceId: string) => void;
}

export interface VideoFeedPanelHandle {
  el: HTMLElement;
  videoEl: HTMLVideoElement;
  setMode(mode: VideoFeedMode): void;
  populateDevices(devices: MediaDeviceInfo[]): void;
  setStreaming(streaming: boolean): void;
  setResolution(text: string | null): void;
  setFps(text: string | null): void;
  setBitrate(text: string | null): void;
  setError(message: string): void;
  setScanning(scanning: boolean): void;
}

const NO_VIDEO_VALUE = "";

/**
 * Video source panel: a "select a camera" row when no feed is bound, and a
 * live preview with LIVE/resolution/fps/bitrate overlays once one is.
 * The header toggle lets the operator jump back to source selection even
 * while a feed is live.
 */
export function createVideoFeedPanel(options: VideoFeedPanelOptions): VideoFeedPanelHandle {
  let mode: VideoFeedMode = "select";
  let streaming = false;
  let scanning = false;

  const panel = createPanel({
    number: "01",
    title: "VIDEO SOURCE",
    toggle: {
      icon: icons.camera,
      ariaLabel: "Choose video source",
      active: true,
      onClick: () => setMode(mode === "select" ? "view" : "select"),
    },
  });

  // --- view mode ---

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
  livePill.hidden = true;

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

  const qrReticle = document.createElement("div");
  qrReticle.className = "dl-video__qr-reticle";
  qrReticle.hidden = true;
  qrReticle.innerHTML = `
    <span class="dl-video__qr-corner dl-video__qr-corner--tl"></span>
    <span class="dl-video__qr-corner dl-video__qr-corner--tr"></span>
    <span class="dl-video__qr-corner dl-video__qr-corner--bl"></span>
    <span class="dl-video__qr-corner dl-video__qr-corner--br"></span>
  `;

  const qrHint = document.createElement("p");
  qrHint.className = "dl-video__qr-hint";
  qrHint.hidden = true;
  qrHint.textContent = "Point camera at ground station QR code";

  videoWrap.append(videoEl, placeholder, livePill, tags, qrReticle, qrHint);

  // --- select mode ---

  const selectRow = document.createElement("div");
  selectRow.className = "dl-video__select-row";

  const dropdown = createDropdown({
    icon: icons.camera,
    onChange: (value) => options.onDeviceChange(value),
  });
  dropdown.setOptions([{ value: NO_VIDEO_VALUE, label: "No Video (Data Only)" }]);

  selectRow.append(dropdown.el);

  const helper = document.createElement("p");
  helper.className = "dl-video__helper";
  helper.textContent = "Choose a connected camera to bind a video feed.";

  const errorEl = document.createElement("p");
  errorEl.className = "dl-video__error";
  errorEl.hidden = true;

  panel.bodyEl.append(videoWrap, selectRow, helper, errorEl);

  function render() {
    const showView = mode === "view";
    videoWrap.hidden = !showView;
    selectRow.hidden = showView;
    helper.hidden = showView;
    placeholder.hidden = !showView || streaming;
    videoEl.hidden = !showView || !streaming;
    livePill.hidden = !showView || !streaming || scanning;
    tags.hidden = !showView || !streaming || scanning;
    qrReticle.hidden = !showView || !scanning;
    qrHint.hidden = !showView || !scanning;
    panel.setTitle(showView ? "VIDEO FEED STATUS" : "VIDEO SOURCE");
    panel.setToggleActive(!showView);
  }

  function setMode(next: VideoFeedMode) {
    if (scanning) return;
    mode = next;
    render();
  }

  render();

  return {
    el: panel.el,
    videoEl,
    setMode,
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
    setStreaming(next: boolean) {
      streaming = next;
      if (next) {
        setMode("view");
      } else {
        render();
      }
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
    setError(message: string) {
      errorEl.hidden = message.length === 0;
      errorEl.textContent = message;
    },
    setScanning(next: boolean) {
      scanning = next;
      if (next) {
        mode = "view";
      }
      render();
    },
  };
}
