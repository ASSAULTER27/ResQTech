const API_BASE_URL = "https://resqtech-k5xd.onrender.com";

const map = L.map("map").setView([22.2587, 71.1924], 7);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap contributors",
}).addTo(map);

let markers = [];
let lastRenderedAlertsCount = -1;

function priority(score) {
  if (score >= 0.8) return "HIGH";
  if (score >= 0.55) return "MEDIUM";
  return "LOW";
}

function rescueIcon(score) {
  let color = "#10b981";

  if (score >= 0.8) color = "#ef4444";
  else if (score >= 0.55) color = "#f59e0b";

  return L.divIcon({
    className: "",
    html: `
      <div style="
        width: 18px;
        height: 18px;
        background: ${color};
        border: 2px solid #070a13;
        border-radius: 50%;
        box-shadow: 0 0 12px ${color}, 0 0 4px ${color};
      "></div>
    `,
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  });
}

function toggleSourceType() {
  const type = document.getElementById("sourceType").value;
  if (type === "file") {
    document.getElementById("fileInputContainer").style.display = "flex";
    document.getElementById("rtspInputContainer").style.display = "none";
  } else {
    document.getElementById("fileInputContainer").style.display = "none";
    document.getElementById("rtspInputContainer").style.display = "flex";
  }
}

async function startDetection() {
  const type = document.getElementById("sourceType").value;
  const formData = new FormData();

  if (type === "file") {
    const fileInput = document.getElementById("video");
    if (!fileInput.files || fileInput.files.length === 0) {
      document.getElementById("message").textContent = "Please upload a video file first.";
      return;
    }
    formData.append("video", fileInput.files[0]);
    document.getElementById("message").textContent = "Uploading video and starting detection...";
  } else {
    const rtspInput = document.getElementById("rtsp");
    if (!rtspInput.value.trim()) {
      document.getElementById("message").textContent = "Please enter an RTSP Stream URL.";
      return;
    }
    formData.append("rtsp_url", rtspInput.value.trim());
    document.getElementById("message").textContent = "Connecting to RTSP live stream and starting detection...";
  }

  formData.append("base_latitude", document.getElementById("lat").value);
  formData.append("base_longitude", document.getElementById("lon").value);
  formData.append("altitude_m", document.getElementById("alt").value);
  formData.append("confidence", document.getElementById("conf").value);

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
  const countChanged = alerts.length !== lastRenderedAlertsCount;
  
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
    lastRenderedAlertsCount = 0;
    return;
  }

  [...alerts].reverse().forEach((alert) => {
    const alertPriority = priority(alert.triage_score);

    const marker = L.marker(
      [alert.latitude, alert.longitude],
      { icon: rescueIcon(alert.triage_score) }
    ).addTo(map);

    const errorRadius = alert.triage_factors.estimated_location_error_m || 0;
    const recBadge = alert.triage_factors.face_recognized 
      ? '<span style="color:#7ee787;font-weight:bold;">[Face Recognized]</span>' 
      : (alert.triage_factors.reid_matched ? '<span style="color:#38bdf8;font-weight:bold;">[Re-ID Verified]</span>' : '<span style="color:#fbbf24;">[Victim Identified]</span>');

    marker.bindPopup(`
      <b>Victim #${alert.id} (${alertPriority})</b> ${recBadge}<br>
      Location: ${alert.latitude.toFixed(6)}, ${alert.longitude.toFixed(6)} (±${errorRadius}m)<br>
      Posture: ${alert.triage_factors.posture || 'Unknown'}<br>
      Belongings: ${alert.triage_factors.belongings_detected && alert.triage_factors.belongings_detected.length > 0 ? alert.triage_factors.belongings_detected.join(', ') : 'None'}<br>
      Cluster: ${alert.triage_factors.cluster_size > 0 ? (alert.triage_factors.cluster_size + ' nearby') : 'Solo'}
    `);

    markers.push(marker);

    const item = document.createElement("div");
    item.className = `card ${alertPriority.toLowerCase()}`;

    const belongingsStr = alert.triage_factors.belongings_detected && alert.triage_factors.belongings_detected.length > 0 
      ? alert.triage_factors.belongings_detected.join(', ') 
      : 'None';
    const clusterStr = alert.triage_factors.cluster_size > 0 
      ? `${alert.triage_factors.cluster_size} nearby` 
      : 'Solo';

    item.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <b>Victim #${alert.id} — ${alertPriority}</b>
        <small>${recBadge}</small>
      </div>
      <small>${new Date(alert.created_at).toLocaleString()}</small><br>
      Location: ${alert.latitude.toFixed(6)}, ${alert.longitude.toFixed(6)} (±${errorRadius}m)<br>
      Posture: ${alert.triage_factors.posture || 'Unknown'}<br>
      Belongings: ${belongingsStr}<br>
      Cluster: ${clusterStr}<br>
      Triage Score: ${alert.triage_score}
    `;

    list.appendChild(item);
  });

  const autoCenterChecked = document.getElementById("autocenter") ? document.getElementById("autocenter").checked : true;
  if (markers.length > 0 && countChanged && autoCenterChecked) {
    map.fitBounds(L.featureGroup(markers).getBounds().pad(0.2));
  }
  
  lastRenderedAlertsCount = alerts.length;
}

async function refresh() {
  try {
    const [alerts, status] = await Promise.all([
      fetch(`${API_BASE_URL}/api/alerts`).then((response) => response.json()),
      fetch(`${API_BASE_URL}/api/status`).then((response) => response.json()),
    ]);

    const statusElement = document.getElementById("status");
    const frameImg = document.getElementById("frame");

    if (status.running) {
      statusElement.textContent = "● DETECTION RUNNING";
      statusElement.style.color = "#7ee787";
      const streamUrl = `${API_BASE_URL}/api/stream`;

      // Check if image fails to load via MJPEG stream (common on Cloud proxies like Render)
      if (!frameImg.src || (!frameImg.src.includes("/api/stream") && !frameImg.src.startsWith("data:image"))) {
        frameImg.src = streamUrl;
      }

      // Base64 frame fallback polling for Render/Cloud proxy compatibility
      fetch(`${API_BASE_URL}/api/frame`)
        .then(res => res.json())
        .then(frameData => {
          if (frameData && frameData.image_b64) {
            frameImg.src = "data:image/jpeg;base64," + frameData.image_b64;
          }
        })
        .catch(() => {});
    } else {
      statusElement.textContent = "● READY";
      statusElement.style.color = "#b8e9c8";
      if (frameImg.src.includes("/api/stream") || frameImg.src.startsWith("data:image")) {
        frameImg.src = "";
      }
    }

    if (status.error) {
      statusElement.textContent = "● ERROR";
      statusElement.style.color = "#ff9595";
      document.getElementById("message").textContent = status.error;
    }

    renderAlerts(alerts);
  } catch (error) {
    document.getElementById("status").textContent = "● SERVER OFFLINE";
    document.getElementById("status").style.color = "#ff9595";
  }
}

setInterval(refresh, 800);
refresh();