// CHANGE THIS URL to your deployed Render URL (e.g. "https://resqtech-backend.onrender.com")
// For local development with Vercel frontend, you might need "http://127.0.0.1:8000"
const API_BASE_URL = ""; 

const map = L.map("map").setView([20.5937, 78.9629], 5);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap",
}).addTo(map);

let markers = [];

function priority(score) {
  if (score >= 0.8) return "HIGH";
  if (score >= 0.55) return "MEDIUM";
  return "LOW";
}

function rescueIcon(score) {
  let color = "#1778bd";

  if (score >= 0.8) color = "#dc2626";
  else if (score >= 0.55) color = "#f59e0b";

  return L.divIcon({
    className: "",
    html: `
      <div style="
        width:22px;
        height:22px;
        background:${color};
        border:3px solid white;
        border-radius:50%;
        box-shadow:0 1px 5px #333;
      "></div>
    `,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

async function startDetection() {
  const fileInput = document.getElementById("video");
  if (!fileInput.files || fileInput.files.length === 0) {
    document.getElementById("message").textContent = "Please upload a video file first.";
    return;
  }

  const formData = new FormData();
  formData.append("video", fileInput.files[0]);
  formData.append("base_latitude", document.getElementById("lat").value);
  formData.append("base_longitude", document.getElementById("lon").value);
  formData.append("altitude_m", document.getElementById("alt").value);
  formData.append("confidence", 0.45);

  document.getElementById("message").textContent = "Uploading video and starting detection...";

  const response = await fetch(`${API_BASE_URL}/api/start`, {
    method: "POST",
    body: formData,
  });

  const result = await response.json();
  document.getElementById("message").textContent = result.message;

  if (result.ok) {
    map.setView([
      Number(document.getElementById("lat").value),
      Number(document.getElementById("lon").value)
    ], 17);
  }
}

async function stopDetection() {
  const response = await fetch(`${API_BASE_URL}/api/stop`, {
    method: "POST",
  });

  const result = await response.json();
  document.getElementById("message").textContent = result.message;
}

function renderAlerts(alerts) {
  document.getElementById("total").textContent = alerts.length;

  document.getElementById("high").textContent = alerts.filter(
    (alert) => alert.triage_score >= 0.8
  ).length;

  document.getElementById("people").textContent = alerts.reduce(
    (count, alert) =>
      count +
      alert.detections.filter(
        (detection) => detection.object_type === "person"
      ).length,
    0
  );

  markers.forEach((marker) => map.removeLayer(marker));
  markers = [];

  const list = document.getElementById("list");
  list.innerHTML = "";

  if (alerts.length === 0) {
    list.textContent = "No alerts yet.";
    return;
  }

  [...alerts].reverse().forEach((alert) => {
    const alertPriority = priority(alert.triage_score);

    const marker = L.marker(
      [alert.latitude, alert.longitude],
      { icon: rescueIcon(alert.triage_score) }
    ).addTo(map);

    marker.bindPopup(`
      <b>Alert #${alert.id}</b><br>
      Priority: ${alertPriority}<br>
      Location: ${alert.latitude.toFixed(6)}, ${alert.longitude.toFixed(6)}
    `);

    markers.push(marker);

    const item = document.createElement("div");
    item.className = `card ${alertPriority.toLowerCase()}`;

    item.innerHTML = `
      <b>Alert #${alert.id} — ${alertPriority}</b><br>
      <small>${new Date(alert.created_at).toLocaleString()}</small><br>
      Location: ${alert.latitude.toFixed(6)}, ${alert.longitude.toFixed(6)}<br>
      People: ${alert.detections.length}<br>
      Confidence: ${alert.detections[0].confidence}<br>
      Triage Score: ${alert.triage_score}
    `;

    list.appendChild(item);
  });

  if (markers.length > 0) {
    map.fitBounds(L.featureGroup(markers).getBounds().pad(0.2));
  }
}

async function refresh() {
  try {
    const [alerts, status, frame] = await Promise.all([
      fetch(`${API_BASE_URL}/api/alerts`).then((response) => response.json()),
      fetch(`${API_BASE_URL}/api/status`).then((response) => response.json()),
      fetch(`${API_BASE_URL}/api/frame`).then((response) => response.json()),
    ]);

    const statusElement = document.getElementById("status");

    if (status.running) {
      statusElement.textContent = "● DETECTION RUNNING";
      statusElement.style.color = "#7ee787";
    } else {
      statusElement.textContent = "● READY";
      statusElement.style.color = "#b8e9c8";
    }

    if (status.error) {
      statusElement.textContent = "● ERROR";
      statusElement.style.color = "#ff9595";
      document.getElementById("message").textContent = status.error;
    }

    if (frame.image_b64) {
      document.getElementById("frame").src =
        "data:image/jpeg;base64," + frame.image_b64;
    }

    renderAlerts(alerts);
  } catch (error) {
    document.getElementById("status").textContent = "● SERVER OFFLINE";
    document.getElementById("status").style.color = "#ff9595";
  }
}

setInterval(refresh, 1200);
refresh();