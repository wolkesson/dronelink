import { PairingSession } from "./core/PairingSession.js";
import { WebRtcSessionManager } from "./core/WebRtcSessionManager.js";
import { WebSerialTransport } from "./transport/WebSerialTransport.js";
import { LinkActivityTracker } from "./ui/LinkActivityTracker.js";

const app = document.getElementById("app");
if (app) {
  const session = new PairingSession();
  const sessionManager = new WebRtcSessionManager();
  const activityTracker = new LinkActivityTracker();
  let transport: WebSerialTransport | null = null;

  app.innerHTML = `
    <main>
      <h1>DroneLink pairing</h1>
      <p>Paste the pairing bundle JSON printed by <code>/ground</code>.</p>
      <textarea id="pairing-bundle" rows="12" cols="80" placeholder='{"sessionId":"...","token":"...","host":"localhost","port":8443,"certFingerprint":"AA:BB:..."}'></textarea>
      <div>
        <button id="pair-button" type="button">Pair</button>
      </div>
      <p id="pairing-state">State: ${session.state}</p>
      <p id="webrtc-state">WebRTC: ${sessionManager.state}</p>
      <p id="pairing-error" role="alert"></p>
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

  const input = app.querySelector<HTMLTextAreaElement>("#pairing-bundle");
  const button = app.querySelector<HTMLButtonElement>("#pair-button");
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
  button?.addEventListener("click", async () => {
    if (!input) {
      return;
    }

    render();

    try {
      await session.pair(input.value);
      render();

      const socket = session.socket;
      if (!socket) {
        throw new Error("Socket unexpectedly null after pairing.");
      }

      await sessionManager.connect(socket);
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
  });

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
