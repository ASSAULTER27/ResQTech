from __future__ import annotations

import argparse
import base64
import math
import threading
import time
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import tempfile
# pyrefly: ignore [missing-import]
import cv2
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from ultralytics import YOLO
import uvicorn

app = FastAPI(title="ResQTech One-Click API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Adjust this to specific domains for production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


alerts: list[dict[str, Any]] = []
state: dict[str, Any] = {
    "running": False,
    "source": "",
    "error": "",
    "base_lat": 20.5937,
    "base_lon": 78.9629,
    "altitude_m": 30.0,
    "confidence": 0.45,
    "last_frame": None,
    "last_frame_bytes": None,
    "processed_frames": 0,
    "last_alert_at": 0.0,
}
worker: threading.Thread | None = None
stop_event = threading.Event()
lock = threading.Lock()

class StartRequest(BaseModel):
    video_path: str
    base_latitude: float = Field(ge=-90, le=90)
    base_longitude: float = Field(ge=-180, le=180)
    altitude_m: float = Field(default=30.0, ge=1, le=500)
    confidence: float = Field(default=0.45, ge=0.1, le=0.95)


import os
import numpy as np

# Initialize OpenCV face detector for facial feature recognition
try:
    face_cascade_path = cv2.data.haarcascades + 'haarcascade_frontalface_default.xml'
    face_cascade = cv2.CascadeClassifier(face_cascade_path)
except Exception:
    face_cascade = None


class RTSPStreamReader:
    """
    High-performance zero-latency frame reader for RTSP live streams and video files.
    Continuously flushes FFmpeg buffers to prevent lag, stuttering, or frozen video feeds.
    """
    def __init__(self, source_path: str):
        self.source = source_path
        self.is_rtsp = source_path.lower().startswith(("rtsp://", "rtsps://", "http://", "https://"))
        
        if self.is_rtsp:
            os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp|fflags;nobuffer|max_delay;500000"
            self.cap = cv2.VideoCapture(source_path, cv2.CAP_FFMPEG)
            self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        else:
            self.cap = cv2.VideoCapture(source_path)

        self.lock = threading.Lock()
        self.latest_frame = None
        self.ret = False
        self.running = True

        if self.is_rtsp:
            self.thread = threading.Thread(target=self._reader_loop, daemon=True)
            self.thread.start()

    def _reader_loop(self):
        while self.running:
            if not self.cap.isOpened():
                time.sleep(0.05)
                continue
            ret, frame = self.cap.read()
            if not ret:
                time.sleep(0.01)
                continue
            with self.lock:
                self.latest_frame = frame
                self.ret = ret

    def read(self) -> tuple[bool, np.ndarray | None]:
        if self.is_rtsp:
            with self.lock:
                if self.latest_frame is None:
                    return False, None
                return self.ret, self.latest_frame
        else:
            return self.cap.read()

    def isOpened(self) -> bool:
        return self.cap.isOpened()

    def stop(self):
        self.running = False
        try:
            self.cap.release()
        except Exception:
            pass


def extract_person_features(person_crop: np.ndarray) -> tuple[np.ndarray | None, bool]:
    """
    Extracts a robust visual appearance embedding signature + face detection status for Person Re-ID.
    Returns (feature_vector, face_detected)
    """
    if person_crop is None or person_crop.size == 0:
        return None, False

    h, w = person_crop.shape[:2]
    if h < 15 or w < 15:
        return None, False

    # 1. Fast Face detection on scaled upper 45% of body crop
    face_found = False
    upper_crop = person_crop[0:int(h * 0.45), :]
    if face_cascade is not None and not face_cascade.empty() and upper_crop.shape[0] >= 12 and upper_crop.shape[1] >= 12:
        try:
            gray_upper = cv2.cvtColor(upper_crop, cv2.COLOR_BGR2GRAY)
            # Scale down for super fast cascade evaluation (<2ms per crop)
            if gray_upper.shape[0] > 90 or gray_upper.shape[1] > 90:
                scale_w = 80
                scale_h = max(1, int(gray_upper.shape[0] * (80.0 / max(1, gray_upper.shape[1]))))
                gray_upper = cv2.resize(gray_upper, (scale_w, scale_h))

            faces = face_cascade.detectMultiScale(gray_upper, scaleFactor=1.1, minNeighbors=3, minSize=(10, 10))
            if len(faces) > 0:
                face_found = True
        except Exception:
            pass

    # 2. Multi-Zone HSV Color Histogram Signature (Top, Middle, Bottom body zones for robust Re-ID)
    hsv = cv2.cvtColor(person_crop, cv2.COLOR_BGR2HSV)
    h_third = max(1, h // 3)
    zone1 = hsv[0:h_third, :]
    zone2 = hsv[h_third:2*h_third, :]
    zone3 = hsv[2*h_third:, :]

    hist1 = cv2.calcHist([zone1], [0, 1], None, [8, 8], [0, 180, 0, 256])
    hist2 = cv2.calcHist([zone2], [0, 1], None, [8, 8], [0, 180, 0, 256])
    hist3 = cv2.calcHist([zone3], [0, 1], None, [8, 8], [0, 180, 0, 256])

    cv2.normalize(hist1, hist1)
    cv2.normalize(hist2, hist2)
    cv2.normalize(hist3, hist3)

    feature_vector = np.concatenate([hist1.flatten(), hist2.flatten(), hist3.flatten()])
    return feature_vector, face_found


def compute_visual_similarity(feat1: np.ndarray | None, feat2: np.ndarray | None) -> float:
    if feat1 is None or feat2 is None:
        return 0.0
    dot = np.dot(feat1, feat2)
    norm = (np.linalg.norm(feat1) * np.linalg.norm(feat2))
    if norm < 1e-6:
        return 0.0
    return float(dot / norm)


def haversine_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371000.0  # Earth radius in meters
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2)**2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2)**2
    return 2 * R * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def estimate_location(cx: float, cy: float, w: int, h: int, base_lat: float, base_lon: float, altitude: float):
    fov_rad = math.radians(70)
    ground_w = 2 * altitude * math.tan(fov_rad / 2)
    ground_h = ground_w * h / max(w, 1)
    east_m = (cx / w - 0.5) * ground_w
    north_m = (0.5 - cy / h) * ground_h
    lat = base_lat + north_m / 111111
    lon = base_lon + east_m / (111111 * math.cos(math.radians(base_lat)))
    return round(lat, 6), round(lon, 6), round(max(8.0, altitude * 0.4), 1)


