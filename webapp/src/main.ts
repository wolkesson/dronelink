import { PairingSession } from "./core/PairingSession.js";
import { QrPairingScanner } from "./core/QrPairingScanner.js";
import { WebRtcSessionManager } from "./core/WebRtcSessionManager.js";
import { WebSerialTransport } from "./transport/WebSerialTransport.js";
import { LinkActivityTracker } from "./ui/LinkActivityTracker.js";

const app = document.getElementById("app");
if (app) {
  const session = new PairingSession();
  const sessionManager = new WebRtcSessionManager();
  const activityTracker = new LinkActivityTracker();
  let transport: WebSerialTransport | null = null;
  let videoStream: MediaStream | null = null;

  app.innerHTML = `
    <main>
      <h1>DroneLink</h1>

      <section id="video-source-section">
        <h2>Video source</h2>
        <select id="camera-select">
          <option value="">No video</option>
        </select>
        <div id="video-preview-container" hidden>
          <video id="preview-video" autoplay playsinline muted style="max-width:100%"></video>
        </div>
      </section>

      <section>
        <h2>Pairing</h2>
        <p>Paste the pairing bundle JSON printed by <code>/ground</code>, or scan its QR code.</p>
        <textarea id="pairing-bundle" rows="12" cols="80" placeholder='{"sessionId":"...","token":"...","host":"localhost","port":8443,"certFingerprint":"AA:BB:..."}'></textarea>
        <div>
          <button id="pair-button" type="button">Pair</button>
          ${QrPairingScanner.isSupported() ? '<button id="scan-qr-button" type="button">Scan QR</button>' : ""}
        </div>
        <div id="qr-scanner" hidden>
          <video id="qr-video" autoplay playsinline style="max-width:100%"></video>
          <div><button id="cancel-scan-button" type="button">Cancel</button></div>
        </div>
        <p id="pairing-state">State: ${session.state}</p>
        <p id="webrtc-state">WebRTC: ${sessionManager.state}</p>
        <p id="pairing-error" role="alert"></p>
      </section>

      <div id="fc-section" hidden>
        <button id="connect-fc-button" type="button">Connect FC</button>
        <p id="fc-state"></p>
        <div id="link-status" hidden>
          <p><strong>Link activity</strong> (modem LEDs)</p>
          <p><span id="tx-led">⚫ TX (FC→Ground)</span> · <span id="rx-led">⚫ RX (Ground→FC)</span></p>
          <p id="link-counters">TX 0 bytes (FC→Ground) · RX 0 bytes (Ground→FC)</p>
        </div>
      </div>
    </main>
  `;

  const cameraSelect = app.querySelector<HTMLSelectElement>("#camera-select");
  const videoPreviewContainer = app.querySelector<HTMLDivElement>("#video-preview-container");
  const previewVideoEl = app.querySelector<HTMLVideoElement>("#preview-video");

  const input = app.querySelector<HTMLTextAreaElement>("#pairing-bundle");
  const button = app.querySelector<HTMLButtonElement>("#pair-button");
  const scanQrButton = app.querySelector<HTMLButtonElement>("#scan-qr-button");
  const qrScannerEl = app.querySelector<HTMLDivElement>("#qr-scanner");
  const qrVideoEl = app.querySelector<HTMLVideoElement>("#qr-video");
  const cancelScanButton = app.querySelector<HTMLButtonElement>("#cancel-scan-button");
  const stateEl = app.querySelector<HTMLParagraphElement>("#pairing-state");
  const webrtcStateEl = app.querySelector<HTMLParagraphElement>("#webrtc-state");
  const error = app.querySelector<HTMLParagraphElement>("#pairing-error");
  const fcSection = app.querySelector<HTMLDivElement>("#fc-section");
  const connectFcButton = app.querySelector<HTMLButtonElement>("#connect-fc-button");
  const fcStateEl = app.querySelector<HTMLParagraphElement>("#fc-state");
  const linkStatusEl = app.querySelector<HTMLDivElement>("#link-status");
  const txLedEl = app.querySelector<HTMLSpanElement>("#tx-led");
  const rxLedEl = app.querySelector<HTMLSpanElement>("#rx-led");
  const linkCountersEl = app.querySelector<HTMLParagraphElement>("#link-counters");

  // --- Video source setup ---

  const stopVideoStream = () => {
    if (videoStream) {
      videoStream.getTracks().forEach((t) => t.stop());
      videoStream = null;
    }
    if (previewVideoEl) {
      previewVideoEl.srcObject = null;
    }
    if (videoPreviewContainer) {
      videoPreviewContainer.hidden = true;
    }
  };

  const populateCameraList = async () => {
    if (!cameraSelect) return;

    // Throwaway getUserMedia call to unlock device labels, then stop immediately.
    try {
      const unlock = await navigator.mediaDevices.getUserMedia({ video: true });
      unlock.getTracks().forEach((t) => t.stop());
    } catch {
      // Permission denied or no camera — keep "No video" as the only option.
      return;
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices.filter((d) => d.kind === "videoinput");
    let cameraIndex = 1;
    for (const device of videoInputs) {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label || `Camera ${cameraIndex}`;
      cameraSelect.appendChild(option);
      cameraIndex++;
    }
  };

  void populateCameraList();

  cameraSelect?.addEventListener("change", () => {
    const deviceId = cameraSelect.value;
    stopVideoStream();
    if (!deviceId) return;

    void navigator.mediaDevices
      .getUserMedia({
        video: { deviceId: { exact: deviceId }, width: { ideal: 320 }, height: { ideal: 240 } },
      })
      .then((stream) => {
        videoStream = stream;
        if (previewVideoEl) {
          previewVideoEl.srcObject = stream;
        }
        if (videoPreviewContainer) {
          videoPreviewContainer.hidden = false;
        }
      })
      .catch((err: unknown) => {
        if (error) {
          error.textContent =
            err instanceof Error ? err.message : "Failed to open camera.";
        }
      });
  });

  // --- Pairing UI ---

  const render = () => {
    if (stateEl) {
      stateEl.textContent = `State: ${session.state}`;
    }

    if (webrtcStateEl) {
      webrtcStateEl.textContent = `WebRTC: ${sessionManager.state}`;
    }

    if (error) {
      error.textContent = session.error ?? "";
    }
  };

  render();

  activityTracker.onChange((snapshot) => {
    if (txLedEl) {
      txLedEl.textContent = `${snapshot.txActive ? "🟢" : "⚫"} TX (FC→Ground)`;
    }
    if (rxLedEl) {
      rxLedEl.textContent = `${snapshot.rxActive ? "🟢" : "⚫"} RX (Ground→FC)`;
    }
    if (linkCountersEl) {
      linkCountersEl.textContent = `TX ${snapshot.txBytes} bytes (FC→Ground) · RX ${snapshot.rxBytes} bytes (Ground→FC)`;
    }
  });

  const attemptPair = async (bundleText: string) => {
    render();

    try {
      await session.pair(bundleText);
      render();

      const socket = session.socket;
      if (!socket) {
        throw new Error("Socket unexpectedly null after pairing.");
      }

      await sessionManager.connect(
        socket,
        (session.bundle?.host ?? "").endsWith(".ts.net"),
        videoStream ?? undefined,
      );
      render();

      if (fcSection) {
        fcSection.hidden = false;
      }
    } catch (pairError: unknown) {
      if (error) {
        error.textContent =
          pairError instanceof Error ? pairError.message : "Pairing or WebRTC setup failed.";
      }
    } finally {
      render();
    }
  };

  button?.addEventListener("click", () => {
    if (!input) {
      return;
    }
    void attemptPair(input.value);
  });

  if (scanQrButton && qrScannerEl && qrVideoEl && cancelScanButton) {
    const scanner = new QrPairingScanner();

    scanQrButton.addEventListener("click", () => {
      qrScannerEl.hidden = false;
      scanQrButton.disabled = true;
      if (button) button.disabled = true;

      if (videoStream && previewVideoEl) {
        // Reuse the already-active camera stream — no second permission prompt.
        void scanner.start(previewVideoEl, (bundleText) => {
          qrScannerEl.hidden = true;
          scanQrButton.disabled = false;
          if (button) button.disabled = false;
          void attemptPair(bundleText);
        }, videoStream);
      } else {
        void scanner.start(qrVideoEl, (bundleText) => {
          qrScannerEl.hidden = true;
          scanQrButton.disabled = false;
          if (button) button.disabled = false;
          void attemptPair(bundleText);
        });
      }
    });

    cancelScanButton.addEventListener("click", () => {
      scanner.stop();
      qrScannerEl.hidden = true;
      scanQrButton.disabled = false;
      if (button) button.disabled = false;
    });
  }

  connectFcButton?.addEventListener("click", () => {
    if (transport) return; // guard against multiple clicks

    // open() must be called synchronously inside this handler because requestPort()
    // requires a transient user activation that expires after the first await.
    const t = new WebSerialTransport();
    void t
      .open()
      .then(() => {
        transport = t;
        if (connectFcButton) connectFcButton.disabled = true;
        let unsubSerial: (() => void) | null = null;
        let unsubWebRtc: (() => void) | null = null;
        let fcDisconnected = false;
        const handleFcDisconnect = () => {
          if (fcDisconnected) {
            return;
          }
          fcDisconnected = true;
          unsubSerial?.();
          unsubSerial = null;
          unsubWebRtc?.();
          unsubWebRtc = null;
          if (fcStateEl) {
            fcStateEl.textContent = "FC disconnected";
          }
          if (linkStatusEl) {
            linkStatusEl.hidden = true;
          }
        };
        unsubSerial = transport.subscribe((bytes) => {
          if (bytes.length === 0) {
            handleFcDisconnect();
            return;
          }
          activityTracker.recordTransmit(bytes.length);
          sessionManager.sendBytes(bytes);
        });
        unsubWebRtc = sessionManager.subscribe((bytes) => {
          activityTracker.recordReceive(bytes.length);
          void transport?.write(bytes);
        });
        if (fcStateEl) {
          fcStateEl.textContent = "FC connected";
        }
        if (linkStatusEl) {
          linkStatusEl.hidden = false;
        }
      })
      .catch((err: unknown) => {
        if (error) {
          error.textContent =
            err instanceof Error ? err.message : "Failed to open serial port.";
        }
      });
  });
}
