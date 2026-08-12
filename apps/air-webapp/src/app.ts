import {
  NATIVE_BRIDGE_PORT_MESSAGE,
  NativeBridgeTransport,
  PairingSession,
  QrPairingScanner,
  SERIAL_BAUD_RATE,
  WebRtcSessionManager,
  WebSerialTransport,
  type SerialTransport,
} from "@dronelink/air-client-sdk";
import { LinkActivityTracker, type LinkActivitySnapshot } from "@dronelink/ui-kit-shared";
import { isAndroidShell } from "./platform.js";
import { createAppHeader } from "./components/AppHeader.js";
import { createVideoFeedPanel } from "./components/VideoFeedPanel.js";
import { createFlightControllerPanel } from "./components/FlightControllerPanel.js";
import { createGroundConnectionPanel } from "./components/GroundConnectionPanel.js";
import { createDisconnectButton } from "./components/DisconnectButton.js";
import { createSessionFooter } from "./components/SessionFooter.js";
import { formatByteRate, formatDuration, formatMbps } from "./format.js";

const METRICS_INTERVAL_MS = 1000;

/** Wires the DroneLink component tree to the air-client-sdk and mounts it into `root`. */
export function mountApp(root: HTMLElement): void {
  const session = new PairingSession();
  const sessionManager = new WebRtcSessionManager();
  const activityTracker = new LinkActivityTracker();
  const qrScanner = new QrPairingScanner();

  let transport: SerialTransport | null = null;
  let videoStream: MediaStream | null = null;
  let connectedAt: number | null = null;
  let metricsTimer: ReturnType<typeof setInterval> | null = null;
  let currentActivity: LinkActivitySnapshot = {
    txBytes: 0,
    rxBytes: 0,
    txActive: false,
    rxActive: false,
  };
  let lastTxBytes = 0;
  let lastRxBytes = 0;
  let txRateText = "0 B/s";
  let rxRateText = "0 B/s";
  let lastRelayBytesSent = 0;

  const header = createAppHeader();

  const videoPanel = createVideoFeedPanel({
    onDeviceChange: (deviceId) => void handleDeviceChange(deviceId),
  });

  const fcPanel = createFlightControllerPanel({
    onConnectRequest: () => handleConnectFc(),
  });

  const groundPanel = createGroundConnectionPanel({
    qrSupported: QrPairingScanner.isSupported(),
    onPair: (bundleText) => void handlePair(bundleText),
    onStartScan: () => handleStartScan(),
    onCancelScan: () => handleCancelScan(),
  });

  const disconnectButton = createDisconnectButton(() => handleDisconnect());
  const footer = createSessionFooter("Not connected");

  root.replaceChildren(
    header.el,
    videoPanel.el,
    fcPanel.el,
    groundPanel.el,
    disconnectButton.el,
    footer.el,
  );

  // --- video source -----------------------------------------------------

  async function populateCameraList(): Promise<void> {
    try {
      const unlock = await navigator.mediaDevices.getUserMedia({ video: true });
      unlock.getTracks().forEach((t) => t.stop());
    } catch {
      return;
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    videoPanel.populateDevices(devices.filter((d) => d.kind === "videoinput"));
  }

  function stopVideoStream(): void {
    if (videoStream) {
      videoStream.getTracks().forEach((t) => t.stop());
      videoStream = null;
    }
    videoPanel.videoEl.srcObject = null;
    videoPanel.setStreaming(false);
    videoPanel.setResolution(null);
    videoPanel.setFps(null);
    videoPanel.setBitrate(null);
  }

  function bindVideoStream(stream: MediaStream): void {
    videoStream = stream;
    videoPanel.videoEl.srcObject = stream;
    videoPanel.setStreaming(true);

    const [track] = stream.getVideoTracks();
    const settings = track?.getSettings();
    if (settings?.height) {
      videoPanel.setResolution(`${settings.height}P`);
    }
    if (settings?.frameRate) {
      videoPanel.setFps(`${Math.round(settings.frameRate)} FPS`);
    }
  }

  async function handleDeviceChange(deviceId: string): Promise<void> {
    stopVideoStream();
    videoPanel.setError("");
    if (!deviceId) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      bindVideoStream(stream);
    } catch (err) {
      videoPanel.setError(err instanceof Error ? err.message : "Failed to open camera.");
    }
  }

  void populateCameraList();

  // --- ground connection / pairing --------------------------------------

  async function handlePair(bundleText: string): Promise<void> {
    groundPanel.setError("");
    groundPanel.setPairing(true);

    try {
      await session.pair(bundleText);

      const socket = session.socket;
      if (!socket) {
        throw new Error("Socket unexpectedly null after pairing.");
      }

      await sessionManager.connect(
        socket,
        (session.bundle?.host ?? "").endsWith(".ts.net"),
        videoStream ?? undefined,
      );

      connectedAt = Date.now();
      lastRelayBytesSent = 0;
      startMetricsLoop();

      header.setConnected(true);
      groundPanel.setConnected(true);
      disconnectButton.el.disabled = false;
      footer.setState("Session active • Encryption secure (AES-256)");
    } catch (err) {
      groundPanel.setError(
        err instanceof Error ? err.message : "Pairing or WebRTC setup failed.",
      );
    } finally {
      groundPanel.setPairing(false);
    }
  }

  // Scanning reuses the video-feed panel's own preview rather than opening a
  // second camera stream: if a camera is already bound, the reticle overlays
  // straight onto it; otherwise a stream is acquired and bound the same way a
  // manual device-dropdown pick would be, so it doubles as the selected feed.
  function handleStartScan(): void {
    const onResult = (bundleText: string) => {
      handleCancelScan();
      void handlePair(bundleText);
    };

    if (videoStream) {
      videoPanel.setScanning(true);
      qrScanner.start(videoPanel.videoEl, videoStream, onResult);
      return;
    }

    void navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: "environment" } } })
      .then((stream) => {
        bindVideoStream(stream);
        videoPanel.setScanning(true);
        qrScanner.start(videoPanel.videoEl, stream, onResult);
      })
      .catch((err: unknown) => {
        groundPanel.setError(err instanceof Error ? err.message : "Camera access denied.");
      });
  }

  function handleCancelScan(): void {
    qrScanner.stop();
    videoPanel.setScanning(false);
  }

  // --- flight controller --------------------------------------------------

  // The native shell may push the MessagePort before "Connect FC" is ever clicked (it's
  // established as soon as the shell's USB bridge is ready), so this listener is wired up
  // unconditionally at mount time rather than inside handleConnectFc — otherwise a port
  // arriving early would have no NativeBridgeTransport yet to hand it to and be lost.
  let nativeBridgeTransport: NativeBridgeTransport | null = null;
  let pendingNativePort: MessagePort | null = null;

  if (isAndroidShell()) {
    window.addEventListener("message", (event) => {
      if (event.data !== NATIVE_BRIDGE_PORT_MESSAGE || event.ports.length === 0) return;
      const [port] = event.ports;
      if (nativeBridgeTransport) {
        nativeBridgeTransport.receivePort(port);
      } else {
        pendingNativePort = port;
      }
    });
  }

  function createSerialTransport(): SerialTransport {
    if (!isAndroidShell()) {
      return new WebSerialTransport();
    }
    const t = new NativeBridgeTransport();
    if (pendingNativePort) {
      t.receivePort(pendingNativePort);
      pendingNativePort = null;
    }
    nativeBridgeTransport = t;
    return t;
  }

  function handleConnectFc(): void {
    if (transport) return;
    fcPanel.setError("");

    // On desktop, open() must be called synchronously here — WebSerialTransport's
    // requestPort() requires a transient user activation that expires after the first
    // await. NativeBridgeTransport has no such requirement (no browser permission API
    // involved), so it's safe to construct here too even though it isn't time-critical.
    const t = createSerialTransport();
    fcPanel.setConnecting(true);

    void t
      .open()
      .then(() => {
        transport = t;
        fcPanel.setConnecting(false);
        fcPanel.setConnected(true);
        fcPanel.setBaudRate(`${SERIAL_BAUD_RATE}`);

        let fcDisconnected = false;
        const handleFcDisconnect = () => {
          if (fcDisconnected) return;
          fcDisconnected = true;
          unsubSerial();
          unsubWebRtc();
          transport = null;
          fcPanel.setConnected(false);
        };

        const unsubSerial = t.subscribe((bytes) => {
          if (bytes.length === 0) {
            handleFcDisconnect();
            return;
          }
          // The FC can now be connected before the ground station is paired, so bytes
          // may arrive with no data channel to relay them over yet -- sendBytes() throws
          // in that case. Drop them rather than crash the serial read loop; there's
          // nothing meaningful to buffer towards (MSP telemetry is a live stream, not a
          // queue), so relaying resumes cleanly once the ground link comes up.
          if (sessionManager.state !== "CONNECTED") return;
          activityTracker.recordTransmit(bytes.length);
          sessionManager.sendBytes(bytes);
        });
        const unsubWebRtc = sessionManager.subscribe((bytes) => {
          activityTracker.recordReceive(bytes.length);
          void transport?.write(bytes);
        });
      })
      .catch((err: unknown) => {
        fcPanel.setConnecting(false);
        fcPanel.setError(err instanceof Error ? err.message : "Failed to open serial port.");
      });
  }

  // Fires on every chunk transmitted/received — used to flash the TX/RX tone
  // immediately, while the numeric rate itself is refreshed once per second below.
  activityTracker.onChange((snapshot) => {
    currentActivity = snapshot;
    fcPanel.setTxRate(txRateText, snapshot.txActive);
    fcPanel.setRxRate(rxRateText, snapshot.rxActive);
  });

  // --- periodic link metrics (uptime, latency, throughput) ---------------

  function startMetricsLoop(): void {
    stopMetricsLoop();
    metricsTimer = setInterval(() => void tickMetrics(), METRICS_INTERVAL_MS);
    void tickMetrics();
  }

  function stopMetricsLoop(): void {
    if (metricsTimer !== null) {
      clearInterval(metricsTimer);
      metricsTimer = null;
    }
  }

  async function tickMetrics(): Promise<void> {
    // Byte-rate sampling for the FC panel: LinkActivityTracker only tracks
    // cumulative totals, so the per-second rate is derived from the delta here.
    txRateText = formatByteRate(Math.max(0, currentActivity.txBytes - lastTxBytes));
    rxRateText = formatByteRate(Math.max(0, currentActivity.rxBytes - lastRxBytes));
    lastTxBytes = currentActivity.txBytes;
    lastRxBytes = currentActivity.rxBytes;
    fcPanel.setTxRate(txRateText, currentActivity.txActive);
    fcPanel.setRxRate(rxRateText, currentActivity.rxActive);

    if (connectedAt !== null) {
      groundPanel.setUptime(formatDuration(Date.now() - connectedAt));
    }

    const metrics = await sessionManager.getConnectionMetrics();
    if (!metrics) return;

    groundPanel.setLatency(metrics.rttMs !== null ? `${Math.round(metrics.rttMs)} ms` : "—");

    const deltaSent = Math.max(0, metrics.bytesSent - lastRelayBytesSent);
    lastRelayBytesSent = metrics.bytesSent;
    const throughputText = `${formatMbps(deltaSent)} (Up)`;
    groundPanel.setThroughput(throughputText);
    if (videoStream) {
      videoPanel.setBitrate(formatMbps(deltaSent));
    }
  }

  // --- disconnect ----------------------------------------------------------

  async function handleDisconnect(): Promise<void> {
    disconnectButton.el.disabled = true;
    stopMetricsLoop();
    connectedAt = null;
    lastRelayBytesSent = 0;

    if (transport) {
      await transport.close();
      transport = null;
    }
    sessionManager.disconnect();
    session.socket?.close(1000, "client disconnect");

    header.setConnected(false);
    fcPanel.setConnected(false);
    fcPanel.setError("");
    groundPanel.setConnected(false);
    groundPanel.setMode("binding");
    groundPanel.setLatency("—");
    groundPanel.setThroughput("—");
    groundPanel.setUptime("00:00:00");
    videoPanel.setBitrate(null);
    footer.setState("Not connected");
  }
}
