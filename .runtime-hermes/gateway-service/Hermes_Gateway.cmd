@echo off
rem Hermes Agent Gateway - Messaging Platform Integration
cd /d C:\Users\DELL\AppData\Local\hermes\hermes-agent
set "HERMES_HOME=C:\Users\DELL\AppData\Local\hermes"
set "PYTHONIOENCODING=utf-8"
set "HERMES_GATEWAY_DETACHED=1"
set "VIRTUAL_ENV=C:\Users\DELL\AppData\Local\hermes\hermes-agent\venv"
C:\Users\DELL\AppData\Local\hermes\hermes-agent\venv\Scripts\python.exe -m hermes_cli.main gateway run --replace
