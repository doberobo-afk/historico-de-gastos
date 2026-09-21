@echo off
REM ========================================================================
REM SCRIPT PARA EXECUTAR A AUTOMAÇÃO UMA VEZ
REM ========================================================================

echo.
echo ========================================================================
echo  AUTOMACAO DE CARREGAMENTO DE GASTOS - EXECUCAO UNICA
echo ========================================================================
echo.

REM Verifica se Python está instalado
python --version >nul 2>&1
if errorlevel 1 (
    echo ERRO: Python nao encontrado. Verifique se Python esta instalado.
    pause
    exit /b 1
)

REM Verifica se o arquivo principal existe
if not exist "automacaogastos.py" (
    echo ERRO: Arquivo 'automacaogastos.py' nao encontrado.
    echo Este script deve ser executado no diretorio do projeto.
    pause
    exit /b 1
)

echo Executando automacao uma unica vez...
echo.

python automacaogastos.py

if errorlevel 1 (
    echo.
    echo ERRO: A automacao foi interrompida. Verifique os logs em \logs
    pause
    exit /b 1
) else (
    echo.
    echo SUCESSO: Automacao concluida com sucesso!
    pause
    exit /b 0
)
