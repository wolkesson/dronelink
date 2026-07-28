import { PairingSession } from "./core/PairingSession.js";

const app = document.getElementById("app");
if (app) {
  const session = new PairingSession();

  app.innerHTML = `
    <main>
      <h1>DroneLink pairing</h1>
      <p>Paste the pairing bundle JSON printed by <code>/ground</code>.</p>
      <textarea id="pairing-bundle" rows="12" cols="80" placeholder='{"sessionId":"...","token":"...","host":"localhost","port":8443,"certFingerprint":"AA:BB:..."}'></textarea>
      <div>
        <button id="pair-button" type="button">Pair</button>
      </div>
      <p id="pairing-state">State: ${session.state}</p>
      <p id="pairing-error" role="alert"></p>
    </main>
  `;

  const input = app.querySelector<HTMLTextAreaElement>("#pairing-bundle");
  const button = app.querySelector<HTMLButtonElement>("#pair-button");
  const state = app.querySelector<HTMLParagraphElement>("#pairing-state");
  const error = app.querySelector<HTMLParagraphElement>("#pairing-error");

  const render = () => {
    if (state) {
      state.textContent = `State: ${session.state}`;
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
    } catch (pairError: unknown) {
      if (error) {
        error.textContent =
          pairError instanceof Error ? pairError.message : "Pairing failed unexpectedly.";
      }
    } finally {
      render();
    }
  });
}
