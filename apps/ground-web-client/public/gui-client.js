const status = document.getElementById("status");
const video = document.getElementById("live-video");
const qualitySelect = document.getElementById("quality-select");
const cameraSelect = document.getElementById("camera-select");
const flipHorizontalCheckbox = document.getElementById("flip-horizontal");
const flipVerticalCheckbox = document.getElementById("flip-vertical");
const rotationLabel = document.getElementById("rotation-label");
const rotateLeftButton = document.getElementById("rotate-left");
const rotateRightButton = document.getElementById("rotate-right");
let currentRotation = 0;
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
    } else if (message.type === "video-control-state" && message.control === "camera-source-list") {
      populateCameraOptions(Array.isArray(message.devices) ? message.devices : [], message.activeDeviceId ?? "");
    } else if (message.type === "video-control-state" && message.control === "camera-source") {
      if (message.ok) {
        setStatus("Camera source switched");
      } else {
        setStatus(`Camera switch failed: ${message.error ?? "unknown error"}`);
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

function populateCameraOptions(devices, activeDeviceId) {
  const previousValue = cameraSelect.value;
  cameraSelect.replaceChildren(
    ...devices.map((device) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label || device.deviceId;
      return option;
    }),
  );
  cameraSelect.disabled = devices.length === 0;
  const nextValue = activeDeviceId || previousValue;
  if (devices.some((device) => device.deviceId === nextValue)) {
    cameraSelect.value = nextValue;
  }
}

cameraSelect.addEventListener("change", () => {
  if (socket.readyState === WebSocket.OPEN && cameraSelect.value) {
    socket.send(
      JSON.stringify({ type: "video-control-request", control: "camera-source", deviceId: cameraSelect.value }),
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
