# 📊 Automação de Carregamento de Gastos

Sistema automático para carregar dados bancários (CSV) diretamente na planilha de controle financeiro do Excel.

---

## 📁 Arquivos do Projeto

- **`automacaogastos.py`** - Script principal que processa o CSV e atualiza o Excel
- **`extrair_fatura_pdf.py`** - Extrai automaticamente os lançamentos de uma fatura de cartão em PDF e gera o CSV
- **`scheduler_automacao.py`** - Agendador que executa a automação em intervalos regulares
- **`extrato_bancario.csv`** - Arquivo com os dados bancários do Banco do Brasil
- **`fatura_setembro_2026.csv`** - Arquivo com os lançamentos da fatura do cartão de crédito
- **`Planilha_Controle_Financeiro.xlsm`** - Planilha Excel com a aba "CONTROLE FINANCEIRO"
- **`config_automacao.ini`** - Arquivo de configurações
- **`executar_uma_vez.bat`** - Script para executar uma única vez (Windows)
- **`executar_automatico.bat`** - Script para execução contínua (Windows)
- **`index.html`**, **`css/`**, **`js/`** e **`icons/`** - Sistema web (HTML/CSS/JS) que replica as abas RESUMO, CONTROLE FINANCEIRO, CONTROLE DE DÍVIDAS e CADASTROS da planilha

---

## 🌐 Sistema Web (réplica da planilha em HTML)

Na raiz do projeto há uma versão totalmente funcional em HTML/CSS/JS das 4 principais abas da planilha, que roda direto no navegador sem precisar de Excel:

```bash
# Basta abrir o arquivo no navegador (duplo clique)
index.html
```

**O que ela faz:**

- **Login por e-mail e senha** (Supabase Auth): cada pessoa vê apenas os próprios dados
- Dados salvos na nuvem, um documento por usuário na tabela `hg_dados` (Supabase), com RLS por `user_id` — sem `localStorage`, sem backend próprio
- **Resumo**: cards de Receitas, Gastos Variáveis, Gastos Fixos/Cartões e Saldo, por Ano/Mês; tabela de planejamento (orçado x realizado) e visão anual dos 12 meses
- **Controle Financeiro**: cadastro, listagem, filtros (ano/mês/tipo/texto), exclusão de lançamentos e **importação de fatura em PDF** (100% no navegador, com vencimento/competência detectados e TIPO classificado por palavra-chave)
- **Controle de Dívidas**: cadastro de contas fixas/cartões parcelados, alternância rápida entre "PAGO" e "À PAGAR" e **parcelamento automático** (a compra é faturada no mês seguinte e as demais parcelas são geradas para os meses seguintes)
- **Cadastros**: gerenciamento das listas de categorias (Gastos Variáveis, Fixos e Parcelados, Receitas, Cartões) usadas nos menus suspensos das outras abas
- Botões para **exportar backup em JSON**, **restaurar os dados de exemplo** e **alterar a senha** a qualquer momento

### Contas, login e segurança dos dados

- **Login/cadastro** por e-mail e senha (`js/auth-config.js`). Com a confirmação de e-mail
  ativa no Supabase, o cadastro só é liberado depois que a pessoa clica no link recebido.
- **Esqueci minha senha**: o Supabase manda o link; ao voltar para o app, a tela
  "Definir nova senha" aparece e conclui a troca (`auth.updateUser`).
  ⚠️ No painel do Supabase, confira em **Auth → URL Configuration** se *Site URL* /
  *Redirect URLs* apontam para o domínio de produção — senão o link cai em `localhost`.
- **Isolamento entre contas**: cada linha de `hg_dados` pertence a um `user_id` e as
  políticas de RLS só permitem ler/gravar a própria linha (`docs/supabase.sql`).
- **Sem vazamento no mesmo navegador**: ao sair (ou entrar com outra conta) o estado em
  memória e as telas são limpos antes de exibir os dados, e nada é gravado antes de o
  carregamento da nuvem terminar (`js/store.js` → guard `carregado`).
- **Sem perda silenciosa**: se o envio falhar, o indicador do topo mostra
  "⚠️ Não sincronizado" (clique para tentar de novo), há reenvio automático com backoff,
  envio imediato ao fechar/minimizar a aba e aviso antes de sair com alteração pendente.
- **Backup**: o botão "Exportar backup" gera um JSON com todos os dados do usuário logado.

### Parcelamento automático (Controle de Dívidas)

Ao lançar uma compra na aba **Controle de Dívidas**:

