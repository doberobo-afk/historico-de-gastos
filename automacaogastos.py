import os
import pandas as pd
import xlwings as xw
from datetime import datetime
import time
import logging
import sys
import glob

# ========================================================================
# CONFIGURAÇÕES DE LOGGING
# ========================================================================
LOG_DIR = os.path.join(os.getcwd(), "logs")
os.makedirs(LOG_DIR, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(os.path.join(LOG_DIR, f"automacao_{datetime.now().strftime('%Y%m%d_%H%M%S')}.log")),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

# ========================================================================
# CONFIGURAÇÕES DE CAMINHOS
# ========================================================================
PASTA_ATUAL = os.getcwd()
ARQUIVO_EXCEL = os.path.join(PASTA_ATUAL, "Planilha_Controle_Financeiro.xlsm")

# Detecta CSVs disponíveis na pasta
arquivos_csv = sorted(glob.glob(os.path.join(PASTA_ATUAL, "*.csv")))

# Se passou argumento na linha de comando, usa aquele
if len(sys.argv) > 1:
    nome_csv = sys.argv[1]
    ARQUIVO_EXTRATO = os.path.join(PASTA_ATUAL, nome_csv)
    logger.info(f"CSV especificado via argumento: {nome_csv}")
elif arquivos_csv:
    # Prioriza: fatura_setembro_2026.csv > extrato_bancario.csv > primeiro encontrado
    nomes = [os.path.basename(csv) for csv in arquivos_csv]
    if "fatura_setembro_2026.csv" in nomes:
        ARQUIVO_EXTRATO = os.path.join(PASTA_ATUAL, "fatura_setembro_2026.csv")
        logger.info(f"CSV encontrado (priorizado): fatura_setembro_2026.csv")
    elif "extrato_bancario.csv" in nomes:
        ARQUIVO_EXTRATO = os.path.join(PASTA_ATUAL, "extrato_bancario.csv")
        logger.info(f"CSV encontrado (padrão): extrato_bancario.csv")
    else:
        ARQUIVO_EXTRATO = arquivos_csv[0]
        logger.info(f"CSV encontrado: {os.path.basename(ARQUIVO_EXTRATO)}")
    
    # Mostra CSVs disponíveis no log
    logger.info(f"CSVs disponíveis na pasta: {', '.join(nomes)}")
else:
    ARQUIVO_EXTRATO = os.path.join(PASTA_ATUAL, "extrato_bancario.csv")
    logger.warning("Nenhum CSV encontrado - usando padrão: extrato_bancario.csv")

logger.info(f"Diretório de trabalho: {PASTA_ATUAL}")
logger.info(f"Arquivo Excel: {ARQUIVO_EXCEL}")
logger.info(f"Arquivo CSV: {ARQUIVO_EXTRATO}")




def validar_arquivos():
    """Valida se os arquivos necessários existem."""
    if not os.path.exists(ARQUIVO_EXTRATO):
        logger.error(f"Arquivo CSV não encontrado: {ARQUIVO_EXTRATO}")
        raise FileNotFoundError(f"CSV não encontrado: {ARQUIVO_EXTRATO}")
    
    if not os.path.exists(ARQUIVO_EXCEL):
        logger.error(f"Arquivo Excel não encontrado: {ARQUIVO_EXCEL}")
        raise FileNotFoundError(f"Excel não encontrado: {ARQUIVO_EXCEL}")
    
    logger.info("[OK] Arquivos validados com sucesso")
    return True


def tratar_extrato_bb(caminho_extrato):
    """Carrega o extrato, detecta o tipo (Banco ou Cartão) e aplica filtro apropriado."""
    logger.info(f"Iniciando leitura do extrato: {caminho_extrato}")
    
    df_banco = None
    for encoding in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            df_banco = pd.read_csv(caminho_extrato, sep=",", encoding=encoding)
            logger.info(f"[OK] CSV carregado com {len(df_banco)} linhas (encoding: {encoding})")
            break
        except UnicodeDecodeError:
            continue
        except Exception as e:
            logger.error(f"Erro ao ler o CSV: {e}")
            raise
    if df_banco is None:
        raise ValueError(f"Não foi possível decodificar o CSV: {caminho_extrato}")

    # Detecta tipo de arquivo pela estrutura de colunas (normaliza espaços e case)
    colunas = df_banco.columns.tolist()
    colunas_lower = [col.lower().strip() for col in colunas]
    
    # Verifica se é cartão de crédito
    eh_cartao_credito = any("descri" in col for col in colunas_lower) and any("categor" in col for col in colunas_lower)
    
    # Verifica se é banco
    eh_banco_bb = any("lança" in col for col in colunas_lower) and any("tipo" in col for col in colunas_lower)
    
    if eh_cartao_credito:
        logger.info("Detectado: EXTRATO DE CARTÃO DE CRÉDITO")
        # Normaliza os nomes das colunas
        df_banco.columns = ['Data', 'Descrição', 'País', 'Valor', 'Categoria']
        return tratar_fatura_cartao(df_banco)
    elif eh_banco_bb:
        logger.info("Detectado: EXTRATO BANCO DO BRASIL")
        return tratar_extrato_banco_bb(df_banco)
    else:
        logger.error(f"Formato de CSV desconhecido. Colunas encontradas: {colunas}")
        raise ValueError("Formato de CSV não reconhecido")


def tratar_fatura_cartao(df_banco):
    """Processa fatura de cartão de crédito."""
    
    # Remove linhas de saldo
    logger.info("Limpando linhas de saldos...")
    df_banco = df_banco[
        ~df_banco["Descrição"].str.contains("SALDO|PAGTO|CASH", na=False, case=False)
    ].copy()
    logger.info(f"  Após remover saldos: {len(df_banco)} linhas")

    # Remove pagamentos (linhas com valor negativo = crédito da conta)
    logger.info("Filtrando apenas despesas (valores positivos)...")
    df_banco["Valor"] = pd.to_numeric(
        df_banco["Valor"].astype(str).str.replace(",", "."), errors="coerce"
    )
    df_banco = df_banco[df_banco["Valor"] > 0].copy()
    logger.info(f"  Após filtro de despesas: {len(df_banco)} linhas")

    # 4. Tratamento dos Valores
    logger.info("Convertendo valores monetários...")
    df_banco["Valor"] = df_banco["Valor"].abs().round(2)

    # Converte a coluna Data
    logger.info("Convertendo datas para formato padrão...")
    df_banco["Data_Parsed"] = pd.to_datetime(
        df_banco["Data"], format="%d/%m/%Y"
    )

    # Conversão para número serial de data do Excel
    data_base_excel = pd.to_datetime("1899-12-30")
    df_banco["Data_Serial"] = (
        df_banco["Data_Parsed"] - data_base_excel
    ).dt.days

    meses_pt = {
        1: "JANEIRO", 2: "FEVEREIRO", 3: "MARÇO", 4: "ABRIL",
        5: "MAIO", 6: "JUNHO", 7: "JULHO", 8: "AGOSTO",
        9: "SETEMBRO", 10: "OUTUBRO", 11: "NOVEMBRO", 12: "DEZEMBRO",
    }

    df_pronto = pd.DataFrame()
    df_pronto["TIPO"] = df_banco["Categoria"].fillna("DIVERSOS")
    df_pronto["VALOR"] = df_banco["Valor"]
    df_pronto["DISCRIMINAÇÃO"] = df_banco["Descrição"]
    df_pronto["DATA"] = df_banco["Data_Serial"]
    df_pronto["VENCIMENTO"] = df_banco["Data_Parsed"].dt.month.map(meses_pt)
    df_pronto["ANO"] = df_banco["Data_Parsed"].dt.year
    df_pronto["ENTRADA/SAÍDA"] = "DESPESA"
    df_pronto["OBSERVAÇÃO"] = "FATURA CARTÃO"

    logger.info(f"[OK] Extrato processado com sucesso! {len(df_pronto)} linhas finais")
    return df_pronto


def tratar_extrato_banco_bb(df_banco):
    """Processa extrato do Banco do Brasil."""
    
    # 1. Limpeza de linhas de saldos
    logger.info("Limpando linhas de saldos...")
    palavras_chave_saldo = ["Saldo Anterior", "Saldo do dia", "S A L D O"]
    df_banco = df_banco[
        ~df_banco["Lançamento"].isin(palavras_chave_saldo)
    ].copy()
    logger.info(f"  Após remover saldos: {len(df_banco)} linhas")

    # 2. Filtra apenas despesas (Saídas)
    logger.info("Filtrando apenas despesas (Saídas)...")
    df_banco = df_banco[
        df_banco["Tipo Lançamento"].str.upper() == "SAÍDA"
    ].copy()
    logger.info(f"  Após filtro de saídas: {len(df_banco)} linhas")

    # 3. Filtro cirúrgico de Crédito (Exclui Débito)
    logger.info("Filtrando apenas movimentações de crédito/cartão...")
    df_banco["Lançamento_Upper"] = (
        df_banco["Lançamento"].astype(str).str.upper()
    )
    filtro_cartao = df_banco["Lançamento_Upper"].str.contains(
        "CARTAO|CARTÃO|COMPRA|VISA|MASTER|ELO|CRED|CRÉDITO", na=False
    )
    filtro_nao_debito = ~df_banco["Lançamento_Upper"].str.contains(
        "DEBITO|DÉBITO", na=False
    )
    df_banco = df_banco[filtro_cartao & filtro_nao_debito].copy()
    logger.info(f"  Após filtro de crédito: {len(df_banco)} linhas")

    # 4. Tratamento dos Valores
    logger.info("Convertendo valores monetários...")
    df_banco["Valor"] = df_banco["Valor"].astype(str)
    df_banco["Valor"] = df_banco["Valor"].str.replace(".", "", regex=False)
    df_banco["Valor"] = df_banco["Valor"].str.replace(",", ".", regex=False)
    df_banco["Valor"] = pd.to_numeric(df_banco["Valor"])
    df_banco["Valor"] = df_banco["Valor"].abs().round(2)

    # Converte a coluna Data para datetime real do Pandas
    logger.info("Convertendo datas para formato padrão...")
    df_banco["Data_Parsed"] = pd.to_datetime(
        df_banco["Data"], format="%d/%m/%Y"
    )

    # Conversão para número serial de data do Excel
    data_base_excel = pd.to_datetime("1899-12-30")
    df_banco["Data_Serial"] = (
        df_banco["Data_Parsed"] - data_base_excel
    ).dt.days

    meses_pt = {
        1: "JANEIRO", 2: "FEVEREIRO", 3: "MARÇO", 4: "ABRIL",
        5: "MAIO", 6: "JUNHO", 7: "JULHO", 8: "AGOSTO",
        9: "SETEMBRO", 10: "OUTUBRO", 11: "NOVEMBRO", 12: "DEZEMBRO",
    }

    df_pronto = pd.DataFrame()
    df_pronto["TIPO"] = "DIVERSOS"
    df_pronto["VALOR"] = df_banco["Valor"]
    df_pronto["DISCRIMINAÇÃO"] = (
        df_banco["Lançamento"] + " - " + df_banco["Detalhes"].fillna("")
    )
    df_pronto["DATA"] = df_banco["Data_Serial"]
    df_pronto["VENCIMENTO"] = df_banco["Data_Parsed"].dt.month.map(meses_pt)
    df_pronto["ANO"] = df_banco["Data_Parsed"].dt.year
    df_pronto["ENTRADA/SAÍDA"] = "DESPESA"
    df_pronto["OBSERVAÇÃO"] = "EXTRATO BB"

    logger.info(f"[OK] Extrato processado com sucesso! {len(df_pronto)} linhas finais")
    return df_pronto


# ========================================================================
# ATUALIZAÇÃO DE DADOS NO EXCEL
# ========================================================================
def atualizar_estilo_vba_perfeito(caminho_excel, df_novos_dados):
    """Insere os dados nas linhas vazias e mantém a planilha intacta."""
    if not os.path.exists(caminho_excel):
        logger.error(f"Erro: O arquivo {caminho_excel} não foi encontrado.")
        raise FileNotFoundError(f"Excel não encontrado: {caminho_excel}")

    logger.info(f"Iniciando importação de {len(df_novos_dados)} linhas para Excel...")
    
    app = None
    try:
        app = xw.App(visible=True, add_book=False)
        app.display_alerts = False

        logger.info("Abrindo arquivo Excel...")
        wb = app.books.open(caminho_excel, update_links=False, read_only=False)
        
        # Valida se a aba existe
        try:
            ws = wb.sheets["CONTROLE FINANCEIRO"]
            logger.info("[OK] Aba 'CONTROLE FINANCEIRO' localizada")
        except Exception as e:
            logger.error(f"Erro: A aba 'CONTROLE FINANCEIRO' não foi encontrada!")
            logger.error(f"Abas disponíveis: {[sheet.name for sheet in wb.sheets]}")
            raise

        app.enable_events = False
        app.calculation = "manual"
        logger.info("Desativando eventos e cálculos automáticos do Excel...")

        # ===================================================================
        # ENCONTRAR PRIMEIRA LINHA VAZIA - Mantém dados antigos intactos
        # ===================================================================
        logger.info("Localizando primeira linha vazia para inserção...")
        
        linha_insercao = 11
        for row_idx in range(11, 1000):
            valor_b = ws.range(f"B{row_idx}").value
            if valor_b is None or valor_b == "":
                linha_insercao = row_idx
                logger.info(f"[OK] Primeira linha vazia encontrada: linha {linha_insercao}")
                break

        total_linhas = len(df_novos_dados)
        
        logger.info(f"Inserindo {total_linhas} despesas a partir da linha {linha_insercao}...")

        # ===================================================================
        # INSERIR DADOS NOVOS - Sem limpar nada, apenas adiciona
        # ===================================================================
        for idx, (_, row) in enumerate(df_novos_dados.iterrows(), 1):
            try:
                linha_atual = linha_insercao + idx - 1  # Começa na primeira vazia
                
                # Injeta os valores direto nas células (preserva tudo)
                ws.range(f"B{linha_atual}").value = row["TIPO"]
                ws.range(f"C{linha_atual}").value = float(row["VALOR"])
                ws.range(f"D{linha_atual}").value = row["DISCRIMINAÇÃO"]
                ws.range(f"E{linha_atual}").value = int(row["DATA"])  # Número serial da data
                ws.range(f"F{linha_atual}").value = row["VENCIMENTO"]
                ws.range(f"G{linha_atual}").value = int(row["ANO"])
                ws.range(f"H{linha_atual}").value = row["ENTRADA/SAÍDA"]
                ws.range(f"I{linha_atual}").value = row["OBSERVAÇÃO"]
                
                if idx % 10 == 0:
                    logger.info(f"  Processadas {idx}/{total_linhas} linhas...")

            except Exception as e:
                logger.error(f"Erro ao inserir linha {idx}: {e}")
                raise

        app.api.CutCopyMode = False

        logger.info("Sincronizando cálculos do painel de resumo...")
        app.calculation = "automatic"

        logger.info("Salvando arquivo Excel...")
        wb.save()
        wb.close()
        
        logger.info("=" * 60)
        logger.info("[OK] AUTOMAÇÃO CONCLUÍDA COM SUCESSO!")
        logger.info(f"[OK] {total_linhas} transações importadas")
        logger.info(f"[OK] Planilha mantida intacta - dados antigos preservados")
        logger.info("=" * 60)

    except Exception as e:
        logger.error(f"Erro durante o processamento: {e}", exc_info=True)
        raise
    finally:
        if app is not None:
            try:
                app.enable_events = True
                app.calculation = "automatic"
            except Exception:
                pass
            try:
                app.quit()
            except Exception:
                pass



def executar_automacao():
    """Função principal que coordena toda a automação."""
    logger.info("=" * 60)
    logger.info("INICIANDO AUTOMAÇÃO DE CARREGAMENTO DE GASTOS")
    logger.info(f"Timestamp: {datetime.now().strftime('%d/%m/%Y %H:%M:%S')}")
    logger.info("=" * 60)
    
    try:
        # 1. Validar arquivos
        validar_arquivos()
        
        # 2. Processar CSV
        dados_prontos = tratar_extrato_bb(ARQUIVO_EXTRATO)
        
        if len(dados_prontos) == 0:
            logger.warning("Nenhuma transação para importar. Verificar filtros.")
            return False
        
        # 3. Atualizar Excel
        atualizar_estilo_vba_perfeito(ARQUIVO_EXCEL, dados_prontos)
        
        logger.info("=" * 60)
        logger.info("[OK] AUTOMAÇÃO FINALIZADA COM SUCESSO")
        logger.info("=" * 60)
        return True
        
    except FileNotFoundError as e:
        logger.error(f"Erro de arquivo: {e}")
        return False
    except Exception as e:
        logger.error(f"Erro geral durante automação: {e}", exc_info=True)
        return False


if __name__ == "__main__":
    try:
        sucesso = executar_automacao()
        exit(0 if sucesso else 1)
    except KeyboardInterrupt:
        logger.warning("Automação interrompida pelo usuário")
        exit(1)
    except Exception as e:
        logger.error(f"Erro não tratado: {e}", exc_info=True)
        exit(1)
