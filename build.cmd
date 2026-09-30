@echo off
setlocal
pushd "%~dp0"
go build -o bench.exe ./cmd/bench
set "result=%ERRORLEVEL%"
popd
if not "%result%"=="0" exit /b %result%
echo Built bench.exe. Start it with .\bench.exe
exit /b 0
