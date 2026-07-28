import { PairingSession } from "./core/PairingSession.js";
import { WebRtcSessionManager } from "./core/WebRtcSessionManager.js";
import { WebSerialTransport } from "./transport/WebSerialTransport.js";

const app = document.getElementById("app");
if (app) {
  const session = new PairingSession();
  const sessionManager = new WebRtcSessionManager();
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
    // open() must be called synchronously inside this handler because requestPort()
    // requires a transient user activation that expires after the first await.
    const t = new WebSerialTransport();
    void t
      .open()
      .then(() => {
        transport = t;
        transport.subscribe((bytes) => {
          sessionManager.sendBytes(bytes);
        });
        sessionManager.subscribe((bytes) => {
          void transport?.write(bytes);
        });
        if (fcStateEl) {
          fcStateEl.textContent = "FC connected";
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
