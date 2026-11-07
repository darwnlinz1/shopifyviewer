@echo off
chcp 65001 >nul
title Viewersite - Cai dat va Chay
cd /d "%~dp0"
color 0A

echo ============================================================
echo   VIEWERSITE - CAI DAT TU DONG (1 click chay ngon)
echo ============================================================
echo   Thu muc: %CD%
echo.

:: ------------------------------------------------ Node check
echo [1/6] Kiem tra Node.js...
where node >nul 2>&1
if %errorlevel% neq 0 (
  color 0C
  echo   [LOI] Chua cai Node.js!
  echo   Tai Node 20+ tai: https://nodejs.org/
  echo   Cai xong mo lai file nay.
  pause
  exit /b 1
)
for /f "tokens=1 delims=v" %%a in ('node -v') do set NODEV=%%a
echo   Node: 
node -v
node -e "const v=process.versions.node.split('.').map(Number); if(v[0]<20){console.log('  [LOI] Can Node 20+, dang dung '+process.versions.node); process.exit(1)} else console.log('  [OK] Node '+process.versions.node+' dat')"
if %errorlevel% neq 0 (
  color 0C
  echo   Vui long cap nhat Node 20+ roi chay lai.
  pause
  exit /b 1
)

:: ------------------------------------------------ npm install
echo.
echo [2/6] Cai dat DAY DU thu vien (npm install)...
call npm install --no-audit --no-fund
if %errorlevel% neq 0 (
  color 0C
  echo   [LOI] npm install that bai - kiem tra mang.
  pause
  exit /b 1
)
echo   [OK] Tat ca package da san sang

:: ------------------------------------------------ build
echo.
echo [3/6] Build du an (npm run build)...
if not exist "dist\cli.js" (
  echo   Chua co dist - dang build...
  call npm run build
  if %errorlevel% neq 0 (
    color 0C
    echo   [LOI] Build that bai.
    pause
    exit /b 1
  )
) else (
  echo   dist da co - build lai de lay fix moi nhat...
  call npm run build
  if %errorlevel% neq 0 (
    color 0E
    echo   [CANH BAO] Build loi, thu dung ban cu...
  ) else (
    echo   [OK] Build xong
  )
)

:: ------------------------------------------------ folders
echo.
echo [4/6] Tao thu muc can thiet...
if not exist "tempprofolio" mkdir "tempprofolio"
if not exist "logs" mkdir "logs"
if not exist "Cookies" mkdir "Cookies"
echo   [OK] tempprofolio/ logs/ Cookies/

:: ------------------------------------------------ browser check & auto-setup
echo.
echo [5/6] Kiem tra trinh duyet Ungoogled-Chromium Portable...
if not exist "bin\ungoogled-chromium\chrome.exe" (
  echo   Chua co Ungoogled-Chromium Portable trong bin
  echo   Dang tu dong tai va thiet lap...
  call node scripts/download-ungoogled.mjs
)

if exist "bin\ungoogled-chromium\chrome.exe" (
  echo   [OK] Ungoogled-Chromium Portable da san sang tai bin\ungoogled-chromium\chrome.exe
) else (
  echo   [THONG BAO] Dung trinh duyet Chrome hoac Edge he thong lam fallback.
)

:: ------------------------------------------------ launch
echo.
echo [6/6] Khoi dong Dashboard...
echo   URL: http://127.0.0.1:7317
echo   Bam Ctrl+C de dung. Dong cua so nay se tat server.
echo.
echo   Dang mo trinh duyet sau 3s...

:: Mo trinh duyet sau khi server san sang
start "" "http://127.0.0.1:7317"

:: Chay dashboard - dung node truc tiep de thay log
node dist/cli.js dashboard --host 127.0.0.1 --port 7317
set ERR=%errorlevel%

if %ERR% neq 0 (
  color 0C
  echo.
  echo ============================================================
  echo   Dashboard dung voi ma loi %ERR%
  echo   Thu lai bang cach chay: npm start
  echo ============================================================
  pause
  exit /b %ERR%
)

pause
