@echo off
title SIMULADOR INTERACTIVO - LUBRI EXPERT
echo =======================================================
echo     ABRIENDO SIMULADOR DE PRUEBAS PARA LOS DUENOS
echo =======================================================
echo.
echo 1. Iniciando servidor del bot...
echo 2. Abriendo ventana en tu navegador: http://localhost:3000
echo.
echo TIP: Tambien puedes abrirlo desde cualquier celular conectado
echo      al mismo Wi-Fi en: http://192.168.1.6:3000
echo =======================================================
cd /d "%~dp0"
start "" http://localhost:3000
call npm run dev
pause
