@echo off
setlocal
set "VPN_HOST=127.0.0.1"
set "VPN_PORT=7899"
set "VPN_PROXY=http://%VPN_HOST%:%VPN_PORT%"
set "VPN_NO_PROXY=localhost,127.0.0.1,::1,10.0.0.0/8,192.168.0.0/16,172.16.0.0/12"

netstat -ano | findstr /R /C:"TCP.*%VPN_HOST%:%VPN_PORT% .*LISTENING" >nul
if not errorlevel 1 (
  echo opencode-vpn: port %VPN_PORT% is busy; the plugin will pick a free port and export proxy variables itself
  set "NODE_USE_ENV_PROXY=1"
  call "%APPDATA%\npm\opencode.cmd" %*
  exit /b %ERRORLEVEL%
)

set "HTTP_PROXY=%VPN_PROXY%"
set "HTTPS_PROXY=%VPN_PROXY%"
set "ALL_PROXY=%VPN_PROXY%"
set "http_proxy=%VPN_PROXY%"
set "https_proxy=%VPN_PROXY%"
set "all_proxy=%VPN_PROXY%"
set "NO_PROXY=%VPN_NO_PROXY%"
set "no_proxy=%VPN_NO_PROXY%"
set "NODE_USE_ENV_PROXY=1"
call "%APPDATA%\npm\opencode.cmd" %*
exit /b %ERRORLEVEL%
