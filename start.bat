@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Reel Studio v2

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

rem A node_modules left over from an older install can be missing a package the server imports at startup (ajv)
rem while "node_modules\playwright" already exists, so checking only for playwright skipped the install and the
rem server then failed with ERR_MODULE_NOT_FOUND. Check every declared dependency, then the browser folder.
set NEED_SETUP=0
node -e "const p=require('./package.json');const miss=Object.keys(p.dependencies||{}).filter(d=>{try{require.resolve(d);return false}catch{return true}});if(miss.length){console.log('[!] Missing dependencies: '+miss.join(', '));process.exit(1)}"
if errorlevel 1 set NEED_SETUP=1
if not exist "node_modules\playwright" set NEED_SETUP=1

if "%NEED_SETUP%"=="1" (
  echo Installing dependencies and Chromium...
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
