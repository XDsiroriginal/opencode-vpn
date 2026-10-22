@echo off
set "HTTP_PROXY=http://127.0.0.1:7899"
set "HTTPS_PROXY=http://127.0.0.1:7899"
set "ALL_PROXY=http://127.0.0.1:7899"
set "http_proxy=http://127.0.0.1:7899"
set "https_proxy=http://127.0.0.1:7899"
set "all_proxy=http://127.0.0.1:7899"
set "NO_PROXY=localhost,127.0.0.1,::1,10.0.0.0/8,192.168.0.0/16,172.16.0.0/12"
set "no_proxy=%NO_PROXY%"
set "NODE_USE_ENV_PROXY=1"
call "%APPDATA%\npm\opencode.cmd" %*