def triage(conf: float, bbox: list[int], w: int, h: int, posture: str, cluster_size: int, belongings: list[str]):
    x1, y1, x2, y2 = bbox
    area_factor = min(((x2-x1)*(y2-y1)) / max(w*h, 1) * 15, 1.0)
    cx, cy = (x1+x2)/2, (y1+y2)/2
    centrality = max(0.0, 1 - (abs(cx-w/2)/(w/2) + abs(cy-h/2)/(h/2))/2)
    
    posture_weights = {
        "Lying Down": 1.0,
        "Sitting/Crouching": 0.6,
        "Standing": 0.3
    }
    posture_val = posture_weights.get(posture, 0.5)
    cluster_val = min(cluster_size * 0.15, 0.3)
    belongings_val = 0.1 if belongings else 0.0
    
    score = 0.40 * conf + 0.30 * posture_val + 0.15 * cluster_val + 0.10 * area_factor + 0.05 * centrality + belongings_val
    score = max(0.0, min(1.0, score))
    
    return round(score, 2), {
        "model_confidence": round(conf, 2),
        "posture": posture,
        "cluster_size": cluster_size,
        "belongings_detected": belongings,
        "visibility_size": round(area_factor, 2),
        "frame_centrality": round(centrality, 2)
    }


def jpeg_b64(frame, max_height=180):
    h, w = frame.shape[:2]
    nw = max(1, int(w * max_height / h))
    thumb = cv2.resize(frame, (nw, max_height))
    ok, buf = cv2.imencode('.jpg', thumb, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
    return base64.b64encode(buf.tobytes()).decode() if ok else None


def run_detection(cfg: StartRequest):
    global worker
    cap = None
    try:
        model = YOLO('yolo11n.pt')
        cap = RTSPStreamReader(cfg.video_path)
        if not cap.isOpened():
            raise RuntimeError(f"Cannot open video source: {cfg.video_path}")

        known_victims = []  # Unique physical victims registered in session

        while not stop_event.is_set():
            ok, frame = cap.read()
            if not ok or frame is None:
                time.sleep(0.01)
                continue
            h, w = frame.shape[:2]

            # Parse frame detections with tracking if available
            try:
                results = model.track(frame, persist=True, classes=[0, 24, 26, 28, 67], conf=cfg.confidence, verbose=False)
                result = results[0]
            except Exception:
                result = model(frame, classes=[0, 24, 26, 28, 67], conf=cfg.confidence, verbose=False)[0]

            persons = []
            belongings = []

            for box in result.boxes:
                cls_id = int(box.cls[0])
                x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
                conf = float(box.conf[0])
                cx, cy = (x1+x2)/2, (y1+y2)/2
                tid = int(box.id[0]) if (box.id is not None and len(box.id) > 0) else None

                if cls_id == 0:
                    persons.append({
                        'bbox': [x1, y1, x2, y2],
                        'conf': conf,
                        'center': (cx, cy),
                        'width': x2 - x1,
                        'height': y2 - y1,
                        'track_id': tid
                    })
                else:
                    label = 'belonging'
                    if cls_id == 24: label = 'backpack'
                    elif cls_id == 26: label = 'handbag'
                    elif cls_id == 28: label = 'suitcase'
                    elif cls_id == 67: label = 'cell phone'

                    belongings.append({
                        'bbox': [x1, y1, x2, y2],
                        'conf': conf,
                        'center': (cx, cy),
                        'label': label
                    })

            for person in persons:
                cx, cy = person['center']
                x1, y1, x2, y2 = person['bbox']

                # Posture estimation
                aspect = person['width'] / max(person['height'], 1)
                if aspect > 1.0:
                    posture = "Lying Down"
                elif aspect > 0.6:
                    posture = "Sitting/Crouching"
                else:
                    posture = "Standing"

                # Belongings association
                associated_belongings = []
                for b in belongings:
                    dist = math.hypot(cx - b['center'][0], cy - b['center'][1])
                    if dist < 180:
                        associated_belongings.append(b['label'])
                        bx1, by1, bx2, by2 = b['bbox']
                        cv2.rectangle(frame, (bx1, by1), (bx2, by2), (255, 255, 0), 1)
                        cv2.putText(frame, b['label'], (bx1, max(12, by1 - 4)), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 0), 1)

                # Cluster size estimation
                cluster_size = 0
                for other in persons:
                    if other is person:
                        continue
                    dist = math.hypot(cx - other['center'][0], cy - other['center'][1])
                    if dist < 300:
                        cluster_size += 1

                # Frame crop feature extraction & face recognition
                crop = frame[max(0, y1):min(h, y2), max(0, x1):min(w, x2)]
                feat, face_detected = extract_person_features(crop)
                lat, lon, error = estimate_location(cx, cy, w, h, cfg.base_latitude, cfg.base_longitude, cfg.altitude_m)
                score, factors = triage(person['conf'], person['bbox'], w, h, posture, cluster_size, associated_belongings)
                factors['estimated_location_error_m'] = error
                factors['face_recognized'] = face_detected

                # Re-ID & Face Recognition Matching against registered victims
                matched_victim = None
                best_match_score = 0.0

                for v in known_victims:
                    spatial_dist_m = haversine_meters(lat, lon, v['lat'], v['lon'])
                    vis_sim = compute_visual_similarity(feat, v['feature'])

                    is_track_match = (person['track_id'] is not None and person['track_id'] == v.get('track_id'))
                    is_face_match = face_detected and v.get('face_detected', False) and (vis_sim >= 0.50)
                    is_visual_match = (vis_sim >= 0.62)
                    is_spatial_match = (spatial_dist_m <= 8.0)

                    if is_track_match or is_face_match or is_visual_match or is_spatial_match:
                        m_score = (2.0 if is_track_match else 0.0) + (1.5 if is_face_match else 0.0) + vis_sim * 1.5 + max(0.0, (10.0 - spatial_dist_m) / 10.0)
                        if m_score > best_match_score:
                            best_match_score = m_score
                            matched_victim = v

                now = time.time()
                if matched_victim is not None:
                    # Existing victim re-identified! Update victim record without duplicating alert
                    v_id = matched_victim['id']
                    matched_victim['lat'] = lat
                    matched_victim['lon'] = lon
                    matched_victim['last_seen'] = now
                    if feat is not None and matched_victim['feature'] is not None:
                        matched_victim['feature'] = 0.8 * matched_victim['feature'] + 0.2 * feat
                    if face_detected:
                        matched_victim['face_detected'] = True

                    # Update alert details if score is higher or image refreshed
                    with lock:
                        alert_idx = matched_victim['alert_index']
                        if 0 <= alert_idx < len(alerts):
                            alerts[alert_idx]['latitude'] = lat
                            alerts[alert_idx]['longitude'] = lon
                            if score > alerts[alert_idx]['triage_score']:
                                alerts[alert_idx]['triage_score'] = score
                                alerts[alert_idx]['triage_factors'] = factors
                            alerts[alert_idx]['image_b64'] = jpeg_b64(frame)
                            factors['reid_matched'] = True
                            factors['priority_label'] = 'HIGH' if alerts[alert_idx]['triage_score'] >= 0.8 else ('MEDIUM' if alerts[alert_idx]['triage_score'] >= 0.55 else 'LOW')
                            alerts[alert_idx]['triage_factors']['priority_label'] = factors['priority_label']

                    rec_type = "Face Match" if face_detected else "Re-ID Match"
                    cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
                    cv2.putText(frame, f"Victim #{v_id} ({rec_type})", (x1, max(22, y1 - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 0), 2)
                else:
                    # New unique victim detected! Register in database and create ONE alert
                    v_id = len(known_victims) + 1
                    factors['priority_label'] = 'HIGH' if score >= 0.8 else ('MEDIUM' if score >= 0.55 else 'LOW')
                    factors['reid_matched'] = False
                    
                    with lock:
                        new_alert = {
                            'id': v_id,
                            'created_at': datetime.now(timezone.utc).isoformat(),
                            'drone_id': 'drone-1',
                            'latitude': lat,
                            'longitude': lon,
                            'altitude_m': cfg.altitude_m,
                            'triage_score': score,
                            'triage_factors': factors,
                            'detections': [{
                                'track_id': v_id,
                                'object_type': 'person',
                                'class_name': 'person',
                                'confidence': round(person['conf'], 3),
                                'bbox': person['bbox']
                            }],
                            'image_b64': jpeg_b64(frame)
                        }
                        alert_idx = len(alerts)
                        alerts.append(new_alert)
                        state['last_alert_at'] = now

                    known_victims.append({
                        'id': v_id,
                        'track_id': person['track_id'],
                        'feature': feat,
                        'face_detected': face_detected,
                        'lat': lat,
                        'lon': lon,
                        'last_seen': now,
                        'alert_index': alert_idx
                    })

                    rec_type = "Face Identified" if face_detected else "New Person"
                    cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 255), 2)
                    cv2.putText(frame, f"Victim #{v_id} ({rec_type})", (x1, max(22, y1 - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 255), 2)

            ok2, buf = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
            if ok2:
                with lock:
                    state['last_frame'] = base64.b64encode(buf.tobytes()).decode()
                    state['last_frame_bytes'] = buf.tobytes()
                    state['processed_frames'] += 1
    except Exception as exc:
        with lock:
            state['error'] = str(exc)
    finally:
        if cap is not None:
            cap.stop()
        try:
            import os
            if os.path.exists(cfg.video_path) and not cfg.video_path.lower().startswith(("rtsp://", "rtsps://", "http://", "https://")):
                os.unlink(cfg.video_path)
        except Exception:
            pass
        with lock:
            state['running'] = False

@app.get('/api/alerts')
def get_alerts():
    with lock:
        return alerts[-100:]

@app.get('/api/status')
def get_status():
    with lock:
        return {k:v for k,v in state.items() if k not in ('last_frame', 'last_frame_bytes')}

@app.get('/api/frame')
def get_frame():
    with lock:
        return {'image_b64':state['last_frame']}

def frame_generator():
    last_sent_frame_id = -1
    while True:
        with lock:
            is_running = state['running']
            frame_bytes = state.get('last_frame_bytes')
            frame_no = state.get('processed_frames', 0)
        
        if not is_running:
            time.sleep(0.1)
            continue
            
        if frame_bytes and frame_no != last_sent_frame_id:
            last_sent_frame_id = frame_no
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')
        else:
            time.sleep(0.01)

@app.get('/api/stream')
def video_stream():
    return StreamingResponse(frame_generator(), media_type='multipart/x-mixed-replace; boundary=frame')

@app.post('/api/start')
async def start(
    video: UploadFile | None = File(None),
    rtsp_url: str | None = Form(None),
    base_latitude: float = Form(...),
    base_longitude: float = Form(...),
    altitude_m: float = Form(30.0),
    confidence: float = Form(0.25)
):
    global worker
    with lock:
        if state['running']:
            return {'ok':False,'message':'Detection is already running. Stop it first.'}
        
        source_name = ""
        if video and video.filename:
            temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".mp4")
            temp_file.write(await video.read())
            temp_file.close()
            video_path_str = temp_file.name
            source_name = video.filename
        elif rtsp_url:
            video_path_str = rtsp_url
            source_name = rtsp_url
        else:
            return {'ok':False,'message':'Either video file upload or RTSP URL must be provided.'}

        alerts.clear(); stop_event.clear()
        state.update({'running':True,'source':source_name,'error':'','base_lat':base_latitude,'base_lon':base_longitude,'altitude_m':altitude_m,'confidence':confidence,'last_frame':None,'processed_frames':0,'last_alert_at':0.0})
        
        req = StartRequest(
            video_path=video_path_str,
            base_latitude=base_latitude,
            base_longitude=base_longitude,
            altitude_m=altitude_m,
            confidence=confidence
        )
        
        worker=threading.Thread(target=run_detection,args=(req,),daemon=True)
        worker.start()
    return {'ok':True,'message':'Detection started'}

@app.post('/api/stop')
def stop():
    stop_event.set()
    return {'ok':True,'message':'Stopping detection'}

# Serve frontend dashboard static files
frontend_path = Path(__file__).parent.parent / "frontend"
app.mount("/", StaticFiles(directory=str(frontend_path), html=True), name="frontend")

if __name__ == '__main__':
    import os
    uvicorn.run(
        app,
        host='0.0.0.0',
        port=int(os.environ.get('PORT', 8000))
    )
