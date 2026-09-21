@echo off
REM ========================================================================
REM SCRIPT PARA EXECUTAR A AUTOMACAO CONTINUAMENTE COM SCHEDULER
REM ========================================================================

echo.
echo ========================================================================
echo  AUTOMACAO DE CARREGAMENTO DE GASTOS - MODO AUTOMATICO
echo ========================================================================
echo.
echo Este script vai executar a automacao em intervalos regulares.
echo Pressione CTRL+C a qualquer momento para parar.
echo.

REM Verifica se Python está instalado
python --version >nul 2>&1
if errorlevel 1 (
    echo ERRO: Python nao encontrado. Verifique se Python esta instalado.
    pause
    exit /b 1
)

REM Verifica se os arquivos necessários existem
if not exist "scheduler_automacao.py" (
    echo ERRO: Arquivo 'scheduler_automacao.py' nao encontrado.
    pause
    exit /b 1
)

if not exist "automacaogastos.py" (
    echo ERRO: Arquivo 'automacaogastos.py' nao encontrado.
    pause
    exit /b 1
)

echo Iniciando scheduler...
echo.

REM Lê o intervalo do arquivo de configuração (padrão: 3600 segundos = 1 hora)
REM Para mudar, edite o arquivo config_automacao.ini
python scheduler_automacao.py --intervalo 3600

if errorlevel 1 (
    echo.
    echo ERRO: O scheduler foi interrompido. Verifique os logs em \logs
    pause
    exit /b 1
)
