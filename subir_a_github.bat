@echo off
title Subir Lubri Expert a GitHub
cd /d "%~dp0"
echo ========================================================
echo SUBIENDO LUBRI EXPERT BOT A GITHUB
echo ========================================================
echo.
echo Sincronizando cambios con GitHub...
"D:\Andres Varela\git\cmd\git.exe" push origin main
echo.
if %ERRORLEVEL% equ 0 (
    echo ========================================================
    echo EXITO: El codigo ya esta subido a tu GitHub!
    echo ========================================================
) else (
    echo ========================================================
    echo Error al subir. Revisa el mensaje arriba.
    echo ========================================================
)
echo.
pause
