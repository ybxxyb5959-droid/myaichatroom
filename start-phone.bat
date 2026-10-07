@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo PC와 휴대폰에서 Tailscale을 켜고 같은 계정으로 로그인해 주세요.
echo 기존 단톡방 서버는 먼저 종료해 주세요.
node server.mjs --open --tailscale
if errorlevel 1 pause
