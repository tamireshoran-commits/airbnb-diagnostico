@echo off
cd /d "%~dp0"
title Diagnostico Airbnb - Rodando
color 0A

echo ============================================
echo   LIGANDO O SERVIDOR...
echo ============================================
echo.
echo Quando aparecer "Servidor rodando...", abra o navegador
echo e va em: http://localhost:3000
echo.
echo NAO FECHE ESTA JANELA enquanto estiver usando a ferramenta.
echo.

node server.js
pause
