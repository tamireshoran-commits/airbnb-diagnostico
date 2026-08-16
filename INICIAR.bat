@echo off
cd /d "%~dp0"
title Diagnostico Airbnb - Instalando (nao feche esta janela)
color 0A

echo ============================================
echo   PREPARANDO A FERRAMENTA, AGUARDE...
echo   (isso pode demorar alguns minutos)
echo ============================================
echo.

call npm install
if errorlevel 1 goto erro

echo.
echo Baixando o navegador interno (pode demorar)...
call npx playwright install chromium
if errorlevel 1 goto erro

echo.
echo ============================================
echo   TUDO PRONTO! Ligando o servidor...
echo ============================================
echo.
echo Quando aparecer a mensagem abaixo "Servidor rodando...",
echo abra o navegador e va em: http://localhost:3000
echo.
echo NAO FECHE ESTA JANELA enquanto estiver usando a ferramenta.
echo.

node server.js
goto fim

:erro
echo.
echo ============================================
echo   ALGO DEU ERRADO.
echo   Tire um print desta tela e mande para o Claude.
echo ============================================
pause
goto fim

:fim
pause
