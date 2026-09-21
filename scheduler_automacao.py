"""
SCHEDULER PARA AUTOMAÇÃO DE CARREGAMENTO DE GASTOS

Este script executa a automação em intervalos regulares (ex: a cada 1 hora).
Pode ser agendado via Task Scheduler do Windows ou deixado rodando em background.

Uso:
    python scheduler_automacao.py --intervalo 3600  # A cada 1 hora (3600 segundos)
    python scheduler_automacao.py --intervalo 1800  # A cada 30 minutos
    python scheduler_automacao.py                  # Padrão: 3600 segundos (1 hora)
"""

import os
import sys
import time
import logging
import argparse
from datetime import datetime
from automacaogastos import executar_automacao

# ========================================================================
# CONFIGURAÇÕES DE LOGGING PARA SCHEDULER
# ========================================================================
LOG_DIR = os.path.join(os.getcwd(), "logs")
os.makedirs(LOG_DIR, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - [SCHEDULER] - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(os.path.join(LOG_DIR, "scheduler.log")),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)


def contar_regressivo(segundos):
    """Exibe contagem regressiva para próxima execução."""
    logger.info(f"Aguardando {segundos} segundos até próxima execução...")
    
    # Mostra a contagem a cada 10% do intervalo (mínimo 1 minuto)
    intervalo_log = max(60, segundos // 10)
    
    for i in range(segundos, 0, -intervalo_log):
        tempo_restante = i
        horas = tempo_restante // 3600
        minutos = (tempo_restante % 3600) // 60
        segundos_restantes = tempo_restante % 60
        
        logger.debug(f"  ⏳ Próxima execução em: {horas:02d}:{minutos:02d}:{segundos_restantes:02d}")
        time.sleep(min(intervalo_log, i))


def executar_scheduler(intervalo_segundos=3600):
    """
    Executa a automação em intervalos regulares.
    
    Args:
        intervalo_segundos: Intervalo de execução em segundos (padrão: 3600 = 1 hora)
    """
    logger.info("=" * 70)
    logger.info("SCHEDULER DE AUTOMAÇÃO INICIADO")
    logger.info(f"Intervalo de execução: {intervalo_segundos} segundos")
    logger.info(f"({intervalo_segundos // 60} minutos)" if intervalo_segundos >= 60 else "")
    logger.info("=" * 70)
    logger.info("Pressione CTRL+C para parar")
    logger.info("=" * 70)
    
    contador_execucoes = 0
    
    try:
        while True:
            contador_execucoes += 1
            logger.info(f"\n[EXECUÇÃO #{contador_execucoes}] {datetime.now().strftime('%d/%m/%Y %H:%M:%S')}")
            
            try:
                sucesso = executar_automacao()
                
                if sucesso:
                    logger.info("✓ Execução concluída com sucesso")
                else:
                    logger.warning("⚠ Execução concluída com avisos")
                    
            except Exception as e:
                logger.error(f"✗ Erro durante execução: {e}", exc_info=True)
            
            # Aguarda até próxima execução
            logger.info(f"\nPróxima execução programada para daqui a {intervalo_segundos // 60} minutos")
            contar_regressivo(intervalo_segundos)
            
    except KeyboardInterrupt:
        logger.info("\n" + "=" * 70)
        logger.info("SCHEDULER PARADO PELO USUÁRIO")
        logger.info(f"Total de execuções: {contador_execucoes}")
        logger.info("=" * 70)
        return True
    except Exception as e:
        logger.error(f"Erro fatal no scheduler: {e}", exc_info=True)
        return False


def validar_intervalo(valor):
    """Valida se o intervalo é um número válido."""
    try:
        intervalo = int(valor)
        if intervalo < 60:
            raise argparse.ArgumentTypeError("Intervalo mínimo é 60 segundos (1 minuto)")
        return intervalo
    except ValueError:
        raise argparse.ArgumentTypeError(f"'{valor}' não é um número inteiro válido")


def main():
    """Função principal para processar argumentos e iniciar scheduler."""
    parser = argparse.ArgumentParser(
        description="Scheduler para automação de carregamento de gastos",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Exemplos:
  python scheduler_automacao.py                    # Executa a cada 1 hora
  python scheduler_automacao.py --intervalo 1800   # Executa a cada 30 minutos
  python scheduler_automacao.py --intervalo 300    # Executa a cada 5 minutos
        """
    )
    
    parser.add_argument(
        "--intervalo",
        type=validar_intervalo,
        default=3600,
        help="Intervalo de execução em segundos (padrão: 3600 = 1 hora)"
    )
    
    args = parser.parse_args()
    
    sucesso = executar_scheduler(args.intervalo)
    sys.exit(0 if sucesso else 1)


if __name__ == "__main__":
    main()
