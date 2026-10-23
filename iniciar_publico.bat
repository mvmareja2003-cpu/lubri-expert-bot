@echo off
title Compartir Simulador Lubri Expert al Mundo (Ngrok)
echo =======================================================
echo    CONECTANDO SIMULADOR DE LUBRI EXPERT A INTERNET
echo =======================================================
echo.
echo Conectando tu bot para que los duenos puedan entrar desde
echo cualquier celular o lugar del mundo por WhatsApp.
echo.
echo URL Publica: https://subtype-legacy-unused.ngrok-free.dev
echo.
echo (Manten esta ventana abierta mientras los duenos hacen pruebas)
echo =======================================================
cmd /c ngrok http 3000
pause
