const status = document.getElementById("status");
const video = document.getElementById("live-video");
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
