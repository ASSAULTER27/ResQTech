RESQTECH ONE-CLICK SOFTWARE

This version combines the dashboard, FastAPI API, video input, YOLO person detection,
triage score, estimated location and live alert map into ONE local application.

1. Install Python 3.10 or 3.11.
2. Open Command Prompt inside this folder.
3. Run:
   python -m venv venv
   venv\Scripts\activate
   pip install -r requirements.txt
4. Start everything with ONE command:
   python app.py
5. Open this in your browser:
   http://127.0.0.1:8000
6. Paste the full video path, e.g.:
   C:\Users\DAX\ResQTech\datasets\videos\test.mp4
7. Enter your college Google Maps latitude and longitude, then click Start detection.

No separate frontend terminal is required. No separate backend terminal is required.

Note: This is a prototype. It estimates victim coordinates around the configured base location.
It does not use real drone GPS/IMU/gimbal telemetry yet.
