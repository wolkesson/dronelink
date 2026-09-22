const status = document.getElementById("status");
const video = document.getElementById("live-video");
const qualitySelect = document.getElementById("quality-select");
const cameraSelect = document.getElementById("camera-select");
const cameraSetDefaultButton = document.getElementById("camera-set-default");
const airBattery = document.getElementById("air-battery");
const airDataUsage = document.getElementById("air-data-usage");
const flipHorizontalCheckbox = document.getElementById("flip-horizontal");
const flipVerticalCheckbox = document.getElementById("flip-vertical");
const zoomFillCheckbox = document.getElementById("zoom-fill");
const rotationLabel = document.getElementById("rotation-label");
const rotateLeftButton = document.getElementById("rotate-left");
const rotateRightButton = document.getElementById("rotate-right");
let currentRotation = 0;
let currentDefaultDeviceId = "";
const signalingUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/gui-signaling`;
const socket = new WebSocket(signalingUrl);
const peerConnection = new RTCPeerConnection();
const pendingCandidates = [];
let remoteDescriptionSet = false;

function setStatus(message) {
  status.textContent = message;
}

async function addRemoteCandidate(candidate) {
  if (!remoteDescriptionSet) {
    pendingCandidates.push(candidate);
    return;
  }
  await peerConnection.addIceCandidate(candidate);
}

peerConnection.onicecandidate = (event) => {
  if (event.candidate && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "ice-candidate", candidate: event.candidate.toJSON() }));
  }
};

peerConnection.ontrack = (event) => {
  video.srcObject = event.streams[0] ?? new MediaStream([event.track]);
  void video.play().catch(() => undefined);
  setStatus("Live video connected");
};

peerConnection.onconnectionstatechange = () => {
  if (peerConnection.connectionState === "failed" || peerConnection.connectionState === "closed") {
    setStatus(`Video connection ${peerConnection.connectionState}`);
  }
};

socket.onopen = async () => {
  try {
    peerConnection.addTransceiver("video", { direction: "recvonly" });
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.send(JSON.stringify({ type: "offer", sdp: offer.sdp }));
    setStatus("Waiting for incoming video");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Failed to start video connection");
  }
};

socket.onmessage = async (event) => {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }

  try {
    if (message.type === "answer" && typeof message.sdp === "string") {
      await peerConnection.setRemoteDescription({ type: "answer", sdp: message.sdp });
      remoteDescriptionSet = true;
      while (pendingCandidates.length > 0) {
        await peerConnection.addIceCandidate(pendingCandidates.shift());
      }
    } else if (message.type === "ice-candidate" && message.candidate) {
      await addRemoteCandidate(message.candidate);
    } else if (message.type === "video-control-state" && message.control === "quality") {
      qualitySelect.value = message.preset;
      setStatus(message.videoActive ? "Live video connected" : "Live video paused (data-only mode)");
    } else if (message.type === "air-status") {
      renderAirBattery(message.battery);
      renderAirDataUsage(message.dataUsage);
    } else if (message.type === "video-control-state" && message.control === "camera-source-list") {
      currentDefaultDeviceId = message.defaultDeviceId ?? "";
      populateCameraOptions(Array.isArray(message.devices) ? message.devices : [], message.activeDeviceId ?? "");
      // Each camera can have its own saved flip/rotation, so a switch (however it
      // was triggered) can change these out from under checkboxes/a label that
      // otherwise only update on a direct flip/rotate ack -- resync them here.
      if (message.activeTransform) {
        flipHorizontalCheckbox.checked = Boolean(message.activeTransform.horizontal);
        flipVerticalCheckbox.checked = Boolean(message.activeTransform.vertical);
        currentRotation = message.activeTransform.rotation;
        rotationLabel.textContent = `${currentRotation}°`;
      }
    } else if (message.type === "video-control-state" && message.control === "camera-source") {
      if (message.ok) {
        setStatus("Camera source switched");
      } else {
        setStatus(`Camera switch failed: ${message.error ?? "unknown error"}`);
      }
    } else if (message.type === "video-control-state" && message.control === "camera-set-default") {
      if (message.ok) {
        currentDefaultDeviceId = message.deviceId;
        relabelCameraOptions();
        setStatus("Default camera saved");
      } else {
        setStatus(`Set default camera failed: ${message.error ?? "unknown error"}`);
      }
    } else if (message.type === "video-control-state" && message.control === "flip") {
      if (message.ok) {
        flipHorizontalCheckbox.checked = Boolean(message.horizontal);
        flipVerticalCheckbox.checked = Boolean(message.vertical);
        setStatus("Video flip updated");
      } else {
        setStatus(`Flip request failed: ${message.error ?? "unknown error"}`);
      }
    } else if (message.type === "video-control-state" && message.control === "rotate") {
      if (message.ok) {
        currentRotation = message.degrees;
        rotationLabel.textContent = `${currentRotation}°`;
        setStatus("Video rotation updated");
      } else {
        setStatus(`Rotate request failed: ${message.error ?? "unknown error"}`);
      }
    } else if (message.type === "error" && typeof message.message === "string") {
      setStatus(message.message);
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Video signaling failed");
  }
};

socket.onclose = () => {
  if (peerConnection.connectionState !== "connected") {
    setStatus("Video signaling disconnected");
  }
  peerConnection.close();
};

qualitySelect.addEventListener("change", () => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(
      JSON.stringify({ type: "video-control-request", control: "quality", preset: qualitySelect.value }),
    );
  }
});

let lastCameraDevices = [];

function optionLabel(device) {
  const label = device.label || device.deviceId;
  return device.deviceId === currentDefaultDeviceId ? `${label} (default)` : label;
}

// Re-applies option text (e.g. the "(default)" suffix) without touching the device
// list or the current selection -- used after a set-default ack, which changes
// which device is the default but not what's plugged in or selected.
function relabelCameraOptions() {
  [...cameraSelect.options].forEach((option, i) => {
    const device = lastCameraDevices[i];
    if (device) option.textContent = optionLabel(device);
  });
}

const BATTERY_LOW_PERCENT = 20;
const BATTERY_CRITICAL_PERCENT = 10;

function renderAirBattery(battery) {
  if (!battery || typeof battery.percent !== "number") {
    airBattery.textContent = "Air unit battery: unknown";
    airBattery.dataset.level = "unknown";
    airBattery.style.color = "";
    return;
  }
  const charging = battery.charging === true;
  const percent = Math.round(battery.percent);
  let level = "ok";
  if (!charging && percent <= BATTERY_CRITICAL_PERCENT) level = "critical";
  else if (!charging && percent <= BATTERY_LOW_PERCENT) level = "low";
  airBattery.dataset.level = level;
  airBattery.style.color = level === "critical" ? "#c62828" : level === "low" ? "#ef6c00" : "";
  const warning = level === "critical" ? " — CRITICAL, land now" : level === "low" ? " — low" : "";
  airBattery.textContent = `Air unit battery: ${percent}%${charging ? " (charging)" : ""}${warning}`;
}

let lastDataSample = null;

function formatBytes(bytes) {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// The air unit reports cumulative session totals; the current rate is the delta
// between successive samples over the time they arrived.
function renderAirDataUsage(usage) {
  if (!usage || typeof usage.txBytes !== "number" || typeof usage.rxBytes !== "number") {
    lastDataSample = null;
    airDataUsage.textContent = "Air unit data: unknown";
    return;
  }
  const now = performance.now();
  const total = usage.txBytes + usage.rxBytes;
  let rateText = "—";
  if (lastDataSample && now > lastDataSample.at && total >= lastDataSample.total) {
    const perSecond = ((total - lastDataSample.total) * 1000) / (now - lastDataSample.at);
    rateText = `${formatBytes(perSecond)}/s`;
  }
  lastDataSample = { at: now, total };
  airDataUsage.textContent =
    `Air unit data: ${rateText} now, ${formatBytes(total)} this session ` +
    `(↑ ${formatBytes(usage.txBytes)}, ↓ ${formatBytes(usage.rxBytes)})`;
}

function populateCameraOptions(devices, activeDeviceId) {
  const previousValue = cameraSelect.value;
  lastCameraDevices = devices;
  cameraSelect.replaceChildren(
    ...devices.map((device) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = optionLabel(device);
      return option;
    }),
  );
  cameraSelect.disabled = devices.length === 0;
  const nextValue = activeDeviceId || previousValue;
  if (devices.some((device) => device.deviceId === nextValue)) {
    cameraSelect.value = nextValue;
  }
  cameraSetDefaultButton.disabled = !cameraSelect.value;
}

cameraSelect.addEventListener("change", () => {
  cameraSetDefaultButton.disabled = !cameraSelect.value;
  if (socket.readyState === WebSocket.OPEN && cameraSelect.value) {
    socket.send(
      JSON.stringify({ type: "video-control-request", control: "camera-source", deviceId: cameraSelect.value }),
    );
  }
});

cameraSetDefaultButton.addEventListener("click", () => {
  if (socket.readyState === WebSocket.OPEN && cameraSelect.value) {
    socket.send(
      JSON.stringify({
        type: "video-control-request",
        control: "camera-set-default",
        deviceId: cameraSelect.value,
      }),
    );
  }
});

function sendFlipRequest() {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(
      JSON.stringify({
        type: "video-control-request",
        control: "flip",
        horizontal: flipHorizontalCheckbox.checked,
        vertical: flipVerticalCheckbox.checked,
      }),
    );
  }
}

flipHorizontalCheckbox.addEventListener("change", sendFlipRequest);
flipVerticalCheckbox.addEventListener("change", sendFlipRequest);

// Purely a local playback preference (how this viewer's <video> box renders the
// stream it's already receiving) -- unlike flip/rotate, there's nothing for air
// to apply and nothing to send over the wire.
zoomFillCheckbox.addEventListener("change", () => {
  video.style.objectFit = zoomFillCheckbox.checked ? "cover" : "contain";
});

function sendRotateRequest(degrees) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "video-control-request", control: "rotate", degrees }));
  }
}

rotateLeftButton.addEventListener("click", () => {
  sendRotateRequest((currentRotation + 270) % 360);
});
rotateRightButton.addEventListener("click", () => {
  sendRotateRequest((currentRotation + 90) % 360);
});
