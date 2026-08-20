@echo off
start /B python -m http.server 8000
timeout /t 1 > nul
start msedge --app="http://localhost:8000/index.html"
