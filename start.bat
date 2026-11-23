@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Reel Studio v1

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js 18+ is required: https://nodejs.org/
  pause
  exit /b 1
)
where ffmpeg >nul 2>nul
if errorlevel 1 (
  echo [!] ffmpeg was not found in PATH. Install it with:  winget install Gyan.FFmpeg
  echo     ^(or set FFMPEG_PATH / FFPROBE_PATH in .env^)
)

if not exist "node_modules\playwright" (
  echo First launch: installing dependencies and Chromium...
  call npm run setup
  if errorlevel 1 (
    echo [X] Setup failed.
    pause
    exit /b 1
  )
)

start "" http://127.0.0.1:4301
node server\index.mjs
pause
