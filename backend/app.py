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
import cv2
from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
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


def estimate_location(cx: float, cy: float, w: int, h: int, base_lat: float, base_lon: float, altitude: float):
    fov_rad = math.radians(70)
    ground_w = 2 * altitude * math.tan(fov_rad / 2)
    ground_h = ground_w * h / max(w, 1)
    east_m = (cx / w - 0.5) * ground_w
    north_m = (0.5 - cy / h) * ground_h
    lat = base_lat + north_m / 111111
    lon = base_lon + east_m / (111111 * math.cos(math.radians(base_lat)))
    return round(lat, 6), round(lon, 6), round(max(8.0, altitude * 0.4), 1)


def triage(conf: float, bbox: list[int], w: int, h: int):
    x1, y1, x2, y2 = bbox
    area_factor = min(((x2-x1)*(y2-y1)) / max(w*h, 1) * 15, 1.0)
    cx, cy = (x1+x2)/2, (y1+y2)/2
    centrality = max(0.0, 1 - (abs(cx-w/2)/(w/2) + abs(cy-h/2)/(h/2))/2)
    score = max(0.0, min(1.0, 0.60*conf + 0.25*area_factor + 0.15*centrality))
    return round(score, 2), {"model_confidence":round(conf,2), "visibility_size":round(area_factor,2), "frame_centrality":round(centrality,2)}


def jpeg_b64(frame, max_height=180):
    h, w = frame.shape[:2]
    nw = max(1, int(w * max_height / h))
    thumb = cv2.resize(frame, (nw, max_height))
    ok, buf = cv2.imencode('.jpg', thumb)
    return base64.b64encode(buf.tobytes()).decode() if ok else None


def run_detection(cfg: StartRequest):
    global worker
    try:
        model = YOLO('yolo11n.pt')
        cap = cv2.VideoCapture(cfg.video_path)
        if not cap.isOpened():
            raise RuntimeError(f"Cannot open video file: {cfg.video_path}")
        recent = OrderedDict()
        next_track_id = 1
        frame_no = 0
        while not stop_event.is_set():
            ok, frame = cap.read()
            if not ok:
                break
            frame_no += 1
            # Process every third frame to keep laptop CPU usage reasonable.
            if frame_no % 3:
                continue
            h, w = frame.shape[:2]
            result = model(frame, classes=[0], conf=cfg.confidence, verbose=False)[0]
            current = []
            for box in result.boxes:
                x1,y1,x2,y2 = map(int, box.xyxy[0].tolist())
                conf = float(box.conf[0])
                cx,cy=(x1+x2)/2,(y1+y2)/2
                assigned=None
                for tid,(px,py,last_seen) in list(recent.items()):
                    if time.time()-last_seen > 10:
                        recent.pop(tid, None)
                        continue
                    if math.hypot(cx-px,cy-py) < 120:
                        assigned=tid
                        break
                if assigned is None:
                    assigned=next_track_id; next_track_id += 1
                recent[assigned]=(cx,cy,time.time())
                current.append((assigned,conf,[x1,y1,x2,y2]))
                cv2.rectangle(frame,(x1,y1),(x2,y2),(0,255,0),2)
                cv2.putText(frame,f"Person #{assigned} {conf:.2f}",(x1,max(22,y1-8)),cv2.FONT_HERSHEY_SIMPLEX,.55,(0,255,0),2)
            now=time.time()
            if current and now-state['last_alert_at'] >= 2.0:
                tid, conf, bbox = max(current, key=lambda x:x[1])
                x1,y1,x2,y2=bbox
                lat,lon,error=estimate_location((x1+x2)/2,(y1+y2)/2,w,h,cfg.base_latitude,cfg.base_longitude,cfg.altitude_m)
                score,factors=triage(conf,bbox,w,h)
                factors['estimated_location_error_m']=error
                factors['priority_label']='HIGH' if score>=.8 else ('MEDIUM' if score>=.55 else 'LOW')
                record={
                    'id':len(alerts)+1,
                    'created_at':datetime.now(timezone.utc).isoformat(),
                    'drone_id':'drone-1',
                    'latitude':lat,'longitude':lon,'altitude_m':cfg.altitude_m,
                    'triage_score':score,'triage_factors':factors,
                    'detections':[{'track_id':tid,'object_type':'person','class_name':'person','confidence':round(conf,3),'bbox':bbox}],
                    'image_b64':jpeg_b64(frame)
                }
                with lock:
                    alerts.append(record)
                    state['last_alert_at']=now
            ok2, buf=cv2.imencode('.jpg',frame)
            if ok2:
                with lock:
                    state['last_frame']=base64.b64encode(buf.tobytes()).decode()
                    state['processed_frames'] += 1
        cap.release()
    except Exception as exc:
        with lock:
            state['error']=str(exc)
    finally:
        with lock:
            state['running']=False

@app.get('/api/alerts')
def get_alerts():
    with lock:
        return alerts[-100:]

@app.get('/api/status')
def get_status():
    with lock:
        return {k:v for k,v in state.items() if k != 'last_frame'}

@app.get('/api/frame')
def get_frame():
    with lock:
        return {'image_b64':state['last_frame']}

@app.post('/api/start')
async def start(
    video: UploadFile = File(...),
    base_latitude: float = Form(...),
    base_longitude: float = Form(...),
    altitude_m: float = Form(30.0),
    confidence: float = Form(0.45)
):
    global worker
    with lock:
        if state['running']:
            return {'ok':False,'message':'Detection is already running. Stop it first.'}
        
        # Save uploaded file to a temporary location
        temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=".mp4")
        temp_file.write(await video.read())
        temp_file.close()
        video_path_str = temp_file.name

        alerts.clear(); stop_event.clear()
        state.update({'running':True,'source':video.filename,'error':'','base_lat':base_latitude,'base_lon':base_longitude,'altitude_m':altitude_m,'confidence':confidence,'last_frame':None,'processed_frames':0,'last_alert_at':0.0})
        
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

if __name__ == '__main__':
    uvicorn.run(app, host='127.0.0.1', port=8000)