- A 1ª parcela é sempre **faturada no mês seguinte** ao da data informada (mesma regra da fórmula `EDATE(data;1)` da planilha).
- As demais parcelas são **geradas automaticamente para os meses seguintes**, uma por mês, com os números `2/12`, `3/12`, ... até a última parcela.
- O campo **Valor (por parcela)** é o valor de cada parcela (o total do parcelamento aparece no resumo abaixo do formulário).
- O campo **Ano da Fatura** é calculado automaticamente (por exemplo: compra em dezembro/2026 → fatura em janeiro/2027).
- As parcelas futuras entram como `À PAGAR` (ou `À RECEBER`, se a observação for de recebimento); a 1ª parcela mantém a condição escolhida no formulário.
- Se **Parcela Nº** for maior que 1 (compra já em andamento), somente as parcelas restantes são geradas.
- Com a observação **GASTOS FIXOS** (contas de valor variável, ex.: energia/água) nada é gerado automaticamente: lança-se uma linha por mês com o valor real.

---

## 🚀 Como Usar

### Opção 1: Execução Única (Recomendado para testes)

#### Windows - Usando o arquivo batch:

```bash
double-click executar_uma_vez.bat
```

#### Ou via Terminal:

```bash
python automacaogastos.py
```

---

### Opção 2: Extração Automática de Fatura em PDF (Cartão de Crédito)

Se você recebe a fatura do cartão em PDF, pode extrair os lançamentos automaticamente, sem digitar nada manualmente:

```bash
# 1. Extrai os lançamentos do PDF e gera o CSV
python extrair_fatura_pdf.py fatura.pdf 2026 8 fatura_setembro_2026.csv

# 2. Importa o CSV gerado para o Excel
python automacaogastos.py fatura_setembro_2026.csv
```

Parâmetros do `extrair_fatura_pdf.py`:

```bash
python extrair_fatura_pdf.py <arquivo.pdf> [ano_fatura] [mes_fechamento] [arquivo_saida.csv]
```

| Parâmetro           | Obrigatório | Padrão                | Descrição                                                                            |
| ------------------- | ----------- | --------------------- | ------------------------------------------------------------------------------------ |
| `arquivo.pdf`       | Sim         | -                     | Caminho do PDF da fatura                                                             |
| `ano_fatura`        | Não         | 2026                  | Ano de referência da fatura                                                          |
| `mes_fechamento`    | Não         | 8                     | Mês de fechamento da fatura (usado para ajustar o ano de compras parceladas antigas) |
| `arquivo_saida.csv` | Não         | `fatura_extraida.csv` | Nome do CSV gerado                                                                   |

O script identifica automaticamente as categorias (Lazer, Restaurantes, Supermercados, Serviços, etc.) seguindo a estrutura real da tabela de lançamentos do PDF, e exibe a soma total extraída para conferência com o valor da fatura.

---

### Opção 3: Automação Contínua (Executa a cada 1 hora)

#### Windows - Usando o arquivo batch:

```bash
double-click executar_automatico.bat
```

#### Ou via Terminal:

```bash
python scheduler_automacao.py --intervalo 3600
```

---

## ⚙️ Configurações

### Alterar Intervalo de Execução

Para mudar o intervalo de execução da automação, você pode:

**Opção 1: Via argumento ao iniciar o scheduler**

```bash
python scheduler_automacao.py --intervalo 1800  # A cada 30 minutos
python scheduler_automacao.py --intervalo 300   # A cada 5 minutos
python scheduler_automacao.py --intervalo 7200  # A cada 2 horas
```

**Opção 2: Editar o arquivo `executar_automatico.bat`**

```batch
python scheduler_automacao.py --intervalo 1800
```

### Intervalos Recomendados

| Intervalo | Frequência      |
| --------- | --------------- |
| 300       | 5 minutos       |
| 900       | 15 minutos      |
| 1800      | 30 minutos      |
| 3600      | 1 hora (padrão) |
| 7200      | 2 horas         |
| 86400     | 1 dia           |

---

## 📝 O que a Automação Faz

### 1. **Leitura do CSV**

- Carrega o arquivo `extrato_bancario.csv`
- Valida e trata os dados

### 2. **Processamento dos Dados**

- Remove linhas de saldo e informações não relevantes
- Filtra apenas despesas (Saídas)
- Filtra apenas movimentações de cartão/crédito
- Converte valores monetários para o formato correto
- Converte datas para número serial do Excel (evita invertir dia/mês)

### 3. **Atualização da Planilha Excel**

- Abre o arquivo `Planilha_Controle_Financeiro.xlsm`
- Localiza a aba "CONTROLE FINANCEIRO"
- Insere os dados a partir da linha 11
- Copia formatação visual (cores, bordas)
- Aplica formato de moeda (R$) e datas brasileiras (dd/mm/aaaa)
- Atualiza cálculos e resumos automaticamente

### 4. **Geração de Logs**

- Cria arquivo de log detalhado em `logs/`
- Registra todas as etapas do processamento

---

## 📋 Requisitos

### Python 3.7+

```bash
python --version
```

### Bibliotecas Python

```bash
pip install pandas xlwings pdfplumber
```

### Windows

- Excel instalado (2010 ou superior)
- Permissão de escrita no diretório do projeto

---

## 🔍 Monitorando a Automação

### Verificar Logs

Os logs são salvos em `logs/` com timestamp:

```
logs/
├── automacao_20240831_143022.log
├── automacao_20240831_140000.log
└── scheduler.log
```

Para visualizar o log mais recente:

- Windows: Abra a pasta `logs/` e clique no arquivo mais recente
- Terminal: `type logs/scheduler.log` (Windows)

### Estrutura do Log

```
2024-08-31 14:30:22 - INFO - INICIANDO AUTOMAÇÃO DE CARREGAMENTO DE GASTOS
2024-08-31 14:30:22 - INFO - Diretório de trabalho: C:\Users\dober\...
2024-08-31 14:30:23 - INFO - ✓ Arquivos validados com sucesso
2024-08-31 14:30:24 - INFO - ✓ Extrato processado com sucesso! 15 linhas finais
2024-08-31 14:30:35 - INFO - ✓ AUTOMAÇÃO CONCLUÍDA COM SUCESSO!
```

---

## ⚠️ Troubleshooting

### Erro: "Python não encontrado"

**Solução:** Instale Python do site [python.org](https://www.python.org)

### Erro: "Arquivo CSV não encontrado"

**Solução:** Verifique se o arquivo `extrato_bancario.csv` está no mesmo diretório

### Erro: "Aba 'CONTROLE FINANCEIRO' não foi encontrada"

**Solução:** Verifique o nome exato da aba no Excel (verifique espaços, maiúsculas/minúsculas)

### Erro: "Planilha está protegida"

**Solução:** Desproteja a planilha: Revisar → Desproteger Planilha

### Excel não abre ou travamento

**Solução:**

1. Feche todos os Excel abertos
2. Aguarde alguns segundos
3. Execute a automação novamente

### Dados não aparecem na planilha

**Solução:**

1. Verifique se os dados do CSV estão sendo filtrados corretamente
2. Verifique o log para mensagens de erro
3. Teste com `executar_uma_vez.bat` para debug

---

## 🔧 Personalizações Avançadas

### Modificar Filtros de Dados

Edite o arquivo `automacaogastos.py`:

```python
# Filtra diferentes tipos de transações
filtro_cartao = df_banco["Lançamento_Upper"].str.contains(
    "CARTAO|CARTÃO|COMPRA|VISA|MASTER|ELO|CRED|CRÉDITO", na=False
)
```

### Alterar Coluna de Discriminação

```python
# Customize como os dados aparecem na planilha
df_pronto["DISCRIMINAÇÃO"] = (
    df_banco["Lançamento"] + " - " + df_banco["Detalhes"].fillna("")
)
```

---

## 📊 Fluxo da Automação

```
CSV (extrato_bancario.csv)
    ↓
[Leitura e Validação]
    ↓
[Filtragem de Dados]
    ├─ Remove saldos
    ├─ Filtra apenas saídas
    └─ Filtra apenas crédito/cartão
    ↓
[Processamento e Limpeza]
    ├─ Converte valores
    ├─ Converte datas
    └─ Formata discriminação
    ↓
[Atualização Excel]
    ├─ Abre planilha
    ├─ Insere dados (linha 11+)
    ├─ Copia formatação
    └─ Salva arquivo
    ↓
Excel (Planilha_Controle_Financeiro.xlsm)
    └─ Aba: CONTROLE FINANCEIRO
```

---

## 📞 Suporte

Para erros específicos:

1. Verifique o arquivo de log mais recente em `logs/`
2. Verifique se todos os arquivos necessários estão presentes
3. Verifique se o Python e as bibliotecas estão instaladas corretamente

---

## 📄 Licença

Uso livre para fins pessoais.

---

**Última atualização:** 31/08/2024
