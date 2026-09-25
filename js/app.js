// ==========================================================================
// Controle Financeiro - App
// Persistência: Supabase direto (tabela hg_dados) - ver js/store.js
// ==========================================================================

const MESES = [
  "JANEIRO",
  "FEVEREIRO",
  "MARÇO",
  "ABRIL",
  "MAIO",
  "JUNHO",
  "JULHO",
  "AGOSTO",
  "SETEMBRO",
  "OUTUBRO",
  "NOVEMBRO",
  "DEZEMBRO",
];

const LS_KEYS = {
  cf: "hg_controle_financeiro",
  cd: "hg_controle_dividas",
  cad: "hg_cadastros",
  meta: "hg_meta",
};

const POR_PAGINA = 100; // paginação das tabelas (evita render de milhares de linhas)

// Categorias de receita usadas quando a aba Cadastros ainda não foi configurada
const CATEGORIAS_RECEITA_PADRAO = ["SALÁRIO", "EXTRAS", "OUTRAS RECEITAS"];

// STATE é preenchido de forma assíncrona por iniciar() -> HGStore.load()
let STATE = { cf: [], cd: [], cad: {}, meta: {}, pronto: false };
let PAGINA_CF = 1;
let PAGINA_CD = 1;

// ---------------------------------------------------------------------
// Persistência (cache local imediato + envio para /api/sync)
// ---------------------------------------------------------------------
function salvar(chave, valor) {
  if (window.HGStore) HGStore.save(chave, valor);
}

// ---------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------
const safeParse =
  (window.HGStore && HGStore.safeParse) ||
  function (t, p) {
    try {
      return t ? JSON.parse(t) : p;
    } catch (e) {
      return p;
    }
  };

const esc =
  (window.HGStore && HGStore.esc) ||
  function (v) {
    if (v === null || v === undefined) return "";
    return String(v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };

const num =
  (window.HGStore && HGStore.num) ||
  function (v) {
    const n = Number(v);
    return isFinite(n) ? n : 0;
  };

function brMoeda(v) {
  return num(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function dataBrParaISO(dataBr) {
  // "31/07/2026" -> "2026-07-31"
  if (!dataBr) return "";
  const [d, m, a] = dataBr.split("/");
  return `${a}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function dataISOParaBr(iso) {
  // "2026-07-31" -> "31/07/2026"
  if (!iso) return "";
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(iso)) return iso;
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

function dataCFParaBr(valor) {
  const texto = String(valor || "").trim();
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(texto)) return texto;
  if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) return dataISOParaBr(texto);
  return "";
}

// Aliases usados pelos inputs type="date" (nativos): exibem DD/MM/YYYY mas
// mantêm o armazenamento interno em DD/MM/YYYY (compatível com dados existentes)
function formatarDataBR(iso) {
  return dataISOParaBr(iso);
}

function parseDataISO(dataBr) {
  return dataBrParaISO(dataBr);
}

function mesDaDataBr(dataBr) {
  if (!dataBr) return "";
  const [, m] = dataBr.split("/");
  const idx = parseInt(m, 10) - 1;
  return MESES[idx] || "";
}

function anoDaDataBr(dataBr) {
  if (!dataBr) return "";
  const [, , a] = dataBr.split("/");
  return a;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Parse parcela fields robustly. Returns { current: Number|null, total: Number|null }
function parseParcela(row) {
  const rawP = row.PARCELAS;
  const rawQ = row.QTD_PARCELAS;

  function toNum(v) {
    if (v === undefined || v === null) return null;
    if (typeof v === "number") return isFinite(v) ? Math.round(v) : null;
    let s = String(v).trim();
    if (!s) return null;
    // if contains slash like "6/12", handle outside
    if (s.includes("/")) return null;
    s = s.replace(/,/g, ".");
    const n = Number(s);
    return isNaN(n) ? null : Math.round(n);
  }

  // try direct numeric parse
  let p = toNum(rawP);
  let q = toNum(rawQ);

  // if either is null, but one of the raw strings contains "X/Y", try to extract
  const maybe = (val) => (typeof val === "string" ? val.trim() : "");
  if ((p === null || q === null) && maybe(rawP).includes("/")) {
    const parts = rawP.split("/").map((s) => s.replace(/,/g, ".").trim());
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    if (!isNaN(a)) p = Math.round(a);
    if (!isNaN(b)) q = Math.round(b);
  }
  if ((p === null || q === null) && maybe(rawQ).includes("/")) {
    const parts = rawQ.split("/").map((s) => s.replace(/,/g, ".").trim());
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    if (!isNaN(a) && p === null) p = Math.round(a);
    if (!isNaN(b) && q === null) q = Math.round(b);
  }

  // final fallback: if p missing but q === 1, treat as single-installment
  if (p === null && q === 1) p = 1;

  return { current: p, total: q };
}

// ---------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll(".tab-btn")
      .forEach((b) => b.classList.remove("active"));
    document
      .querySelectorAll(".panel")
      .forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "resumo") renderResumo();
  });
});

// ---------------------------------------------------------------------
// Busca do cabeçalho (topSearch) - filtra Controle Financeiro por texto
// ---------------------------------------------------------------------
const topSearchEl = document.getElementById("topSearch");
if (topSearchEl) {
  topSearchEl.addEventListener("input", () => {
    const termo = topSearchEl.value;
    const cfFiltroTexto = document.getElementById("cfFiltroTexto");
    if (!cfFiltroTexto) return;
    cfFiltroTexto.value = termo;
    if (termo.trim()) {
      document
        .querySelectorAll(".tab-btn")
        .forEach((b) => b.classList.remove("active"));
      document
        .querySelectorAll(".panel")
        .forEach((p) => p.classList.remove("active"));
      document
        .querySelector('.tab-btn[data-tab="controle-financeiro"]')
        ?.classList.add("active");
      document.getElementById("controle-financeiro")?.classList.add("active");
    }
    renderControleFinanceiro();
  });
}

// ---------------------------------------------------------------------
// Popular selects estáticos (ano/mês)
// ---------------------------------------------------------------------
function anosDisponiveis() {
  const anosCF = STATE.cf
    .map((r) => parseInt(anoDaDataBr(r.DATA) || r.ANO, 10))
    .filter(Boolean);
  const anosCD = STATE.cd
    .flatMap((r) => [parseInt(anoDaDataBr(r.DATA), 10), parseInt(r.ANO, 10)])
    .filter(Boolean);
  const anos = new Set([...anosCF, ...anosCD, new Date().getFullYear()]);
  return Array.from(anos).sort((a, b) => b - a);
}

function popularSelect(select, opcoes, valorAtual) {
  const anterior = valorAtual !== undefined ? valorAtual : select.value;
  select.innerHTML = "";
  opcoes.forEach((op) => {
    const el = document.createElement("option");
    el.value = op.value;
    el.textContent = op.label;
    select.appendChild(el);
  });
  const existeAnterior = opcoes.some(
    (op) => String(op.value) === String(anterior),
  );
  if (existeAnterior) select.value = anterior;
}

function popularSelectsAnoMes() {
  const anos = anosDisponiveis();
  const anoOpts = anos.map((a) => ({ value: a, label: a }));
  const mesOpts = MESES.map((m) => ({ value: m, label: m }));

  const resumoAnoEl = document.getElementById("resumoAno");
  const resumoMesEl = document.getElementById("resumoMes");
  // Preserva a seleção atual do usuário; só usa o valor padrão na primeira carga (select vazio)
  popularSelect(
    resumoAnoEl,
    anoOpts,
    resumoAnoEl.value || STATE.meta.ano_atual,
  );
  popularSelect(
    resumoMesEl,
    mesOpts,
    resumoMesEl.value || STATE.meta.mes_atual,
  );

  const cfFiltroAnoEl = document.getElementById("cfFiltroAno");
  const cfFiltroMesEl = document.getElementById("cfFiltroMes");
  const cdFiltroAnoEl = document.getElementById("cdFiltroAno");
  const cdFiltroMesEl = document.getElementById("cdFiltroMes");

  popularSelect(
    cfFiltroAnoEl,
    [{ value: "", label: "Todos" }, ...anoOpts],
    cfFiltroAnoEl.value,
  );
  popularSelect(
    cfFiltroMesEl,
    [{ value: "", label: "Todos" }, ...mesOpts],
    cfFiltroMesEl.value,
  );
  popularSelect(
    cdFiltroAnoEl,
    [{ value: "", label: "Todos" }, ...anoOpts],
    cdFiltroAnoEl.value,
  );
  popularSelect(
    cdFiltroMesEl,
    [{ value: "", label: "Todos" }, ...mesOpts],
    cdFiltroMesEl.value,
  );
}

function popularDropdownsCadastro() {
  const cad = STATE.cad;
  const tiposEntrada = Array.from(
    new Set([...(cad.receitas || []), ...(cad.receitas_variaveis || [])]),
  );

  const cfEntradaSaida = document.getElementById("cfEntradaSaida");
  const cfTipo = document.getElementById("cfTipo");

  function atualizarTipoCF() {
    const lista =
      cfEntradaSaida.value === "RECEITA"
        ? tiposEntrada
        : cad.gastos_variaveis || [];
    popularSelect(
      cfTipo,
      lista.map((t) => ({ value: t, label: t })),
    );
  }
  cfEntradaSaida.onchange = atualizarTipoCF;
  atualizarTipoCF();

  popularSelect(
    document.getElementById("cdTipo"),
    (cad.fixos_parcelados || []).map((t) => ({ value: t, label: t })),
  );
}

// ---------------------------------------------------------------------
// CONTROLE FINANCEIRO - CRUD
// ---------------------------------------------------------------------
function filtrosCF() {
  return {
    ano: document.getElementById("cfFiltroAno").value,
    mes: document.getElementById("cfFiltroMes").value,
    tipo: document.getElementById("cfFiltroTipo").value.trim().toLowerCase(),
    texto: document.getElementById("cfFiltroTexto").value.trim().toLowerCase(),
  };
}

let assinaturaFiltros = { cf: "", cd: "" };
let indiceCFEditando = null;

// Paginação reutilizável (Controle Financeiro / Controle de Dívidas)
function renderPager(idContainer, total, paginaAtual, irParaPagina) {
  const el = document.getElementById(idContainer);
  if (!el) return;
  const paginas = Math.max(1, Math.ceil(total / POR_PAGINA));
  if (total <= POR_PAGINA) {
    el.innerHTML = "";
    return;
  }
  const atual = Math.min(Math.max(1, paginaAtual), paginas);
  const de = (atual - 1) * POR_PAGINA + 1;
  const ate = Math.min(total, atual * POR_PAGINA);
  el.innerHTML = `
    <span class="pager-info">Mostrando <b>${de}-${ate}</b> de <b>${total}</b> registros</span>
    <span class="pager-actions">
      <button class="btn small secondary" data-pg="1" ${atual === 1 ? "disabled" : ""} title="Primeira página">⏮</button>
      <button class="btn small secondary" data-pg="${atual - 1}" ${atual === 1 ? "disabled" : ""} title="Página anterior">◀</button>
      <span class="pager-page">Página ${atual}/${paginas}</span>
      <button class="btn small secondary" data-pg="${atual + 1}" ${atual === paginas ? "disabled" : ""} title="Próxima página">▶</button>
      <button class="btn small secondary" data-pg="${paginas}" ${atual === paginas ? "disabled" : ""} title="Última página">⏭</button>
    </span>`;
  el.querySelectorAll("[data-pg]").forEach((btn) => {
    btn.addEventListener("click", () => irParaPagina(Number(btn.dataset.pg)));
  });
}

function linhasFiltradasCF() {
  const f = filtrosCF();
  return STATE.cf
    .map((row, idx) => ({ row, idx }))
    .filter(({ row }) => {
      if (f.ano && String(anoDaDataBr(row.DATA) || row.ANO) !== String(f.ano))
        return false;
      if (f.mes && String(row.VENCIMENTO || mesDaDataBr(row.DATA)) !== f.mes)
        return false;
      if (
        f.tipo &&
        !String(row.TIPO || "")
          .toLowerCase()
          .includes(f.tipo)
      )
        return false;
      if (
        f.texto &&
        !String(row.DISCRIMINACAO || "")
          .toLowerCase()
          .includes(f.texto)
      )
        return false;
      return true;
    });
}

function renderControleFinanceiro() {
  const tbody = document.getElementById("tabelaCF");
  const linhas = linhasFiltradasCF();

  // volta para a 1ª página sempre que os filtros mudarem
  const assinatura = JSON.stringify(filtrosCF());
  if (assinatura !== assinaturaFiltros.cf) {
    assinaturaFiltros.cf = assinatura;
    PAGINA_CF = 1;
  }

  tbody.innerHTML = "";
  let totalReceitas = 0;
  let totalDespesas = 0;

  // Totais consideram TODO o filtro, não apenas a página exibida
  linhas.forEach(({ row }) => {
    const valorNum = num(row.VALOR);
    if (row.ENTRADA_SAIDA === "RECEITA") totalReceitas += valorNum;
    else totalDespesas += valorNum;
  });

  const paginas = Math.max(1, Math.ceil(linhas.length / POR_PAGINA));
  if (PAGINA_CF > paginas) PAGINA_CF = paginas;
  const inicio = (PAGINA_CF - 1) * POR_PAGINA;
  const linhasPagina = linhas.slice(inicio, inicio + POR_PAGINA);

  if (linhasPagina.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-msg">Nenhum lançamento encontrado.</td></tr>`;
  }

  linhasPagina.forEach(({ row, idx }) => {
    const tr = document.createElement("tr");
    const badgeClass = row.ENTRADA_SAIDA === "RECEITA" ? "entrada" : "despesa";
    tr.innerHTML = `
      <td>${esc(row.TIPO)}</td>
      <td>${brMoeda(row.VALOR)}</td>
      <td>${esc(row.DISCRIMINACAO)}</td>
      <td>${esc(row.DATA)}</td>
      <td>${esc(row.VENCIMENTO || mesDaDataBr(row.DATA))}</td>
      <td>${esc(row.ANO || anoDaDataBr(row.DATA))}</td>
      <td><span class="badge ${badgeClass}">${esc(row.ENTRADA_SAIDA)}</span></td>
      <td>${esc(row.OBSERVACAO)}</td>
      <td class="actions-col">
        <button title="Editar" data-edit-cf="${esc(idx)}">✏️</button>
        <button title="Excluir" data-del-cf="${esc(idx)}">🗑️</button>
      </td>`;
    tbody.appendChild(tr);
  });

  // Edição e exclusão usam o índice original, não o da página.
  tbody.querySelectorAll("[data-edit-cf]").forEach((btn) => {
    btn.addEventListener("click", () =>
      iniciarEdicaoCF(Number(btn.dataset.editCf)),
    );
  });
  tbody.querySelectorAll("[data-del-cf]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.delCf);
      if (!Number.isInteger(idx) || !STATE.cf[idx]) return;
      if (confirm("Excluir este lançamento?")) {
        STATE.cf.splice(idx, 1);
        salvar(LS_KEYS.cf, STATE.cf);
        renderControleFinanceiro();
        renderResumo();
      }
    });
  });

  renderPager("cfPager", linhas.length, PAGINA_CF, (pagina) => {
    PAGINA_CF = pagina;
    renderControleFinanceiro();
  });

  // Atualiza rodapé com receitas, despesas e saldo (filtro completo)
  const saldo = totalReceitas - totalDespesas;
  const tbodyEl = document.getElementById("tabelaCF");
  let footer = null;
  if (tbodyEl) {
    const tableEl = tbodyEl.closest("table");
    if (tableEl) footer = tableEl.querySelector("tfoot .footer-total");
  }
  if (footer) {
    footer.innerHTML = `
        <td colspan="3">
          <div class="footer-sums">
            <div class="fs-item"><span class="fs-label">Receitas:</span> <span class="fs-valor receitas">${brMoeda(totalReceitas)}</span></div>
            <div class="fs-item"><span class="fs-label">Despesas:</span> <span class="fs-valor despesas">${brMoeda(totalDespesas)}</span></div>
            <div class="fs-item"><span class="fs-label">Saldo:</span> <span class="fs-valor saldo ${saldo >= 0 ? "positivo" : "negativo"}">${brMoeda(saldo)}</span></div>
          </div>
        </td>
        <td colspan="6"></td>
      `;
  } else {
    renderResumo();
  }
}

document.getElementById("formCF").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!STATE.pronto) return; // dados ainda carregando
  const dataBr = dataCFParaBr(document.getElementById("cfData").value);
  if (!dataBr) {
    document
      .getElementById("cfData")
      .setCustomValidity("Informe a data no formato DD/MM/AAAA.");
    document.getElementById("cfData").reportValidity();
    return;
  }
  document.getElementById("cfData").setCustomValidity("");
  const novo = {
    TIPO: document.getElementById("cfTipo").value,
    VALOR: parseFloat(document.getElementById("cfValor").value) || 0,
    DISCRIMINACAO: document.getElementById("cfDiscriminacao").value,
    DATA: dataBr,
    VENCIMENTO: document.getElementById("cfVencimento").value,
    ANO: parseInt(document.getElementById("cfAno").value, 10),
    ENTRADA_SAIDA: document.getElementById("cfEntradaSaida").value,
    OBSERVACAO:
      document.getElementById("cfObservacao").value || "GASTOS VARIÁVEIS",
  };
  if (indiceCFEditando === null) {
    STATE.cf.unshift(novo);
  } else if (STATE.cf[indiceCFEditando]) {
    STATE.cf[indiceCFEditando] = {
      ...STATE.cf[indiceCFEditando],
      ...novo,
    };
  }
  salvar(LS_KEYS.cf, STATE.cf);
  limparEdicaoCF();
  popularSelectsAnoMes();
  popularDropdownsCadastro();
  renderControleFinanceiro();
  renderResumo();
});

function iniciarEdicaoCF(idx) {
  const row = STATE.cf[idx];
  if (!row) return;
  indiceCFEditando = idx;
  const form = document.getElementById("formCF");
  document.getElementById("cfEntradaSaida").value =
    row.ENTRADA_SAIDA || "DESPESA";
  document.getElementById("cfEntradaSaida").dispatchEvent(new Event("change"));
  document.getElementById("cfTipo").value = row.TIPO || "";
  document.getElementById("cfValor").value = num(row.VALOR);
  document.getElementById("cfDiscriminacao").value = row.DISCRIMINACAO || "";
  document.getElementById("cfData").value = parseDataISO(row.DATA) || "";
  const vencimento = String(row.VENCIMENTO || mesDaDataBr(row.DATA) || "")
    .trim()
    .toUpperCase();
  const vencimentoEl = document.getElementById("cfVencimento");
  vencimentoEl.value = Array.from(vencimentoEl.options).some(
    (option) => option.value === vencimento,
  )
    ? vencimento
    : "";
  document.getElementById("cfAno").value =
    row.ANO || anoDaDataBr(row.DATA) || "";
  document.getElementById("cfObservacao").value = row.OBSERVACAO || "";
  form.querySelector('button[type="submit"]').textContent =
    "💾 Salvar alteração";
  let cancelar = document.getElementById("cfCancelarEdicao");
  if (!cancelar) {
    const submitButton = form.querySelector('button[type="submit"]');
    cancelar = document.createElement("button");
    cancelar.type = "button";
    cancelar.id = "cfCancelarEdicao";
    cancelar.className = "btn secondary full";
    cancelar.textContent = "Cancelar edição";
    cancelar.addEventListener("click", limparEdicaoCF);
    submitButton.parentElement.appendChild(cancelar);
  }
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function limparEdicaoCF() {
  indiceCFEditando = null;
  const form = document.getElementById("formCF");
  form.reset();
  form.querySelector('button[type="submit"]').textContent =
    "➕ Adicionar Lançamento";
  document.getElementById("cfCancelarEdicao")?.remove();
  document.getElementById("cfEntradaSaida").dispatchEvent(new Event("change"));
}

["cfFiltroAno", "cfFiltroMes", "cfFiltroTipo", "cfFiltroTexto"].forEach(
  (id) => {
    document
      .getElementById(id)
      .addEventListener("input", renderControleFinanceiro);
    document
      .getElementById(id)
      .addEventListener("change", renderControleFinanceiro);
  },
);

// ---------------------------------------------------------------------
// CONTROLE DE DÍVIDAS - CRUD
// ---------------------------------------------------------------------
function fecharSeletorObservacao() {
  document.querySelectorAll(".obs-popup-menu").forEach((el) => el.remove());
}

function filtrosCD() {
  const filtroObsEl = document.getElementById("cdFiltroObservacao");
  const filtroTextoEl = document.getElementById("cdFiltroTexto");
  return {
    ano: document.getElementById("cdFiltroAno").value,
    mes: document.getElementById("cdFiltroMes").value,
    condicao: document.getElementById("cdFiltroCondicao").value,
    observacao: filtroObsEl ? filtroObsEl.value : "",
    tipo: document.getElementById("cdFiltroTipo").value.trim().toLowerCase(),
    texto: filtroTextoEl ? filtroTextoEl.value.trim().toLowerCase() : "",
  };
}

function linhasFiltradasCD() {
  const f = filtrosCD();
  return STATE.cd
    .map((row, idx) => ({ row, idx }))
    .filter(({ row }) => {
      if (f.ano && String(row.ANO || anoDaDataBr(row.DATA)) !== String(f.ano))
        return false;
      if (f.mes && String(row.VENCIMENTO || mesDaDataBr(row.DATA)) !== f.mes)
        return false;
      if (f.condicao && row.CONDICAO !== f.condicao) return false;
      if (f.observacao && row.OBSERVACAO !== f.observacao) return false;
      if (
        f.tipo &&
        !String(row.TIPO || "")
          .toLowerCase()
          .includes(f.tipo)
      )
        return false;
      // DISCRIMINACAO pode vir nula da planilha/CSV: sempre tratar como texto
      if (
        f.texto &&
        !String(row.DISCRIMINACAO || "")
          .toLowerCase()
          .includes(f.texto)
      )
        return false;
      return true;
    });
}

function renderControleDividas() {
  const tbody = document.getElementById("tabelaCD");
  const linhas = linhasFiltradasCD();

  // volta para a 1ª página sempre que os filtros mudarem
  const assinatura = JSON.stringify(filtrosCD());
  if (assinatura !== assinaturaFiltros.cd) {
    assinaturaFiltros.cd = assinatura;
    PAGINA_CD = 1;
  }

  tbody.innerHTML = "";

  // Total do filtro completo (não apenas da página exibida)
  const total = linhas.reduce((acc, { row }) => acc + num(row.VALOR), 0);

  const paginas = Math.max(1, Math.ceil(linhas.length / POR_PAGINA));
  if (PAGINA_CD > paginas) PAGINA_CD = paginas;
  const inicio = (PAGINA_CD - 1) * POR_PAGINA;
  const linhasPagina = linhas.slice(inicio, inicio + POR_PAGINA);

  if (linhasPagina.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty-msg">Nenhuma dívida encontrada.</td></tr>`;
  }

  linhasPagina.forEach(({ row, idx }) => {
    const tr = document.createElement("tr");

    let condClass = "apagar";
    const condUpper = String(row.CONDICAO || "")
      .trim()
      .toUpperCase();
    if (condUpper === "PAGO") {
      condClass = "pago";
    } else if (condUpper === "RECEBIDO") {
      condClass = "recebido";
    } else if (condUpper === "À RECEBER" || condUpper === "A RECEBER") {
      condClass = "areceber";
    } else {
      condClass = "apagar";
    }

    const obsStr = String(row.OBSERVACAO || "").trim();
    const obsUpper = obsStr.toUpperCase();
    const obsTexto = esc(obsStr) || "—";
    const obsAtributos = `data-badge-obs="${esc(idx)}" title="Clique para selecionar observação"`;
    let obsHtml = `<span ${obsAtributos} style="cursor:pointer;">${obsTexto}</span>`;
    if (obsUpper === "RECEBIDO") {
      obsHtml = `<span class="badge recebido" ${obsAtributos} style="cursor:pointer;">${obsTexto}</span>`;
    } else if (obsUpper === "À RECEBER" || obsUpper === "A RECEBER") {
      obsHtml = `<span class="badge areceber" ${obsAtributos} style="cursor:pointer;">${obsTexto}</span>`;
    }

    // use centralized parser for parcela values to ensure consistent behavior
    const parsed = parseParcela(row);
    const parcelaLeft = String(row.PARCELAS ?? parsed.current ?? "").trim();
    const parcelaRight = String(row.QTD_PARCELAS ?? parsed.total ?? "").trim();
    tr.title = `PARCELAS=${parcelaLeft} | QTD_PARCELAS=${parcelaRight}`;
    const isUltimaParcela =
      parsed.current !== null &&
      parsed.total !== null &&
      parsed.current === parsed.total;

    // Aplica o destaque da última parcela com base no valor calculado
    // (sem depender da ausência de zebra nas linhas da tabela)
    if (isUltimaParcela) tr.classList.add("ultima-parcela");

    const parcelaCell = `${esc(parcelaLeft)}/${esc(parcelaRight)}${isUltimaParcela ? " ⭐" : ""}`;

    tr.innerHTML = `
      <td>${esc(row.TIPO)}</td>
      <td>${esc(row.DISCRIMINACAO)}</td>
      <td>${brMoeda(row.VALOR)}</td>
      <td class="parcela-cell">${parcelaCell}</td>
      <td>${esc(row.DATA)}</td>
      <td>${esc(row.VENCIMENTO || mesDaDataBr(row.DATA))}</td>
      <td>${esc(row.ANO || anoDaDataBr(row.DATA))}</td>
      <td><span class="badge ${condClass}" data-badge-cond="${esc(idx)}" style="cursor:pointer;" title="Clique para alternar condição">${esc(row.CONDICAO)}</span></td>
      <td>${obsHtml}</td>
      <td class="actions-col">
        <button title="Alternar Condição (À PAGAR ➔ PAGO ➔ À RECEBER ➔ RECEBIDO)" data-toggle-cd="${esc(idx)}">🔄</button>
        <button title="Selecionar Observação" data-btn-obs="${esc(idx)}">🏷️</button>
        <button title="Excluir" data-del-cd="${esc(idx)}">🗑️</button>
      </td>`;
    tbody.appendChild(tr);

    // Robust fallback: if parsed values were not conclusive but the parcela cell
    // contains explicit "X/Y" (e.g. "3/3"), force the ultima-parcela class
    // so these rows get the same visual highlight and hover behavior.
    try {
      const tdPar = tr.querySelector(".parcela-cell");
      if (tdPar) {
        const txt = tdPar.textContent.replace(/[⭐\s]/g, "").trim();
        // match first two numbers separated by non-digits (covers "3/3", " 3 / 3 ")
        const m = txt.match(/(\d+)\D+(\d+)/);
        if (m) {
          const a = Number(m[1]);
          const b = Number(m[2]);
          if (!isNaN(a) && !isNaN(b) && a === b) {
            tr.classList.add("ultima-parcela");
          }
        }
      }
    } catch (e) {
      // swallow any unexpected parsing errors — non-critical
    }
  });

  renderPager("cdPager", linhas.length, PAGINA_CD, (pagina) => {
    PAGINA_CD = pagina;
    renderControleDividas();
  });

  document.getElementById("cdTotalValor").textContent = brMoeda(total);

  tbody.querySelectorAll("[data-del-cd]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.delCd);
      if (confirm("Excluir esta dívida?")) {
        STATE.cd.splice(idx, 1);
        salvar(LS_KEYS.cd, STATE.cd);
        renderControleDividas();
        popularSelectsAnoMes();
      }
    });
  });

  // Alternador da opção condição (cicla entre as 4 condições disponíveis)
  const alternarCondicao = (idx) => {
    const row = STATE.cd[idx];
    const CONDICOES_ORDEM = ["À PAGAR", "PAGO", "À RECEBER", "RECEBIDO"];
    const condAtual = String(row.CONDICAO || "")
      .trim()
      .toUpperCase();

    let idxAtual = -1;
    if (condAtual === "À PAGAR" || condAtual === "A PAGAR") idxAtual = 0;
    else if (condAtual === "PAGO") idxAtual = 1;
    else if (condAtual === "À RECEBER" || condAtual === "A RECEBER")
      idxAtual = 2;
    else if (condAtual === "RECEBIDO") idxAtual = 3;

    const proxIdx = (idxAtual + 1) % CONDICOES_ORDEM.length;
    row.CONDICAO = CONDICOES_ORDEM[proxIdx];
    salvar(LS_KEYS.cd, STATE.cd);
    renderControleDividas();
  };

  tbody.querySelectorAll("[data-toggle-cd]").forEach((btn) => {
    btn.addEventListener("click", () => {
      alternarCondicao(Number(btn.dataset.toggleCd));
    });
  });

  tbody.querySelectorAll("[data-badge-cond]").forEach((badge) => {
    badge.addEventListener("click", () => {
      alternarCondicao(Number(badge.dataset.badgeCond));
    });
  });

  // Botão seletor para a opção observação (menu popup para escolha direta)
  const abrirSeletorObs = (alvo, idx) => {
    fecharSeletorObservacao();
    const menu = document.createElement("div");
    menu.className = "obs-popup-menu";
    menu.innerHTML = `
      <div class="obs-popup-header">Selecionar Observação</div>
      <button type="button" class="obs-popup-item" data-obs-val="GASTOS FIXOS">GASTOS FIXOS</button>
      <button type="button" class="obs-popup-item" data-obs-val="PARCELADOS">PARCELADOS</button>
      <button type="button" class="obs-popup-item item-recebido" data-obs-val="RECEBIDO">RECEBIDO</button>
      <button type="button" class="obs-popup-item item-areceber" data-obs-val="À RECEBER">À RECEBER</button>
    `;
    document.body.appendChild(menu);

    const rect = alvo.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 4}px`;
    const menuWidth = 160;
    let left = rect.left + rect.width / 2 - menuWidth / 2;
    if (left + menuWidth > window.innerWidth - 10)
      left = window.innerWidth - menuWidth - 10;
    if (left < 10) left = 10;
    menu.style.left = `${left}px`;

    menu.querySelectorAll(".obs-popup-item").forEach((item) => {
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        STATE.cd[idx].OBSERVACAO = item.dataset.obsVal;
        salvar(LS_KEYS.cd, STATE.cd);
        fecharSeletorObservacao();
        renderControleDividas();
      });
    });

    setTimeout(() => {
      const clickFora = (e) => {
        if (!menu.contains(e.target)) {
          fecharSeletorObservacao();
          document.removeEventListener("click", clickFora);
          window.removeEventListener("scroll", clickFora, true);
        }
      };
      document.addEventListener("click", clickFora);
      window.addEventListener("scroll", clickFora, true);
    }, 10);
  };

  tbody.querySelectorAll("[data-btn-obs]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      abrirSeletorObs(btn, Number(btn.dataset.btnObs));
    });
  });

  tbody.querySelectorAll("[data-badge-obs]").forEach((badge) => {
    badge.addEventListener("click", (e) => {
      e.stopPropagation();
      abrirSeletorObs(badge, Number(badge.dataset.badgeObs));
    });
  });
}

// ---------------------------------------------------------------------
// PARCELAMENTO AUTOMÁTICO (aba Controle de Dívidas)
// Regra: uma compra parcelada é faturada no mês seguinte ao da data
// informada e as demais parcelas são geradas automaticamente para os
// meses seguintes (equivalente ao EDATE(data;1) da planilha).
// ---------------------------------------------------------------------
function addMesesData(dataBr, meses) {
  const partes = String(dataBr || "").split("/");
  if (partes.length !== 3) return null;
  const dia = parseInt(partes[0], 10);
  const mes = parseInt(partes[1], 10);
  const ano = parseInt(partes[2], 10);
  if (!dia || !mes || !ano) return null;

  const total = ano * 12 + (mes - 1) + (Number(meses) || 0);
  const anoFinal = Math.floor(total / 12);
  const mesIdx = total - anoFinal * 12; // 0..11
  const ultimoDia = new Date(anoFinal, mesIdx + 1, 0).getDate();
  const diaFinal = Math.min(dia, ultimoDia); // ex.: 31/01 -> 28/02

  return {
    dia: diaFinal,
    mes: mesIdx + 1,
    ano: anoFinal,
    dataBr: `${String(diaFinal).padStart(2, "0")}/${String(mesIdx + 1).padStart(2, "0")}/${anoFinal}`,
  };
}

// Vencimento (fatura) = mês seguinte ao da data informada
function faturaDe(dataBr) {
  return addMesesData(dataBr, 1);
}

// Lança as parcelas seguintes automaticamente, exceto para "GASTOS FIXOS"
// (contas de valor variável, lançadas mês a mês com o valor real).
function gerarParcelasAutomaticas(observacao, qtdParcelas) {
  const obs = String(observacao || "")
    .trim()
    .toUpperCase();
  return qtdParcelas > 1 && obs !== "GASTOS FIXOS";
}

// Parcelas ainda não faturadas permanecem em aberto
function condicaoParcelasFuturas(condicao, observacao) {
  const texto = `${condicao || ""} ${observacao || ""}`.toUpperCase();
  if (texto.includes("RECEBER") || texto.includes("RECEBIDO"))
    return "À RECEBER";
  return "À PAGAR";
}

// Lê o formulário e monta o plano de faturamento/parcelas
function planoParcelasCD() {
  const dataISO = document.getElementById("cdData").value;
  const dataBr = dataISOParaBr(dataISO);
  const valor = parseFloat(document.getElementById("cdValor").value) || 0;
  const qtdParcelas = Math.max(
    1,
    parseInt(document.getElementById("cdQtdParcelas").value, 10) || 1,
  );
  let parcelaInicial = Math.max(
    1,
    parseInt(document.getElementById("cdParcelas").value, 10) || 1,
  );
  if (parcelaInicial > qtdParcelas) parcelaInicial = qtdParcelas;

  const observacao = document.getElementById("cdObservacao").value;
  const geraAutomatico = gerarParcelasAutomaticas(observacao, qtdParcelas);
  const parcelasGeradas = geraAutomatico ? qtdParcelas - parcelaInicial + 1 : 1;

  return {
    dataISO,
    dataBr,
    dataValida: !!dataBr,
    valor,
    qtdParcelas,
    parcelaInicial,
    observacao,
    geraAutomatico,
    parcelasGeradas,
  };
}

// O ano exibido no formulário é o ano da fatura (mês seguinte à data)
function sincronizarAnoFaturaCD() {
  const anoEl = document.getElementById("cdAno");
  if (!anoEl) return;
  const dataBr = dataISOParaBr(document.getElementById("cdData").value);
  const fatura = faturaDe(dataBr);
  anoEl.value = fatura ? fatura.ano : "";
}

function atualizarPreviewParcelasCD() {
  const el = document.getElementById("cdParcelasInfo");
  if (!el) return;

  const plano = planoParcelasCD();
  const rotulo = (f) => `${MESES[f.mes - 1]}/${f.ano}`;

  if (!plano.dataValida || plano.valor <= 0) {
    el.textContent =
      "Informe a data da compra e o valor da parcela para ver o plano de faturamento.";
    return;
  }

  // A 1ª parcela lançada usa a data informada; a última soma as demais parcelas
  const primeira = faturaDe(plano.dataBr);
  const total = Math.round(plano.valor * plano.parcelasGeradas * 100) / 100;
  const qtdTexto = plano.parcelasGeradas === 1 ? "parcela" : "parcelas";

  if (!plano.geraAutomatico) {
    el.textContent =
      `💳 1 lançamento (parcela ${plano.parcelaInicial}/${plano.qtdParcelas}) ` +
      `faturado em ${rotulo(primeira)} — com "GASTOS FIXOS" as parcelas seguintes não são geradas automaticamente.`;
    return;
  }

  const ultima = faturaDe(
    addMesesData(plano.dataBr, plano.parcelasGeradas - 1).dataBr,
  );
  const periodo =
    plano.parcelasGeradas === 1
      ? `faturada em ${rotulo(primeira)}`
      : `faturadas de ${rotulo(primeira)} a ${rotulo(ultima)}`;

  el.textContent =
    `🔁 ${plano.parcelasGeradas} ${qtdTexto} de ${brMoeda(plano.valor)} ${periodo} ` +
    `(1ª fatura no mês seguinte à data) · Total: ${brMoeda(total)}`;
}

document.getElementById("formCD").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!STATE.pronto) return; // dados ainda carregando
  const plano = planoParcelasCD();
  if (!plano.dataValida) return;

  const tipo = document.getElementById("cdTipo").value;
  const discriminacao = document.getElementById("cdDiscriminacao").value;
  const condicao = document.getElementById("cdCondicao").value;
  const valorParcela = Math.round(plano.valor * 100) / 100;

  // 1ª parcela: faturada no mês seguinte ao da data informada.
  // Demais parcelas: geradas automaticamente para os meses seguintes.
  const ultimaParcela = plano.geraAutomatico
    ? plano.qtdParcelas
    : plano.parcelaInicial;

  const novas = [];
  for (let p = plano.parcelaInicial; p <= ultimaParcela; p++) {
    const dataParcela = addMesesData(plano.dataBr, p - plano.parcelaInicial);
    const fatura = faturaDe(dataParcela.dataBr);
    novas.push({
      TIPO: tipo,
      DISCRIMINACAO: discriminacao,
      VALOR: valorParcela,
      PARCELAS: p,
      QTD_PARCELAS: plano.qtdParcelas,
      DATA: dataParcela.dataBr,
      VENCIMENTO: MESES[fatura.mes - 1],
      ANO: fatura.ano,
      CONDICAO:
        p === plano.parcelaInicial
          ? condicao
          : condicaoParcelasFuturas(condicao, plano.observacao),
      OBSERVACAO: plano.observacao,
    });
  }

  STATE.cd.unshift(...novas);
  salvar(LS_KEYS.cd, STATE.cd);

  e.target.reset();
  document.getElementById("cdParcelas").value = 1;
  document.getElementById("cdQtdParcelas").value = 1;
  // Mantém a data da compra para facilitar lançamentos sequenciais
  document.getElementById("cdData").value = plano.dataISO;
  sincronizarAnoFaturaCD();
  atualizarPreviewParcelasCD();
  popularSelectsAnoMes();
  renderControleDividas();
});

// Atualiza o ano da fatura e o resumo do parcelamento enquanto o usuário digita
[
  "cdData",
  "cdValor",
  "cdParcelas",
  "cdQtdParcelas",
  "cdCondicao",
  "cdObservacao",
].forEach((id) => {
  const el = document.getElementById(id);
  if (!el) return;
  const atualizar = () => {
    sincronizarAnoFaturaCD();
    atualizarPreviewParcelasCD();
  };
  el.addEventListener("input", atualizar);
  el.addEventListener("change", atualizar);
});

[
  "cdFiltroAno",
  "cdFiltroMes",
  "cdFiltroCondicao",
  "cdFiltroObservacao",
  "cdFiltroTipo",
].forEach((id) => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener("input", renderControleDividas);
    el.addEventListener("change", renderControleDividas);
  }
});

// ---------------------------------------------------------------------
// CADASTROS
// ---------------------------------------------------------------------
const CADASTRO_UI = [
  {
    chave: "gastos_variaveis",
    ul: "listaGastosVariaveis",
    input: "novoGastoVariavel",
  },
  {
    chave: "fixos_parcelados",
    ul: "listaFixosParcelados",
    input: "novoFixoParcelado",
  },
  {
    chave: "receitas_variaveis",
    ul: "listaReceitasVariaveis",
    input: "novaReceitaVariavel",
  },
  { chave: "receitas", ul: "listaReceitas", input: "novaReceita" },
  { chave: "cartoes_credito", ul: "listaCartoes", input: "novoCartao" },
];

function renderCadastros() {
  CADASTRO_UI.forEach(({ chave, ul }) => {
    const container = document.getElementById(ul);
    const itens = STATE.cad[chave] || [];
    container.innerHTML = "";
    if (itens.length === 0) {
      container.innerHTML = `<li class="empty-msg">Nenhum item</li>`;
      return;
    }
    itens.forEach((item, idx) => {
      const li = document.createElement("li");
      li.innerHTML = `<span>${esc(item)}</span><button title="Remover" data-lista="${esc(chave)}" data-idx="${esc(idx)}">✕</button>`;
      container.appendChild(li);
    });
  });

  document.querySelectorAll(".cadastro-list li button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const { lista, idx } = btn.dataset;
      if (confirm("Remover este item da lista?")) {
        STATE.cad[lista].splice(Number(idx), 1);
        salvar(LS_KEYS.cad, STATE.cad);
        renderCadastros();
        popularDropdownsCadastro();
      }
    });
  });
}

document.querySelectorAll(".cadastro-list .add-row button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const lista = btn.dataset.lista;
    const config = CADASTRO_UI.find((c) => c.chave === lista);
    const input = document.getElementById(config.input);
    const valor = input.value.trim();
    if (!valor) return;
    if (!STATE.cad[lista]) STATE.cad[lista] = [];
    STATE.cad[lista].push(valor);
    salvar(LS_KEYS.cad, STATE.cad);
    input.value = "";
    renderCadastros();
    popularDropdownsCadastro();
  });
});

// ---------------------------------------------------------------------
// IMPORTAÇÃO DE CSV (extrato bancário ou fatura de cartão)
// ---------------------------------------------------------------------
function parseCSV(texto) {
  const linhas = texto.split(/\r\n|\n/).filter((l) => l.trim() !== "");
  if (linhas.length === 0) return { headers: [], rows: [] };

  function parseLinha(linha) {
    const campos = [];
    let atual = "";
    let dentroAspas = false;
    for (let i = 0; i < linha.length; i++) {
      const c = linha[i];
      if (c === '"') {
        dentroAspas = !dentroAspas;
      } else if (c === "," && !dentroAspas) {
        campos.push(atual);
        atual = "";
      } else {
        atual += c;
      }
    }
    campos.push(atual);
    return campos.map((c) => c.trim());
  }

  const headers = parseLinha(linhas[0]);
  const rows = linhas.slice(1).map((linha) => {
    const campos = parseLinha(linha);
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = campos[i] !== undefined ? campos[i] : "";
    });
    return obj;
  });
  return { headers, rows };
}

function valorParaNumero(str, formatoBanco) {
  if (str === undefined || str === null || str === "") return 0;
  let s = String(str).trim();
  if (formatoBanco) {
    // "1.234,56" -> remove milhar "." depois troca "," por "."
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    // "1234.56" ou "1234,56"
    s = s.includes(",") && !s.includes(".") ? s.replace(",", ".") : s;
  }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function processarFaturaCartao(rows) {
  const novos = [];
  rows.forEach((r) => {
    const descricao = r["Descrição"] || r["Descricao"] || "";
    if (/SALDO|PAGTO|CASH/i.test(descricao)) return;
    const valor = valorParaNumero(r["Valor"], false);
    if (valor <= 0) return;
    const data = (r["Data"] || "").trim();
    if (!data) return;
    novos.push({
      TIPO: r["Categoria"] || "DIVERSOS",
      VALOR: Math.round(valor * 100) / 100,
      DISCRIMINACAO: descricao.trim(),
      DATA: data,
      VENCIMENTO: mesDaDataBr(data),
      ANO: parseInt(anoDaDataBr(data), 10),
      ENTRADA_SAIDA: "DESPESA",
      OBSERVACAO: "FATURA CARTÃO",
    });
  });
  return novos;
}

function processarExtratoBanco(rows) {
  const palavrasSaldo = ["Saldo Anterior", "Saldo do dia", "S A L D O"];
  const filtroCartao = /CARTAO|CARTÃO|COMPRA|VISA|MASTER|ELO|CRED|CRÉDITO/i;
  const filtroDebito = /DEBITO|DÉBITO/i;
  const novos = [];
  rows.forEach((r) => {
    const lancamento = (r["Lançamento"] || r["Lancamento"] || "").trim();
    if (!lancamento || palavrasSaldo.includes(lancamento)) return;
    const tipoLanc = (r["Tipo Lançamento"] || r["Tipo Lancamento"] || "")
      .trim()
      .toUpperCase();
    if (tipoLanc !== "SAÍDA" && tipoLanc !== "SAIDA") return;
    if (!filtroCartao.test(lancamento) || filtroDebito.test(lancamento)) return;
    const valor = valorParaNumero(r["Valor"], true);
    const data = (r["Data"] || "").trim();
    if (!data) return;
    const detalhes = (r["Detalhes"] || "").trim();
    novos.push({
      TIPO: "DIVERSOS",
      VALOR: Math.round(Math.abs(valor) * 100) / 100,
      DISCRIMINACAO: detalhes ? `${lancamento} - ${detalhes}` : lancamento,
      DATA: data,
      VENCIMENTO: mesDaDataBr(data),
      ANO: parseInt(anoDaDataBr(data), 10),
      ENTRADA_SAIDA: "DESPESA",
      OBSERVACAO: "EXTRATO BB",
    });
  });
  return novos;
}

function importarCSV(texto) {
  const { headers, rows } = parseCSV(texto);
  const headersLower = headers.map((h) => h.toLowerCase());
  const ehCartao =
    headersLower.some((h) => h.includes("descri")) &&
    headersLower.some((h) => h.includes("categor"));
  const ehBanco =
    headersLower.some((h) => h.includes("lança") || h.includes("lanca")) &&
    headersLower.some((h) => h.includes("tipo"));

  let novos = [];
  let tipoDetectado = "desconhecido";
  if (ehCartao) {
    novos = processarFaturaCartao(rows);
    tipoDetectado = "fatura de cartão de crédito";
  } else if (ehBanco) {
    novos = processarExtratoBanco(rows);
    tipoDetectado = "extrato bancário (BB)";
  } else {
    throw new Error(
      "Formato de CSV não reconhecido. Verifique se o arquivo tem as colunas esperadas.",
    );
  }

  STATE.cf = [...novos, ...STATE.cf];
  salvar(LS_KEYS.cf, STATE.cf);
  return {
    total: novos.length,
    soma: novos.reduce((acc, n) => acc + num(n.VALOR), 0),
    tipoDetectado,
  };
}

// Reconstrói o texto de uma página em linhas (pdf.js só devolve "items"
// soltos com posição x/y — sem isso, transações de linhas diferentes
// ficariam grudadas e a regex abaixo não conseguiria separá-las).
function linhasDaPaginaPDF(textContent) {
  const porLinha = new Map();
  textContent.items.forEach((item) => {
    const y = Math.round(item.transform[5]);
    if (!porLinha.has(y)) porLinha.set(y, []);
    porLinha.get(y).push(item);
  });
  const ys = Array.from(porLinha.keys()).sort((a, b) => b - a); // topo -> base
  return ys
    .map((y) =>
      porLinha
        .get(y)
        .sort((a, b) => a.transform[4] - b.transform[4])
        .map((item) => item.str)
        .join(" "),
    )
    .join("\n");
}

async function extrairTextoPDF(arquivo) {
  if (typeof window.pdfjsLib === "undefined") {
    throw new Error(
      "Biblioteca de leitura de PDF ainda não carregou. Recarregue a página e tente novamente.",
    );
  }
  const buffer = await arquivo.arrayBuffer();
  const doc = await window.pdfjsLib.getDocument({ data: buffer }).promise;
  let linhas = "";
  let bruto = ""; // ordem "de leitura" do PDF (rótulo e valor ficam próximos,
  // mesmo quando estão em caixas/colunas que a reconstrução por linha separa)
  for (let i = 1; i <= doc.numPages; i++) {
    const pagina = await doc.getPage(i);
    const conteudo = await pagina.getTextContent();
    linhas += linhasDaPaginaPDF(conteudo) + "\n";
    bruto += conteudo.items.map((item) => item.str).join(" ") + " ";
  }
  return { linhas, bruto };
}

// Importação de fatura em PDF: 100% no navegador via pdf.js (sem backend).
// Extrai o texto de todas as páginas, acha o vencimento da fatura no
// cabeçalho e casa as linhas de lançamento com uma regex flexível
// (compatível com Nubank, Inter, Bradesco, BB, etc.).
async function importarPDF(arquivo) {
  const { linhas: texto, bruto } = await extrairTextoPDF(arquivo);
  const hoje = new Date();

  const mVencimento = bruto.match(
    /vencimento[^\d]{0,20}(\d{2})\/(\d{2})\/(\d{4})/i,
  );
  const mesFatura = mVencimento
    ? parseInt(mVencimento[2], 10)
    : hoje.getMonth() + 1;
  const anoFatura = mVencimento
    ? parseInt(mVencimento[3], 10)
    : hoje.getFullYear();
  const vencimentoStr = mVencimento
    ? `${mVencimento[1]}/${mVencimento[2]}/${mVencimento[3]}`
    : null;

  // Classificação heurística do TIPO a partir das palavras-chave da descrição
  // (heurística simples; o usuário pode ajustar o TIPO depois na aba
  // Controle Financeiro).
  function detectarTipo(desc) {
    const d = desc.toUpperCase();
    if (d.match(/UBER|99|TAXI|COMBUST|POSTO|SHELL|IPIRANGA/)) return "TRANSPORTE";
    if (d.match(/IFOOD|RAPPI|RESTAUR|LANCH|MERCADO|SUPERM|ATACADAO|ASSAI|PADARIA|ACAI/))
      return "ALIMENTAÇÃO";
    if (d.match(/FARMACIA|DROGASIL|DROGA|PAGUE MENOS/)) return "SAÚDE";
    if (d.match(/NETFLIX|SPOTIFY|GLOBOPLAY|PRIME|YOUTUBE|DISNEY|HBO|AMAZON PRIME/))
      return "LAZER";
    if (d.match(/LUZ|ENERGIA|AGUA|INTERNET|CLARO|VIVO|TIM|OI/))
      return "CONTAS FIXAS";
    if (d.match(/SHEIN|SHOPEE|MERCADO LIVRE|AMAZON|MAGALU|AMERICANAS/))
      return "COMPRAS";
    return "GASTOS VARIÁVEIS";
  }

  // Descrição normalizada (maiúsculas, sem espaços nas bordas nem duplicados
  // vindos da reconstrução das colunas do PDF).
  function normalizarDescricao(desc) {
    return desc.toUpperCase().trim().replace(/\s{2,}/g, " ");
  }

  const REGEX_LANCAMENTO = /(\d{2}\/\d{2})\s+(.+?)\s+R\$?\s*(-?[\d.,]+)/g;
  const novos = [];
  let m;
  while ((m = REGEX_LANCAMENTO.exec(texto)) !== null) {
    const [, dataCompra, descricaoBruta, valorStr] = m;
    const descricao = descricaoBruta.trim();
    if (/SALDO|PGTO|PAGAMENTO|CASH/i.test(descricao)) continue;
    const valor = valorParaNumero(valorStr, true);
    if (valor <= 0) continue;

    const [diaStr, mesStr] = dataCompra.split("/");
    const mesCompra = parseInt(mesStr, 10);
    // Compras parceladas antigas (mês da compra > mês de fechamento) são do ano anterior.
    const anoCompra = mesCompra > mesFatura ? anoFatura - 1 : anoFatura;
    novos.push({
      TIPO: detectarTipo(descricao),
      VALOR: Math.round(valor * 100) / 100,
      DISCRIMINACAO: normalizarDescricao(descricao),
      DATA: `${diaStr}/${mesStr}/${anoCompra}`,
      VENCIMENTO: MESES[mesFatura - 1],
      ANO: anoFatura,
      ENTRADA_SAIDA: "DESPESA",
      OBSERVACAO: "FATURA CARTÃO (PDF)",
    });
  }

  if (novos.length === 0) {
    throw new Error(
      "Nenhum lançamento encontrado no PDF (verifique se é uma fatura de cartão).",
    );
  }

  STATE.cf = [...novos, ...STATE.cf];
  salvar(LS_KEYS.cf, STATE.cf);
  return {
    total: novos.length,
    soma: novos.reduce((acc, n) => acc + num(n.VALOR), 0),
    mesVencimento: MESES[mesFatura - 1],
    anoVencimento: anoFatura,
    tipoDetectado: vencimentoStr
      ? `fatura de cartão (PDF) — vencimento ${vencimentoStr} (competência ${MESES[mesFatura - 1]}/${anoFatura})`
      : "fatura de cartão (PDF) — vencimento não encontrado no PDF, usado mês atual",
  };
}

// Bloqueia importação enquanto os dados da nuvem não carregaram: sem base,
// um lançamento novo sobrescreveria o documento do usuário no próximo envio.
function dadosProntosParaEdicao(statusEl) {
  if (STATE.pronto) return true;
  if (statusEl) {
    statusEl.style.color = "#d93025";
    statusEl.textContent =
      "⚠️ Seus dados ainda não foram carregados da nuvem. Use o botão \"Tentar novamente\" no topo e importe depois.";
  }
  return false;
}

document.getElementById("cfImportBtn").addEventListener("click", () => {
  const input = document.getElementById("cfImportFile");
  const status = document.getElementById("cfImportStatus");
  const arquivo = input.files[0];
  if (!arquivo) {
    status.textContent = "Selecione um arquivo CSV ou PDF primeiro.";
    status.style.color = "#d93025";
    return;
  }
  if (!dadosProntosParaEdicao(status)) return;

  const ehPDF = /\.pdf$/i.test(arquivo.name);
  if (ehPDF) {
    status.style.color = "#5f6368";
    status.textContent = "⏳ Extraindo PDF...";
    importarPDF(arquivo)
      .then((resultado) => {
        status.style.color = "#1e8e3e";
        status.textContent = `✅ ${resultado.total} lançamentos importados (${resultado.tipoDetectado}) — total ${brMoeda(resultado.soma)}`;
        popularSelectsAnoMes();
        popularDropdownsCadastro();
        // Seleciona automaticamente o filtro para a competência (mês/ano do vencimento)
        if (resultado.mesVencimento) {
          const filtroAno = document.getElementById("cfFiltroAno");
          const filtroMes = document.getElementById("cfFiltroMes");
          if (filtroAno && resultado.anoVencimento)
            filtroAno.value = String(resultado.anoVencimento);
          if (filtroMes) filtroMes.value = resultado.mesVencimento;
        }
        renderControleFinanceiro();
        renderResumo();
        input.value = "";
      })
      .catch((err) => {
        status.style.color = "#d93025";
        status.textContent = `❌ ${err.message}`;
      });
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const resultado = importarCSV(e.target.result);
      status.style.color = "#1e8e3e";
      status.textContent = `✅ ${resultado.total} lançamentos importados (${resultado.tipoDetectado}) — total ${brMoeda(resultado.soma)}`;
      popularSelectsAnoMes();
      popularDropdownsCadastro();
      renderControleFinanceiro();
      renderResumo();
      input.value = "";
    } catch (err) {
      status.style.color = "#d93025";
      status.textContent = `❌ ${err.message}`;
    }
  };
  reader.onerror = () => {
    status.style.color = "#d93025";
    status.textContent = "❌ Não foi possível ler o arquivo.";
  };
  reader.readAsText(arquivo, "utf-8");
});

// ---------------------------------------------------------------------
// GRÁFICOS (Canvas nativo, sem dependências externas)
// ---------------------------------------------------------------------
const CORES_GRAFICO = [
  "#ff6b3d", // warm orange
  "#ff9f43", // amber
  "#ffd166", // soft gold
  "#4aa3ff", // neon blue
  "#8b5cf6", // purple
  "#ff5c8a", // pink
];

// == GRAFICOS-RESPONSIVOS (inicio) ==
// (o bloco entre estes marcadores é extraído por tools/_test_chart_responsivo.mjs)
const ALTURA_GRAFICO_PADRAO = 360; // mesma altura do .grafico-canvas-container no CSS

// Equivalente às "options" do Chart.js usadas neste projeto (canvas nativo):
//   responsive: true, maintainAspectRatio: false  -> a largura vem do CSS
//   (100% do container) e a altura também vem do CSS, sem o JS fixar altura.
//   aspectRatio: 1.6 no celular -> altura de segurança = largura / 1.6,
//   respeitando o teto de 320px (max-height do container no @media 768px).
const OPCOES_GRAFICO = {
  responsive: true,
  maintainAspectRatio: false,
  aspectRatio: 1.6,
  mediaMobile: "(max-width: 768px)",
  alturaMobileMax: 320, // = max-height: 320px do container no celular
  alturaMobileMin: 180, // evita gráfico achatado se a largura for mínima
};

// Altura efetiva do canvas: quem manda é o CSS (media queries por breakpoint).
// clientHeight = 0 quando o canvas está escondido (aba não ativa), então nesse
// caso use getComputedStyle, que resolve a altura das media queries mesmo com
// display:none. 0 no retorno = não há altura confiável (fallback).
function alturaCanvasCss(canvas) {
  const visivel = Math.round(canvas.clientHeight || 0);
  if (visivel > 0) return visivel;
  try {
    const alt = parseFloat(window.getComputedStyle(canvas).height);
    if (isFinite(alt) && alt > 0) return Math.round(alt);
  } catch (e) {
    /* segue para o último recurso */
  }
  const attr = parseInt(
    canvas.dataset.alturaBase || canvas.getAttribute("height") || "",
    10,
  );
  return isFinite(attr) && attr > 0 ? attr : 0;
}

// Corta o texto com "…" para a legenda não vazar da área disponível no celular
function encurtarTexto(ctx, texto, larguraMax) {
  if (!larguraMax || larguraMax <= 0) return texto;
  if (ctx.measureText(texto).width <= larguraMax) return texto;
  let t = texto;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > larguraMax)
    t = t.slice(0, -1);
  return `${t}…`;
}

// Estamos no layout de celular? Mesmo breakpoint do CSS (max-width: 768px).
// matchMedia é o caminho normal; innerWidth é o fallback (ex.: ambiente de
// teste em Node, sem window.matchMedia).
function ehLayoutMobile() {
  try {
    if (typeof window.matchMedia === "function")
      return window.matchMedia(OPCOES_GRAFICO.mediaMobile).matches;
  } catch (e) {
    /* segue para o fallback */
  }
  return window.innerWidth > 0 && window.innerWidth <= 768;
}

// Altura do canvas quando o CSS não define nenhuma (último recurso): no celular
// equivale ao aspectRatio 1.6 (largura / 1.6), limitado entre 180px e 320px;
// no desktop mantém a altura padrão.
function alturaCanvasFallback(largura) {
  if (!ehLayoutMobile()) return ALTURA_GRAFICO_PADRAO;
  const altura = Math.round(largura / OPCOES_GRAFICO.aspectRatio);
  return Math.min(
    OPCOES_GRAFICO.alturaMobileMax,
    Math.max(OPCOES_GRAFICO.alturaMobileMin, altura),
  );
}

// O usuário pediu para reduzir animações no sistema? A animação de entrada dos
// gráficos é um enfeite opcional e deve ser pulada nesse caso.
function prefereMenosMovimento() {
  try {
    if (typeof window.matchMedia === "function")
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch (e) {
    /* sem matchMedia: pode animar */
  }
  return false;
}

// Equivalente, em canvas nativo, ao "responsive: true / maintainAspectRatio:
// false" do Chart.js: largura = 100% do container (CSS) e altura também vinda
// do CSS, com o buffer multiplicado pelo devicePixelRatio para o desenho sair
// nítido no celular (dpr 2~3). O JS nunca fixa altura inline — se fixasse, o
// valor inline venceria as media queries e o gráfico voltaria a ficar prensado.
function limparCanvas(ctx, canvas) {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const larguraCss = Math.max(
    1,
    Math.round(canvas.clientWidth || canvas.getBoundingClientRect().width || 300),
  );

  let alturaBase = alturaCanvasCss(canvas);
  if (!alturaBase) {
    // Último recurso: CSS sem altura definida nesse canvas
    alturaBase = alturaCanvasFallback(larguraCss);
    canvas.style.height = alturaBase + "px";
  }

  // Teto de altura no celular (max-height: 320px do container). Fica também
  // aqui, e não só no CSS, para o caso de o service worker servir um CSS
  // antigo em cache — o desenho nunca passa de 320px no celular.
  if (ehLayoutMobile())
    alturaBase = Math.min(alturaBase, OPCOES_GRAFICO.alturaMobileMax);

  canvas.width = Math.round(larguraCss * dpr);
  canvas.height = Math.round(alturaBase * dpr);

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, larguraCss, alturaBase);
  return { w: larguraCss, h: alturaBase };
}
// == GRAFICOS-RESPONSIVOS (fim) ==

// Composite chart: Receitas/Despesas em áreas suaves + linha de Saldo
// (visão anual do Resumo). Paleta fixa desta visão — a legenda é pintada com
// exatamente as mesmas cores das linhas.
const CORES_ANUAL = {
  receita: "#3b82f6", // azul
  despesa: "#f97316", // laranja
  saldoPositivo: "#22c55e", // verde (saldo >= 0)
  saldoNegativo: "#ef4444", // vermelho (saldo < 0)
  // preenchimento em degradê: rgba(cor, 0.3) -> rgba(cor, 0)
  receitaFillInicio: "rgba(59,130,246,0.3)",
  receitaFillFim: "rgba(59,130,246,0)",
  despesaFillInicio: "rgba(249,115,22,0.3)",
  despesaFillFim: "rgba(249,115,22,0)",
};

// Fim do degradê de preenchimento: ctx.createLinearGradient(0, 0, 0, 300)
const FIM_DEGRADE_ANUAL = 300;

// "tension" 0.4 (Chart.js): pontos de controle a 40% / 60% de cada trecho.
const TENSAO_ANUAL = 0.4;

// Cor da linha de Saldo: verde com saldo >= 0 e vermelho quando fica negativo.
function corSaldoAnual(valor) {
  return (valor || 0) >= 0
    ? CORES_ANUAL.saldoPositivo
    : CORES_ANUAL.saldoNegativo;
}

function drawCompositeBarLineChart(canvasId, labels, receitas, despesas) {
  try {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    // remove listeners e animação anteriores (re-render por resize/aba) para
    // não duplicar eventos nem deixar dois loops de animação no mesmo canvas
    if (canvas._hg_chartHandlers) {
      Object.entries(canvas._hg_chartHandlers).forEach(([tipo, fn]) =>
        canvas.removeEventListener(tipo, fn),
      );
      canvas._hg_chartHandlers = null;
    }
    if (canvas._hg_chartAnim && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(canvas._hg_chartAnim);
      canvas._hg_chartAnim = null;
    }

    const { w, h } = limparCanvas(ctx, canvas);

    // ensure arrays
    if (!Array.isArray(receitas)) receitas = [];
    if (!Array.isArray(despesas)) despesas = [];
    while (receitas.length < labels.length) receitas.push(0);
    while (despesas.length < labels.length) despesas.push(0);

    const saldos = receitas.map((r, i) => (r || 0) - (despesas[i] || 0));
    const all = [...receitas, ...despesas, ...saldos].map((v) => v || 0);
    const minVal = Math.min(0, ...all);
    const maxVal = Math.max(1, ...all);

    // No celular o gráfico da visão anual cabe na largura da tela (375px): os
    // paddings, a fonte e os rótulos do eixo Y encolhem para nada ser cortado.
    // No desktop (canvas largo) tudo mantém as medidas originais.
    const mobile = ehLayoutMobile();
    const estreito = w < 480;
    const padLeft = estreito ? 46 : 56,
      padRight = estreito ? 12 : 20,
      padTop = 34, // topo reservado para a legenda das três séries
      padBottom = estreito ? 40 : 56;
    const areaW = w - padLeft - padRight;
    const areaH = h - padTop - padBottom;
    const raioPonto = mobile ? 2 : 0; // pointRadius: 2 no celular, 0 no desktop
    const fonteEixo = estreito ? "10px Segoe UI" : "11px Segoe UI";

    // 12 meses num canvas estreito (375px de tela ≈ 259px de canvas) dariam
    // ~18px por mês: nesse caso mostra um mês sim, outro não (JAN, MAR, MAI...)
    // para os rótulos não se encostarem.
    const espacoMes = areaW / Math.max(1, labels.length - 1);
    const pularRotuloX = espacoMes < 24 ? 2 : 1;

    // Saldo acumulado do ano define a cor do item "Saldo" da legenda.
    const corSaldoResumo = corSaldoAnual(saldos.reduce((acc, v) => acc + v, 0));

    // Rótulo do eixo Y: moeda completa no desktop; no celular a versão curta
    // ("12,5k"/"980") para caber no padding esquerdo reduzido.
    const rotuloEixoY = (valor) => {
      if (!estreito) return brMoeda(valor);
      if (Math.abs(valor) >= 1000)
        return `${(valor / 1000).toFixed(1).replace(".", ",")}k`;
      return String(Math.round(valor));
    };

    // fundo do gráfico (mesmo tom escuro usado nos cards do Resumo)
    const FUNDO_TOPO = "#0f1720";
    const FUNDO_BASE = "#0b1a22";

    // helper coordinate mapping
    const mapX = (i) => padLeft + (areaW * i) / Math.max(1, labels.length - 1);
    const mapY = (v) =>
      padTop + areaH - ((v - minVal) / Math.max(1, maxVal - minVal)) * areaH;

    // Progresso da animação de entrada: 0 = séries na base, 1 = valores reais.
    // Só as séries usam mapYSerie — grade, eixos e legenda ficam parados.
    let anim = 1;
    const mapYSerie = (v) => mapY(v * anim);

    // passos da grade (usados no redraw, que é quem pinta o gráfico)
    const steps = 5;

    // Caminho suave dos valores (tension 0.4 -> controle a 40%/60% do trecho)
    function buildSmoothPath(values) {
      const path = new Path2D();
      for (let i = 0; i < values.length; i++) {
        const x = mapX(i);
        const y = mapYSerie(values[i]);
        if (i === 0) path.moveTo(x, y);
        else {
          const px = mapX(i - 1);
          const py = mapYSerie(values[i - 1]);
          path.bezierCurveTo(
            px + (x - px) * TENSAO_ANUAL,
            py,
            x - (x - px) * TENSAO_ANUAL,
            y,
            x,
            y,
          );
        }
      }
      return path;
    }

    // Área preenchida com degradê (rgba(cor, 0.3) -> rgba(cor, 0)) + linha
    // cheia com borderWidth 3. O degradê começa no topo do canvas e termina em
    // 300px (FIM_DEGRADE_ANUAL); em telas mais baixas termina no fim do canvas
    // para a base do preenchimento ficar realmente transparente.
    function drawArea(values, corLinha, corFillInicio, corFillFim) {
      if (!values || values.length < 2) return;
      const path = buildSmoothPath(values);

      // fecha o preenchimento na linha de base (valor 0)
      const fillPath = new Path2D(path);
      const baseY = mapY(0);
      fillPath.lineTo(mapX(values.length - 1), baseY);
      fillPath.lineTo(mapX(0), baseY);
      fillPath.closePath();

      const g = ctx.createLinearGradient(0, 0, 0, Math.min(h, FIM_DEGRADE_ANUAL));
      g.addColorStop(0, corFillInicio);
      g.addColorStop(1, corFillFim);
      ctx.fillStyle = g;
      ctx.fill(fillPath);

      // stroke da linha
      ctx.strokeStyle = corLinha;
      ctx.lineWidth = 3;
      ctx.shadowColor = corLinha;
      ctx.shadowBlur = 8;
      ctx.stroke(path);
      ctx.shadowBlur = 0;

      desenharPontos(values, () => corLinha);
    }

    // pointRadius 2 no celular (pontos visíveis no toque) e 0 no desktop
    function desenharPontos(values, corDoPonto) {
      if (raioPonto <= 0) return;
      for (let i = 0; i < values.length; i++) {
        ctx.fillStyle = corDoPonto(values[i], i);
        ctx.beginPath();
        ctx.arc(mapX(i), mapYSerie(values[i]), raioPonto, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Linha do Saldo: verde (#22c55e) onde o saldo é >= 0 e vermelha (#ef4444)
    // onde é negativo — cada trecho recebe a cor do seu próprio saldo.
    function strokeSaldo() {
      for (let i = 1; i < saldos.length; i++) {
        const px = mapX(i - 1);
        const py = mapYSerie(saldos[i - 1]);
        const x = mapX(i);
        const y = mapYSerie(saldos[i]);
        const cor = corSaldoAnual((saldos[i - 1] + saldos[i]) / 2);
        const seg = new Path2D();
        seg.moveTo(px, py);
        seg.bezierCurveTo(
          px + (x - px) * TENSAO_ANUAL,
          py,
          x - (x - px) * TENSAO_ANUAL,
          y,
          x,
          y,
        );
        ctx.strokeStyle = cor;
        ctx.lineWidth = 3;
        ctx.shadowColor = cor;
        ctx.shadowBlur = 8;
        ctx.stroke(seg);
      }
      ctx.shadowBlur = 0;
      desenharPontos(saldos, corSaldoAnual);
    }

    // Legenda com as cores fixas das três séries (as mesmas das linhas)
    function drawLegenda() {
      const y = 16;
      const itens = [
        ["Receitas", CORES_ANUAL.receita],
        ["Despesas", CORES_ANUAL.despesa],
        ["Saldo", corSaldoResumo],
      ];
      // Encolhe fonte/espaçamento apenas se não couber (telas bem estreitas,
      // ex.: 320px); no desktop/tablet nada muda.
      let fonte = estreito ? 10 : 11;
      let gap = estreito ? 10 : 16;
      const larguraTotal = () => {
        ctx.font = `${fonte}px Segoe UI`;
        const textos = itens.reduce(
          (acc, [nome]) => acc + 12 + ctx.measureText(nome).width,
          0,
        );
        return textos + gap * (itens.length - 1);
      };
      while (padLeft + larguraTotal() > w - 2 && fonte > 8) {
        fonte -= 1;
        gap = Math.max(4, gap - 2);
      }

      ctx.font = `${fonte}px Segoe UI`;
      ctx.textAlign = "left";
      let x = padLeft;
      itens.forEach(([nome, cor]) => {
        ctx.fillStyle = cor;
        ctx.beginPath();
        ctx.arc(x + 4, y - 2, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillText(nome, x + 12, y + 2);
        x += 12 + ctx.measureText(nome).width + gap;
      });
    }

    // rótulos dos meses (12 meses; no celular pode mostrar um a cada dois)
    function drawRotulosX() {
      ctx.font = fonteEixo;
      ctx.fillStyle = "rgba(255,255,255,0.86)";
      ctx.textAlign = "center";
      labels.forEach((lab, i) => {
        if (i % pularRotuloX !== 0) return;
        ctx.fillText(lab.slice(0, 3), mapX(i), padTop + areaH + 18);
      });
    }

    // interactive tooltip element (create if missing)
    const tooltipId = `hg_chart_tooltip_${canvasId}`;
    let tooltip = document.getElementById(tooltipId);
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.id = tooltipId;
      tooltip.style.position = "absolute";
      tooltip.style.pointerEvents = "none";
      tooltip.style.padding = "8px 10px";
      tooltip.style.background = "rgba(10,12,16,0.92)";
      tooltip.style.color = "#fff";
      tooltip.style.borderRadius = "6px";
      tooltip.style.fontSize = "12px";
      tooltip.style.boxShadow = "0 6px 18px rgba(0,0,0,0.45)";
      tooltip.style.transition = "transform 120ms ease, opacity 120ms ease";
      tooltip.style.opacity = "0";
      tooltip.style.transform = "translateY(-6px) scale(0.98)";
      document.body.appendChild(tooltip);
    }

    // redraw handler with optional highlight index
    function redraw(highlightIndex = -1) {
      // clear and re-render static layers
      const { w: cw, h: ch } = limparCanvas(ctx, canvas);
      // background
      const bg2 = ctx.createLinearGradient(0, 0, 0, ch);
      bg2.addColorStop(0, FUNDO_TOPO);
      bg2.addColorStop(1, FUNDO_BASE);
      ctx.fillStyle = bg2;
      ctx.fillRect(0, 0, cw, ch);

      // grid + labels
      ctx.font = fonteEixo;
      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.lineWidth = 1;
      for (let i = 0; i <= steps; i++) {
        const v = minVal + (i * (maxVal - minVal)) / steps;
        const y = mapY(v);
        ctx.strokeStyle = "rgba(255,255,255,0.04)";
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(padLeft + areaW, y);
        ctx.stroke();
        ctx.fillStyle = "rgba(255,255,255,0.72)";
        ctx.fillText(rotuloEixoY(v), padLeft - 8, y + 4);
      }

      // áreas (Receitas azul / Despesas laranja) + linha de Saldo
      drawArea(
        despesas,
        CORES_ANUAL.despesa,
        CORES_ANUAL.despesaFillInicio,
        CORES_ANUAL.despesaFillFim,
      );
      drawArea(
        receitas,
        CORES_ANUAL.receita,
        CORES_ANUAL.receitaFillInicio,
        CORES_ANUAL.receitaFillFim,
      );
      strokeSaldo();

      // legenda + rótulos dos meses
      drawLegenda();
      drawRotulosX();

      // highlight vertical and markers
      if (highlightIndex >= 0 && highlightIndex < labels.length) {
        const hx = mapX(highlightIndex);
        ctx.beginPath();
        ctx.moveTo(hx, padTop);
        ctx.lineTo(hx, padTop + areaH);
        ctx.strokeStyle = "rgba(255,255,255,0.06)";
        ctx.lineWidth = 1.2;
        ctx.stroke();

        // marcador da linha de Saldo (mesma cor do trecho)
        const sy = mapYSerie(saldos[highlightIndex]);
        ctx.fillStyle = corSaldoAnual(saldos[highlightIndex]);
        ctx.beginPath();
        ctx.arc(hx, sy, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ---- Animação de entrada (leve: as séries sobem da base) --------------
    let frameAnim = null;

    function cancelarAnimacao() {
      if (frameAnim !== null && typeof cancelAnimationFrame === "function")
        cancelAnimationFrame(frameAnim);
      frameAnim = null;
      canvas._hg_chartAnim = null;
      anim = 1;
    }

    function animarEntrada() {
      const DURACAO = 480; // ms — leve, só na primeira pintura do canvas
      // A animação é de boas-vindas: roda uma única vez por canvas. Nos
      // re-renders (resize, troca de ano/mês, volta para a aba) o gráfico é
      // pintado direto — sem piscar nem atrasar o arraste da janela.
      if (
        canvas._hg_chartAnimou ||
        typeof requestAnimationFrame !== "function" ||
        prefereMenosMovimento()
      ) {
        anim = 1;
        canvas._hg_chartAnimou = true;
        redraw(-1);
        return;
      }
      canvas._hg_chartAnimou = true;
      let inicio = null;
      anim = 0;
      const passo = (agora) => {
        if (inicio === null) inicio = agora;
        const t = Math.min(1, (agora - inicio) / DURACAO);
        anim = 1 - Math.pow(1 - t, 3); // ease-out
        redraw(-1);
        if (t < 1) {
          frameAnim = requestAnimationFrame(passo);
          canvas._hg_chartAnim = frameAnim;
        } else {
          anim = 1;
          frameAnim = null;
          canvas._hg_chartAnim = null;
        }
      };
      frameAnim = requestAnimationFrame(passo);
      canvas._hg_chartAnim = frameAnim;
    }

    // primeira pintura (com animação)
    animarEntrada();

    // ---- Interação: hover com mouse, toque no celular ---------------------
    // Pointer Events cobrem mouse, dedo e caneta. Antes existia só mousemove /
    // mouseleave, então no celular não havia tooltip nenhum.
    let timerTooltip = null;

    function indicePorX(clientX) {
      const rect = canvas.getBoundingClientRect();
      const ratio = (clientX - rect.left - padLeft) / areaW;
      const idx = Math.round(ratio * (labels.length - 1));
      return Math.max(0, Math.min(labels.length - 1, idx));
    }

    // Posição calculada em coordenadas de viewport (para o tooltip não vazar a
    // tela — importante em 375px) e convertida de volta para coordenadas de
    // página, que é o que o tooltip absoluto usa. No toque o tooltip fica acima
    // do dedo (senão ficaria escondido embaixo dele).
    function posicionarTooltip(e) {
      const px = typeof e.pageX === "number" ? e.pageX : e.clientX;
      const py = typeof e.pageY === "number" ? e.pageY : e.clientY;
      const cx = typeof e.clientX === "number" ? e.clientX : px;
      const cy = typeof e.clientY === "number" ? e.clientY : py;
      const toque = e.pointerType === "touch" || e.pointerType === "pen";
      const larguraTt = tooltip.offsetWidth || 150;
      const alturaTt = tooltip.offsetHeight || 64;
      const larguraTela =
        (document.documentElement && document.documentElement.clientWidth) || 0;
      const alturaTela =
        (document.documentElement && document.documentElement.clientHeight) || 0;

      let viewX = cx + 12;
      let viewY = toque ? cy - alturaTt - 18 : cy - 12;
      if (toque && viewY < 8) viewY = cy + 20; // dedo no topo: mostra abaixo
      if (larguraTela > 0)
        viewX = Math.min(viewX, larguraTela - larguraTt - 8);
      if (alturaTela > 0) viewY = Math.min(viewY, alturaTela - alturaTt - 8);
      viewX = Math.max(8, viewX);
      viewY = Math.max(8, viewY);

      tooltip.style.left = viewX + (px - cx) + "px";
      tooltip.style.top = viewY + (py - cy) + "px";
    }

    function mostrarTooltip(e, idx) {
      const receitaV = receitas[idx] || 0;
      const despesaV = despesas[idx] || 0;
      const saldoV = saldos[idx] || 0;
      tooltip.innerHTML = `<div style="font-weight:600;margin-bottom:6px">${esc(labels[idx])}</div>
        <div>Receita: <b>${brMoeda(receitaV)}</b></div>
        <div>Despesa: <b>${brMoeda(despesaV)}</b></div>
        <div>Saldo: <b style="color:${corSaldoAnual(saldoV)}">${brMoeda(saldoV)}</b></div>`;
      posicionarTooltip(e);
      tooltip.style.opacity = "1";
      tooltip.style.transform = "translateY(0) scale(1)";
    }

    function esconderTooltip() {
      redraw(-1);
      tooltip.style.opacity = "0";
      tooltip.style.transform = "translateY(-6px) scale(0.98)";
    }

    function limparTimerTooltip() {
      if (timerTooltip) clearTimeout(timerTooltip);
      timerTooltip = null;
    }

    // mouse passando por cima ou dedo arrastando sobre o gráfico
    function onPointerMove(e) {
      cancelarAnimacao();
      limparTimerTooltip();
      const idx = indicePorX(e.clientX);
      redraw(idx);
      mostrarTooltip(e, idx);
    }

    // toque: mostra já no toque (destaca a barra do mês apontado)
    function onPointerDown(e) {
      cancelarAnimacao();
      limparTimerTooltip();
      const idx = indicePorX(e.clientX);
      redraw(idx);
      mostrarTooltip(e, idx);
    }

    // ao soltar o dedo o tooltip continua por um tempo, para dar leitura
    function onPointerUp(e) {
      if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
      limparTimerTooltip();
      timerTooltip = setTimeout(() => {
        timerTooltip = null;
        esconderTooltip();
      }, 2500);
    }

    // Sair com o mouse esconde na hora. Atenção: ao levantar o dedo o navegador
    // também dispara pointerleave, e isso não pode cortar o tempo de leitura
    // agendado no pointerup — por isso o toque é tratado à parte.
    function onPointerLeave(e) {
      const toque =
        !!e && (e.pointerType === "touch" || e.pointerType === "pen");
      if (toque) {
        if (timerTooltip) return; // o timer do pointerup é quem esconde
        esconderTooltip();
        return;
      }
      limparTimerTooltip();
      esconderTooltip();
    }

    // gesto cancelado (o navegador assumiu a rolagem, por exemplo)
    function onPointerCancel() {
      limparTimerTooltip();
      esconderTooltip();
    }

    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("pointercancel", onPointerCancel);
    canvas._hg_chartHandlers = {
      pointermove: onPointerMove,
      pointerdown: onPointerDown,
      pointerup: onPointerUp,
      pointerleave: onPointerLeave,
      pointercancel: onPointerCancel,
    };
  } catch (err) {
    console.error("Erro ao desenhar a visão anual (Receitas x Despesas):", err);
  }
}

function drawDonutChart(canvasId, labels, valores) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const { w, h } = limparCanvas(ctx, canvas);
  const corLegenda = "#f2c95a";

  const total = valores.reduce((a, b) => a + b, 0);

  // Layout lado a lado (desktop): o wrapper com scroll mantém a largura
  // original (~650px) também no celular, onde a legenda fica ao lado do donut.
  const LINHA_LEGENDA = 22;

  const cx = w * 0.32,
    cy = h / 2,
    raio = Math.max(24, Math.min(cx, cy) - 10),
    raioInterno = raio * 0.55;

  if (total <= 0) {
    ctx.fillStyle = "#999";
    ctx.textAlign = "center";
    ctx.fillText("Sem dados para exibir", w / 2, h / 2);
    return;
  }

  // draw slices with subtle stroke and gradient
  let anguloAtual = -Math.PI / 2;
  labels.forEach((label, i) => {
    const fatia = (valores[i] / total) * Math.PI * 2;
    if (valores[i] <= 0) return;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, raio, anguloAtual, anguloAtual + fatia);
    ctx.closePath();
    const cor = CORES_GRAFICO[i % CORES_GRAFICO.length];
    const g = ctx.createLinearGradient(cx - raio, cy, cx + raio, cy);
    g.addColorStop(0, shadeColor(cor, 10));
    g.addColorStop(1, cor);
    ctx.fillStyle = g;
    ctx.fill();
    // slice edge
    ctx.strokeStyle = "rgba(0,0,0,0.12)";
    ctx.lineWidth = 1;
    ctx.stroke();
    anguloAtual += fatia;
  });

  // cut inner hole
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.arc(cx, cy, raioInterno, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";

  // inner circle decoration
  ctx.beginPath();
  ctx.arc(cx, cy, raioInterno - 6, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.06)";
  ctx.stroke();
  // center total
  ctx.fillStyle = "#071025";
  ctx.textAlign = "center";
  ctx.font = "bold 13px Segoe UI";
  ctx.fillText(brMoeda(total), cx, cy + 5);

  // legenda com bolinhas coloridas (coluna à direita do donut — original)
  let ly = 12;
  ctx.font = "12px Segoe UI";

  labels.forEach((label, i) => {
    if (valores[i] <= 0) return;
    const cor = CORES_GRAFICO[i % CORES_GRAFICO.length];
    const pct = ((valores[i] / total) * 100).toFixed(0);
    const texto = `${label} — ${pct}%`;

    ctx.beginPath();
    ctx.arc(w * 0.62 + 6, ly + 6, 6, 0, Math.PI * 2);
    ctx.fillStyle = cor;
    ctx.fill();

    ctx.fillStyle = corLegenda;
    ctx.textAlign = "left";
    // nomes longos de categoria são cortados com "…" para não vazar o canvas
    const larguraMax = w - (w * 0.62 + 18) - 8;
    ctx.fillText(encurtarTexto(ctx, texto, larguraMax), w * 0.62 + 18, ly + 9);
    ly += 22;
  });
}

// small util to slightly lighten/darken a hex color
function shadeColor(hex, percent) {
  // hex like #rrggbb
  const c = hex.replace("#", "");
  const num = parseInt(c, 16);
  let r = (num >> 16) + Math.round(255 * (percent / 100));
  let g = ((num >> 8) & 0x00ff) + Math.round(255 * (percent / 100));
  let b = (num & 0x0000ff) + Math.round(255 * (percent / 100));
  r = Math.min(255, Math.max(0, r));
  g = Math.min(255, Math.max(0, g));
  b = Math.min(255, Math.max(0, b));
  return `rgb(${r},${g},${b})`;
}

// ---------------------------------------------------------------------
// RESUMO
// ---------------------------------------------------------------------
// Compara a categoria com uma das listas de Cadastros ignorando espaços e
// caixa: há itens cadastrados com espaço sobrando (" ENERGIA") e lançamentos
// importados podem vir em minúsculas — sem isso a soma dava R$ 0,00 para eles.
function normalizaTipo(valor) {
  return String(valor === null || valor === undefined ? "" : valor)
    .trim()
    .toUpperCase();
}

function categoriaNaLista(tipos, tipo) {
  if (!tipos) return true;
  const alvo = normalizaTipo(tipo);
  return tipos.some((t) => normalizaTipo(t) === alvo);
}

function somaCF({ tipos, ano, mes, entradaSaida }) {
  return STATE.cf
    .filter((r) => {
      if (!categoriaNaLista(tipos, r.TIPO)) return false;
      if (ano && String(r.ANO || anoDaDataBr(r.DATA)) !== String(ano))
        return false;
      if (mes && String(r.VENCIMENTO || mesDaDataBr(r.DATA)) !== String(mes))
        return false;
      if (entradaSaida && r.ENTRADA_SAIDA !== entradaSaida) return false;
      return true;
    })
    .reduce((acc, r) => acc + num(r.VALOR), 0);
}

// `observacao` (opcional) é o que separa PARCELADOS de GASTOS FIXOS no
// Controle de Dívidas — usado pela Visão Anual (renderVisaoAnual).
function somaCD({ tipos, ano, mes, observacao }) {
  return STATE.cd
    .filter((r) => {
      if (!categoriaNaLista(tipos, r.TIPO)) return false;
      if (
        observacao &&
        String(r.OBSERVACAO || "").trim().toUpperCase() !==
          String(observacao).trim().toUpperCase()
      )
        return false;
      if (ano && String(r.ANO || anoDaDataBr(r.DATA)) !== String(ano))
        return false;
      if (mes && String(r.VENCIMENTO || mesDaDataBr(r.DATA)) !== String(mes))
        return false;
      return true;
    })
    .reduce((acc, r) => acc + num(r.VALOR), 0);
}

function renderResumo() {
  popularSelectsAnoMes();
  const ano = document.getElementById("resumoAno").value;
  const mes = document.getElementById("resumoMes").value;
  const cad = STATE.cad;

  // Receitas (categorias configuráveis na aba Cadastros)
  const receitasCategorias =
    Array.isArray(STATE.cad.receitas) && STATE.cad.receitas.length
      ? STATE.cad.receitas
      : CATEGORIAS_RECEITA_PADRAO;
  const tabelaReceitas = document.getElementById("tabelaReceitas");
  tabelaReceitas.innerHTML = "";
  let totalReceitas = 0;
  receitasCategorias.forEach((cat) => {
    const v = somaCF({ tipos: [cat], ano, mes, entradaSaida: "RECEITA" });
    totalReceitas += v;
    tabelaReceitas.innerHTML += `<tr><td>${esc(cat)}</td><td>${brMoeda(v)}</td></tr>`;
  });
  tabelaReceitas.innerHTML += `<tr class="footer-total"><td>TOTAL</td><td>${brMoeda(totalReceitas)}</td></tr>`;

  // Gastos Variáveis
  const categoriasVariaveis = cad.gastos_variaveis || [];
  let totalVariaveis = 0;
  const realizadoPorCategoria = {};
  categoriasVariaveis.forEach((cat) => {
    const v = somaCF({ tipos: [cat], ano, mes, entradaSaida: "DESPESA" });
    realizadoPorCategoria[cat] = v;
    totalVariaveis += v;
  });

  // Gastos Fixos e Cartões (Controle de Dívidas)
  const categoriasFixas = cad.fixos_parcelados || [];
  const tabelaFixos = document.getElementById("tabelaFixos");
  tabelaFixos.innerHTML = "";
  let totalFixos = 0;
  categoriasFixas.forEach((cat) => {
    const v = somaCD({ tipos: [cat], ano, mes });
    if (v === 0) return;
    totalFixos += v;
    tabelaFixos.innerHTML += `<tr><td>${esc(String(cat).trim())}</td><td>${brMoeda(v)}</td></tr>`;
  });
  tabelaFixos.innerHTML += `<tr class="footer-total"><td>TOTAL</td><td>${brMoeda(totalFixos)}</td></tr>`;

  // Cards
  document.getElementById("cardReceitas").textContent = brMoeda(totalReceitas);
  document.getElementById("cardVariaveis").textContent =
    brMoeda(totalVariaveis);
  document.getElementById("cardFixos").textContent = brMoeda(totalFixos);
  const saldo = totalReceitas - totalVariaveis - totalFixos;
  const cardSaldo = document.getElementById("cardSaldo");
  cardSaldo.textContent = brMoeda(saldo);
  document.getElementById("cardSaldoWrap").className =
    "card " + (saldo >= 0 ? "positivo" : "negativo");

  // Gráfico donut: Gastos Variáveis por categoria (mês selecionado)
  drawDonutChart(
    "chartCategorias",
    categoriasVariaveis,
    categoriasVariaveis.map((cat) => realizadoPorCategoria[cat] || 0),
  );

  // Planejamento
  const orcamentoMap = {};
  (STATE.meta.orcamento || []).forEach((o) => {
    orcamentoMap[o.categoria] = o.orcamento;
  });
  const tabelaPlan = document.getElementById("tabelaPlanejamento");
  tabelaPlan.innerHTML = "";
  categoriasVariaveis.forEach((cat) => {
    const orcado = orcamentoMap[cat] || 0;
    const realizado = realizadoPorCategoria[cat] || 0;
    const diff = orcado - realizado;
    const corDiff =
      diff < 0
        ? "style='color:#d93025;font-weight:700;'"
        : "style='color:#1e8e3e;font-weight:700;'";
    tabelaPlan.innerHTML += `<tr>
      <td>${esc(cat)}</td>
      <td class="orcado-val-td">${brMoeda(orcado)}</td>
      <td>${brMoeda(realizado)}</td>
      <td ${corDiff}>${brMoeda(diff)}</td>
      <td class="actions-col" style="text-align:right;">
        <button class="btn small" data-edit-orc="${esc(encodeURIComponent(cat))}" title="Editar orçado">✏️ Editar</button>
      </td>
    </tr>`;
  });

  // handler para editar orçado inline (input + salvar/cancelar)
  tabelaPlan.querySelectorAll("[data-edit-orc]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const categoria = decodeURIComponent(btn.dataset.editOrc);
      const tr = btn.closest("tr");
      if (!tr) return;
      const tdOrcado = tr.querySelector(".orcado-val-td");
      const tdAcoes = tr.querySelector(".actions-col");
      if (!tdOrcado || !tdAcoes) return;
      const atual = orcamentoMap[categoria] || 0;

      tdOrcado.innerHTML = `<input type="number" step="0.01" class="inline-orc-input" value="${esc(num(atual))}" />`;
      tdAcoes.innerHTML = `
        <button class="btn small" data-save-orc="${esc(encodeURIComponent(categoria))}" title="Salvar">💾 Salvar</button>
        <button class="btn small secondary" data-cancel-orc title="Cancelar">✖️</button>
      `;

      const input = tdOrcado.querySelector(".inline-orc-input");
      const saveBtn = tdAcoes.querySelector("[data-save-orc]");
      const cancelBtn = tdAcoes.querySelector("[data-cancel-orc]");
      if (input) input.focus();

      saveBtn.addEventListener("click", () => {
        const novoVal = parseFloat(String(input.value).replace(",", "."));
        if (isNaN(novoVal)) {
          alert("Valor inválido. Use apenas números, ex: 1234.56");
          return;
        }
        if (!STATE.meta) STATE.meta = {};
        if (!Array.isArray(STATE.meta.orcamento)) STATE.meta.orcamento = [];
        const arr = STATE.meta.orcamento;
        const existente = arr.find((o) => o.categoria === categoria);
        if (existente) {
          existente.orcamento = Number(novoVal);
        } else {
          arr.push({ categoria, orcamento: Number(novoVal) });
        }
        salvar(LS_KEYS.meta, STATE.meta);
        renderResumo();
      });

      cancelBtn.addEventListener("click", () => {
        renderResumo();
      });
    });
  });

  // A tabela "Visão Anual" (estilo Excel) é generada por js/visaoAnual.js
  // (window.recalcularAnual). Aqui só preparamos os dados do gráfico:
  const receitasPorMes = [];
  const despesasPorMes = [];

  MESES.forEach((m) => {
    const receitaMes = somaCF({
      tipos: receitasCategorias,
      ano,
      mes: m,
      entradaSaida: "RECEITA",
    });
    const variaveisMes = categoriasVariaveis.reduce(
      (acc, cat) =>
        acc + somaCF({ tipos: [cat], ano, mes: m, entradaSaida: "DESPESA" }),
      0,
    );
    const fixosMes = categoriasFixas.reduce(
      (acc, cat) => acc + somaCD({ tipos: [cat], ano, mes: m }),
      0,
    );
    const despesaMes = variaveisMes + fixosMes;
    receitasPorMes.push(receitaMes);
    despesasPorMes.push(despesaMes);
  });

  drawCompositeBarLineChart(
    "chartAnual",
    MESES,
    receitasPorMes,
    despesasPorMes,
  );

  // A dica de rolagem depende da largura real do desenho (roda depois dos dois
  // gráficos do Resumo terem sido redesenhados).
  atualizarDicasScroll();

  // Visão Anual: tabela HTML recalculada do zero a cada render (é o ponto por
  // onde passam TODOS os cadastros/edições/exclusões de lançamentos e dívidas).
  renderVisaoAnual();
}

// A dica "← arraste para ver mais →" (::after do .grafico-scroll-wrapper) só
// aparece quando o gráfico é realmente mais largo que a área visível: a visão
// anual passou a caber inteira no celular, então lá ela não é exibida.
function atualizarDicasScroll() {
  document.querySelectorAll(".grafico-scroll-wrapper").forEach((wrapper) => {
    const precisa = wrapper.scrollWidth > wrapper.clientWidth + 2;
    wrapper.classList.toggle("tem-scroll", precisa);
  });
}

document.getElementById("resumoAno").addEventListener("change", renderResumo);
document.getElementById("resumoMes").addEventListener("change", renderResumo);

// Redesenha os gráficos do Resumo quando o tamanho da tela muda (girar o
// celular, redimensionar a janela). É o equivalente do chart.resize() do
// Chart.js: como o canvas é desenhado à mão com 2D context, o buffer precisa
// ser recalculado para a nova largura e redesenhado.
let timerRedesenhoGraficos = null;
function redesenharGraficosResponsivos() {
  if (timerRedesenhoGraficos) clearTimeout(timerRedesenhoGraficos);
  timerRedesenhoGraficos = setTimeout(() => {
    timerRedesenhoGraficos = null;
    const root = document.getElementById("appRoot");
    if (!root || root.style.display === "none") return;
    renderResumo();
  }, 150);
}
window.addEventListener("resize", redesenharGraficosResponsivos);
window.addEventListener("orientationchange", redesenharGraficosResponsivos);

// ---------------------------------------------------------------------
// VISÃO ANUAL — tabela real (não é imagem), 100% automática
// ---------------------------------------------------------------------
// #tabelaAnual / #visaoAnualBody (index.html) são preenchidas aqui a partir do
// estado do sistema (STATE.cf / STATE.cd), nunca com números fixos no HTML.
//
//   RECEITA          = receitas do mês  (somaCF, entradaSaida "RECEITA")
//   PARCELADOS       = CD do mês com OBSERVAÇÃO "PARCELADOS"
//   GASTOS FIXOS     = CD do mês com OBSERVAÇÃO "GASTOS FIXOS"
//   GASTOS VARIÁVEIS = despesas do mês das categorias de gastos variáveis
//   DESPESA TOTAL    = PARCELADOS + GASTOS FIXOS + GASTOS VARIÁVEIS
//   SALDO            = RECEITA - DESPESA TOTAL
//
// Cores exatas do print (as das CÉLULAS ficam no css/style.css por classe):
//   RECEITA #87ceeb (etiqueta #7ec8e3) · PARCELADOS #ffb3b3 (etiqueta #f8a9a9)
//   GASTOS FIXOS #ffdab9 (etiqueta #ffd8b1) · DESPESA TOTAL #ff9a4d (etiqueta
//   #ff8c42) · SALDO < 0 #ff8a8a (texto preto) e > 0 #4ade80.
const VA_VARIAVEIS_VERDE = "#7be9a0"; // valor < 100 (e o 0)
const VA_VARIAVEIS_VERMELHO = "#ffb3b3"; // valor > 2000
const VA_VARIAVEIS_VERMELHO_FORTE = "#ff9a9a"; // valor > 5000
const VA_VARIAVEIS_ATE_VERDE = 100;
const VA_VARIAVEIS_ATE_MEDIO = 2000;
const VA_VARIAVEIS_ATE_FORTE = 5000;

// Fundo das células de GASTOS VARIÁVEIS pelo valor do mês.
function corGastosVariaveis(valor) {
  const v = num(valor);
  if (v > VA_VARIAVEIS_ATE_FORTE) return VA_VARIAVEIS_VERMELHO_FORTE;
  if (v > VA_VARIAVEIS_ATE_MEDIO) return VA_VARIAVEIS_VERMELHO;
  if (v < VA_VARIAVEIS_ATE_VERDE) return VA_VARIAVEIS_VERDE;
  // faixa intermediária (100 a 2000): degradê verde -> vermelho claro, como no
  // print. Os tons exatos das pontas continuam sendo os do print.
  const t =
    (v - VA_VARIAVEIS_ATE_VERDE) /
    (VA_VARIAVEIS_ATE_MEDIO - VA_VARIAVEIS_ATE_VERDE);
  const de = [0x7b, 0xe9, 0xa0];
  const para = [0xff, 0xb3, 0xb3];
  const rgb = de.map((c, i) => Math.round(c + (para[i] - c) * t));
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

// Classe do fundo das células de SALDO: negativo vermelho, positivo verde e
// zero no tom neutro (amarelo) do print.
function classeSaldoAnual(valor) {
  const v = num(valor);
  if (v < 0) return "va-saldo-neg";
  if (v > 0) return "va-saldo-pos";
  return "va-saldo-cero";
}

// Ano mostrado na Visão Anual: o mesmo selecionado no Resumo.
function anoVisaoAnual() {
  const select = document.getElementById("resumoAno");
  if (select && select.value) return String(select.value);
  if (STATE.meta && STATE.meta.ano_atual) return String(STATE.meta.ano_atual);
  return String(new Date().getFullYear());
}

// ---------------------------------------------------------------------
// VISÃO ANUAL (continuação) — cálculo e desenho da tabela
// ---------------------------------------------------------------------
// Série de cada linha da tabela, mês a mês (índice 0 = JANEIRO).
function coletarVisaoAnual(ano) {
  const cad = STATE.cad || {};
  const anoAlvo = String(ano || anoVisaoAnual());
  const receitasCategorias =
    Array.isArray(cad.receitas) && cad.receitas.length
      ? cad.receitas
      : CATEGORIAS_RECEITA_PADRAO;
  const categoriasVariaveis = cad.gastos_variaveis || [];
  const categoriasFixas = cad.fixos_parcelados || [];

  const receita = [];
  const parcelados = [];
  const fixos = [];
  const variaveis = [];

  MESES.forEach((mes) => {
    receita.push(
      somaCF({
        tipos: receitasCategorias,
        ano: anoAlvo,
        mes,
        entradaSaida: "RECEITA",
      }),
    );
    variaveis.push(
      categoriasVariaveis.reduce(
        (acc, cat) =>
          acc +
          somaCF({ tipos: [cat], ano: anoAlvo, mes, entradaSaida: "DESPESA" }),
        0,
      ),
    );
    // No Controle de Dívidas quem separa uma parcela de uma conta fixa é a
    // OBSERVAÇÃO. As linhas "RECEBIDO"/"À RECEBER" são entradas, por isso
    // ficam fora das despesas.
    parcelados.push(
      somaCD({
        tipos: categoriasFixas,
        ano: anoAlvo,
        mes,
        observacao: "PARCELADOS",
      }),
    );
    fixos.push(
      somaCD({
        tipos: categoriasFixas,
        ano: anoAlvo,
        mes,
        observacao: "GASTOS FIXOS",
      }),
    );
  });

  const despesaTotal = MESES.map(
    (_, i) => parcelados[i] + fixos[i] + variaveis[i],
  );
  const saldo = MESES.map((_, i) => receita[i] - despesaTotal[i]);

  return {
    ano: anoAlvo,
    receita,
    parcelados,
    fixos,
    variaveis,
    despesaTotal,
    saldo,
  };
}

// Desenha a tabela. Chamada por renderResumo() a cada cadastro/edição/exclusão.
function renderVisaoAnual() {
  const corpo = document.getElementById("visaoAnualBody");
  const tabela = document.getElementById("tabelaAnual");
  const wrapper = document.getElementById("visaoAnual");

  // A Visão Anual é tabela de verdade: nenhum <img>/<canvas>/background-image
  // pode sobrar dentro dela (limpa o que tiver vindo do HTML).
  if (wrapper && typeof wrapper.querySelectorAll === "function") {
    wrapper.querySelectorAll("img, canvas, svg").forEach((no) => {
      if (no && typeof no.remove === "function") no.remove();
    });
  }
  [wrapper, tabela, corpo].forEach((el) => {
    if (el && el.style) el.style.backgroundImage = "none";
  });

  if (!corpo || !tabela) return false;

  const dados = coletarVisaoAnual();

  // A célula do ano ("ANO | 2026") também é dinâmica: nunca fica fixa no HTML.
  const anoEl = document.getElementById("vaAno");
  if (anoEl) {
    anoEl.textContent = dados.ano;
    anoEl.colSpan = MESES.length;
  }

  const linhasTabela = [
    { rotulo: "RECEITA", classe: "va-receita", valores: dados.receita },
    {
      rotulo: "PARCELADOS",
      classe: "va-parcelados",
      valores: dados.parcelados,
    },
    { rotulo: "GASTOS FIXOS", classe: "va-fixos", valores: dados.fixos },
    {
      rotulo: "GASTOS VARIÁVEIS",
      classe: "va-etq",
      valores: dados.variaveis,
      cor: corGastosVariaveis,
    },
    {
      rotulo: "DESPESA TOTAL",
      classe: "va-despesa",
      valores: dados.despesaTotal,
    },
    {
      rotulo: "SALDO",
      classe: "va-etq",
      valores: dados.saldo,
      corClasse: classeSaldoAnual,
    },
  ];

  corpo.innerHTML = linhasTabela
    .map((linha) => {
      const etiqueta = `<td class="va-etiqueta ${linha.classe}">${linha.rotulo}</td>`;
      const celulas = linha.valores
        .map((valor) => {
          const extra = linha.corClasse ? " " + linha.corClasse(valor) : "";
          const fundo = linha.cor ? linha.cor(valor) : "";
          const estilo = fundo ? ` style="background:${fundo}"` : "";
          return `<td class="va-cel ${linha.classe}${extra}"${estilo}>${brMoeda(valor)}</td>`;
        })
        .join("");
      return `<tr>${etiqueta}${celulas}</tr>`;
    })
    .join("");

  return true;
}

// Para testar/forçar no console: renderVisaoAnual() e visaoAnual.coletar(ano).
window.renderVisaoAnual = renderVisaoAnual;
window.visaoAnual = {
  render: renderVisaoAnual,
  coletar: coletarVisaoAnual,
  corGastosVariaveis,
  classeSaldo: classeSaldoAnual,
  ano: anoVisaoAnual,
};

// ---------------------------------------------------------------------
// Backup / Reset
// ---------------------------------------------------------------------
document.getElementById("btnExportar").addEventListener("click", () => {
  const backup = {
    controle_financeiro: STATE.cf,
    controle_dividas: STATE.cd,
    cadastros: STATE.cad,
    resumo_meta: STATE.meta,
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `backup_controle_financeiro_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById("btnResetar").addEventListener("click", async () => {
  if (
    confirm(
      "Isso vai APAGAR todas as alterações feitas e restaurar os dados de exemplo. Continuar?",
    )
  ) {
    const dados = await HGStore.reset();
    STATE = Object.assign({ pronto: true }, dados);
    iniciar();
  }
});

// ---------------------------------------------------------------------
// Tema claro/escuro (persistido; o padrão é o tema escuro)
// ---------------------------------------------------------------------
function aplicarTema(tema) {
  const escuro = tema !== "claro";
  document.body.classList.toggle("dark-theme", escuro);
  const btn = document.getElementById("themeToggle");
  if (btn) {
    btn.textContent = escuro ? "🌗" : "☀️";
    btn.title = escuro ? "Mudar para tema claro" : "Mudar para tema escuro";
  }
}

function lerTemaSalvo() {
  try {
    return localStorage.getItem("hg_tema") || "escuro";
  } catch (e) {
    return "escuro";
  }
}

const themeToggleEl = document.getElementById("themeToggle");
if (themeToggleEl) {
  themeToggleEl.addEventListener("click", () => {
    const tema = document.body.classList.contains("dark-theme")
      ? "claro"
      : "escuro";
    try {
      localStorage.setItem("hg_tema", tema);
    } catch (e) {
      /* preferência é opcional */
    }
    aplicarTema(tema);
  });
}
aplicarTema(lerTemaSalvo());

// ---------------------------------------------------------------------
// Indicador de sincronização (nuvem x local)
// ---------------------------------------------------------------------
function renderStatusSync(s) {
  const el = document.getElementById("syncStatus");
  if (!el) return;
  const nuvem = s.modo === "nuvem";
  const comErro = nuvem && !!s.erro;
  el.classList.remove("online", "offline", "sincronizando", "erro");
  el.classList.add(
    !nuvem ? "offline" : comErro ? "erro" : s.pendente ? "sincronizando" : "online",
  );
  el.textContent = !nuvem
    ? "💾 Local (offline)"
    : !s.carregado
      ? "⚠️ Sem dados da nuvem"
      : comErro
        ? s.pendente
          ? "⚠️ Não sincronizado"
          : "⚠️ Atenção"
        : s.pendente
          ? "☁️ Sincronizando…"
          : "☁️ Sincronizado";
  if (!nuvem) {
    el.title = `Sem conexão com o Supabase (${s.erro || "offline"}): faça login novamente`;
  } else if (comErro) {
    el.title = `${s.erro}${s.pendente ? " — clique para tentar novamente" : ""}`;
  } else {
    el.title = `Dados na nuvem (Supabase) · usuário ${s.usuario}`;
  }
  if (nuvem && (comErro || !s.carregado)) el.setAttribute("data-acao", "retry");
  else el.removeAttribute("data-acao");
}

if (window.HGStore) HGStore.onChange(renderStatusSync);

// Clique no indicador: reenvia o pendente ou recarrega da nuvem (quando o
// carregamento inicial falhou, a gravação fica bloqueada até recarregar).
const syncStatusEl = document.getElementById("syncStatus");
if (syncStatusEl) {
  syncStatusEl.addEventListener("click", async () => {
    if (!window.HGStore || HGStore.status().modo !== "nuvem") return;
    if (!HGStore.status().carregado) {
      syncStatusEl.textContent = "☁️ Recarregando…";
      await iniciar();
      return;
    }
    await HGStore.retry();
  });
}

// Avisa antes de fechar/perder a aba se houver alteração que ainda não subiu
// (o envio em si é disparado pelo HGStore em pagehide/visibilitychange).
window.addEventListener("beforeunload", (ev) => {
  if (!window.HGStore) return;
  const s = HGStore.status();
  if (s.modo === "nuvem" && s.pendente) {
    ev.preventDefault();
    ev.returnValue =
      "Há alterações que ainda não foram sincronizadas com a nuvem. Sair mesmo assim?";
    return ev.returnValue;
  }
});

// Voltou para o app depois de um boot sem carregar? Tenta carregar de novo.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (!window.HGStore) return;
  const root = document.getElementById("appRoot");
  if (root && root.style.display === "none") return; // está no login
  const s = HGStore.status();
  if (s.modo === "nuvem" && !s.carregado) iniciar();
});

// ---------------------------------------------------------------------
// PWA: service worker (instalação no celular)
// ---------------------------------------------------------------------
// Desativado temporariamente: o SW antigo estava cacheando respostas de
// erro (501) das antigas rotas /api/sync e /api/extrair, que já foram
// removidas. Também derruba qualquer registro anterior no navegador.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => {
    regs.forEach((reg) => reg.unregister());
  });
  if ("caches" in window) {
    caches.keys().then((nomes) => nomes.forEach((n) => caches.delete(n)));
  }
}
// if ("serviceWorker" in navigator && location.protocol.indexOf("http") === 0) {
//   window.addEventListener("load", () => {
//     navigator.serviceWorker
//       .register("sw.js")
//       .catch((e) =>
//         console.warn("[PWA] service worker não registrado:", e.message),
//       );
//   });
// }

// Sidebar shortcuts removed from UI; no listeners attached

// Transferir / Receber handlers (open Controle Financeiro with pre-filled values)
function abrirFormularioLancamento({
  tipo = "DESPESA",
  valor = "",
  observacao = "",
} = {}) {
  document
    .querySelectorAll(".tab-btn")
    .forEach((b) => b.classList.remove("active"));
  document
    .querySelectorAll(".panel")
    .forEach((p) => p.classList.remove("active"));
  const tab = document.querySelector(
    '.tab-btn[data-tab="controle-financeiro"]',
  );
  if (tab) tab.classList.add("active");
  const panel = document.getElementById("controle-financeiro");
  if (panel) panel.classList.add("active");
  setTimeout(() => {
    const cfEntradaSaida = document.getElementById("cfEntradaSaida");
    const cfTipo = document.getElementById("cfTipo");
    const cfValor = document.getElementById("cfValor");
    const cfObservacao = document.getElementById("cfObservacao");
    if (cfEntradaSaida) cfEntradaSaida.value = tipo;
    if (cfEntradaSaida && typeof cfEntradaSaida.onchange === "function")
      cfEntradaSaida.onchange();
    if (cfValor) {
      cfValor.value = valor;
      cfValor.focus();
      try {
        cfValor.select();
      } catch (e) {}
    }
    if (cfObservacao && observacao) cfObservacao.value = observacao;
  }, 50);
}

// Transferir/Receber sidebar shortcuts removed from UI; no listeners attached

// ---------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------
async function iniciar() {
  // Carrega da nuvem (Supabase). Deu errado? A tela fica vazia e a edição é
  // BLOQUEADA (STATE.pronto = false + guard no HGStore.push): é o que impede
  // sobrescrever o histórico do usuário com um estado vazio.
  let carregou = true;
  if (window.HGStore) {
    try {
      const dados = await HGStore.load();
      STATE = Object.assign({ pronto: true }, dados);
      carregou = HGStore.status().carregado !== false;
    } catch (e) {
      console.error("Falha ao carregar os dados:", e);
      carregou = false;
    }
  }
  STATE.pronto = carregou;
  mostrarAvisoDados(carregou);

  // garante valores padrão persistidos para ano/mes do resumo
  if (!STATE.meta) STATE.meta = {};
  if (!STATE.meta.ano_atual) STATE.meta.ano_atual = new Date().getFullYear();
  if (!STATE.meta.mes_atual)
    STATE.meta.mes_atual = MESES[new Date().getMonth()];
  salvar(LS_KEYS.meta, STATE.meta);

  popularSelectsAnoMes();
  popularDropdownsCadastro();
  renderControleFinanceiro();
  renderControleDividas();
  renderCadastros();
  renderResumo();

  const hoje = new Date().toISOString().slice(0, 10);
  function saveResumoSelection() {
    const anoEl = document.getElementById("resumoAno");
    const mesEl = document.getElementById("resumoMes");
    if (!STATE.meta) STATE.meta = {};
    STATE.meta.ano_atual = anoEl.value;
    STATE.meta.mes_atual = mesEl.value;
    salvar(LS_KEYS.meta, STATE.meta);
  }
  // Synchronize ano/mes selection across all relevant selects (Resumo, CF filtros, CD filtros)
  function syncAnoMesFrom(selectAno, selectMes) {
    if (!STATE.meta) STATE.meta = {};
    STATE.meta.ano_atual = selectAno.value;
    STATE.meta.mes_atual = selectMes.value;
    salvar(LS_KEYS.meta, STATE.meta);
    // reflect to other selects
    const targets = [
      document.getElementById("resumoAno"),
      document.getElementById("resumoMes"),
      document.getElementById("cfFiltroAno"),
      document.getElementById("cfFiltroMes"),
      document.getElementById("cdFiltroAno"),
      document.getElementById("cdFiltroMes"),
    ];
    targets.forEach((t) => {
      if (!t) return;
      if (t.tagName.toLowerCase() === "select") {
        if (
          t.id === "resumoAno" ||
          t.id === "cfFiltroAno" ||
          t.id === "cdFiltroAno"
        )
          t.value = STATE.meta.ano_atual;
        if (
          t.id === "resumoMes" ||
          t.id === "cfFiltroMes" ||
          t.id === "cdFiltroMes"
        )
          t.value = STATE.meta.mes_atual;
      } else if (t.tagName.toLowerCase() === "input") {
        t.value = STATE.meta.ano_atual;
      }
    });
  }

  // wire change handlers to common sync function
  const resumoAnoEl = document.getElementById("resumoAno");
  const resumoMesEl = document.getElementById("resumoMes");
  if (resumoAnoEl && resumoMesEl) {
    resumoAnoEl.addEventListener("change", () => {
      syncAnoMesFrom(resumoAnoEl, resumoMesEl);
      renderResumo();
    });
    resumoMesEl.addEventListener("change", () => {
      syncAnoMesFrom(resumoAnoEl, resumoMesEl);
      renderResumo();
    });
  }

  // restore/sync stored ano/mes to all filter selects on init
  if (resumoAnoEl && resumoMesEl) {
    syncAnoMesFrom(resumoAnoEl, resumoMesEl);
    // re-render after programmatic select changes so filters are applied
    renderControleFinanceiro();
    renderControleDividas();
    renderResumo();
  }

  // also listen to CF and CD filter selects -- when they change, update meta and reflect across
  const cfAnoSel = document.getElementById("cfFiltroAno");
  const cfMesSel = document.getElementById("cfFiltroMes");
  if (cfAnoSel)
    cfAnoSel.addEventListener("change", () =>
      syncAnoMesFrom(cfAnoSel, cfMesSel || resumoMesEl),
    );
  if (cfMesSel)
    cfMesSel.addEventListener("change", () =>
      syncAnoMesFrom(cfAnoSel || resumoAnoEl, cfMesSel),
    );
  const cdAnoSel = document.getElementById("cdFiltroAno");
  const cdMesSel = document.getElementById("cdFiltroMes");
  if (cdAnoSel)
    cdAnoSel.addEventListener("change", () =>
      syncAnoMesFrom(cdAnoSel, cdMesSel || resumoMesEl),
    );
  if (cdMesSel)
    cdMesSel.addEventListener("change", () =>
      syncAnoMesFrom(cdAnoSel || resumoAnoEl, cdMesSel),
    );
  document.getElementById("cdData").value = hoje;
  // O ano da fatura (mês seguinte à data) é calculado automaticamente
  sincronizarAnoFaturaCD();
  atualizarPreviewParcelasCD();
}

// Global error handler: registra o problema no console (sem popup bloqueante)
window.addEventListener("error", (ev) => {
  console.error("Global error caught:", ev.error || ev.message || ev);
});

// ---------------------------------------------------------------------
// Autenticação (login/criar conta/esqueci a senha) via HGAuth (Supabase)
// ---------------------------------------------------------------------
function mostrarApp() {
  const login = document.getElementById("loginScreen");
  const root = document.getElementById("appRoot");
  if (login) login.style.display = "none";
  if (root) root.style.display = "";
}

function mostrarLogin() {
  const login = document.getElementById("loginScreen");
  const root = document.getElementById("appRoot");
  if (root) root.style.display = "none";
  if (login) login.style.display = "flex";
}

// Zera o estado em memória E o que está renderizado na tela. É chamado no
// logout e imediatamente antes de exibir o app para outra conta: sem isso, o
// próximo usuário do mesmo navegador veria os dados do anterior e, se o load
// falhasse, poderia gravar por cima do documento dele. Com STATE.pronto=false
// nenhum formulário aceita lançamento enquanto os dados não chegam.
function limparTelaUsuario() {
  STATE = { cf: [], cd: [], cad: {}, meta: {}, pronto: false };
  PAGINA_CF = 1;
  PAGINA_CD = 1;
  try {
    renderControleFinanceiro();
    renderControleDividas();
    renderCadastros();
    renderResumo();
  } catch (e) {
    console.warn("Falha ao limpar as telas do usuário:", e);
  }
}

function mensagemLogin(texto, tipo) {
  const el = document.getElementById("loginMensagem");
  if (!el) return;
  el.textContent = texto || "";
  el.classList.remove("erro", "sucesso");
  if (tipo) el.classList.add(tipo);
}

// Faixa de aviso quando os dados da nuvem não carregaram: explica por que a
// edição está bloqueada e oferece a recarga. Sem innerHTML (só textContent).
function mostrarAvisoDados(ok) {
  const el = document.getElementById("avisoDados");
  if (!el) return;
  if (ok) {
    el.style.display = "none";
    el.textContent = "";
    return;
  }
  el.textContent = "";
  el.style.display = "flex";
  const texto = document.createElement("span");
  texto.textContent =
    "⚠️ Não foi possível carregar seus dados da nuvem. Para não sobrescrever seu histórico, a importação e o cadastro ficam bloqueados até recarregar.";
  const botao = document.createElement("button");
  botao.type = "button";
  botao.className = "btn";
  botao.textContent = "Tentar novamente";
  botao.addEventListener("click", () => iniciar());
  el.appendChild(texto);
  el.appendChild(botao);
}

// ---------------------------------------------------------------------
// Visualizador de senha (equivale ao PasswordInput com olho)
// ---------------------------------------------------------------------
// Ícones lucide Eye / EyeOff (20px) em SVG inline — mesma origem do
// componente PasswordInput (lucide-react), sem dependência nova.
const SVG_OLHO_ABERTO =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
const SVG_OLHO_FECHADO =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>';

// showPassword=false -> type="password", ícone Eye, "Mostrar senha".
// mousedown com preventDefault: o clique não rouba o foco do input.
function ligarOlhoSenha(idInput, idBotao) {
  const input = document.getElementById(idInput);
  const botao = document.getElementById(idBotao);
  if (!input || !botao) return;
  const desenhar = () => {
    const visivel = input.type === "text";
    botao.innerHTML = visivel ? SVG_OLHO_FECHADO : SVG_OLHO_ABERTO;
    const rotulo = visivel ? "Esconder senha" : "Mostrar senha";
    botao.setAttribute("aria-label", rotulo);
    botao.setAttribute("title", rotulo);
  };
  if (!botao.dataset.olhoLigado) {
    botao.dataset.olhoLigado = "1";
    botao.addEventListener("mousedown", (ev) => ev.preventDefault());
    botao.addEventListener("click", () => {
      input.type = input.type === "password" ? "text" : "password";
      desenhar();
      try {
        input.focus({ preventScroll: true });
      } catch (e) {
        input.focus();
      }
    });
  }
  desenhar();
}

ligarOlhoSenha("loginSenha", "toggleLoginSenha");
ligarOlhoSenha("recSenha", "toggleRecSenha");
ligarOlhoSenha("recSenha2", "toggleRecSenha2");

// ---------------------------------------------------------------------
// Tela de senha (link de recuperação por e-mail e botão "Alterar senha")
// ---------------------------------------------------------------------
let ignorarEventosAuth = false; // evita reagir ao signOut que nós mesmos fizemos

function mensagemRecuperacao(texto, tipo) {
  const el = document.getElementById("recMensagem");
  if (!el) return;
  el.textContent = texto || "";
  el.classList.remove("erro", "sucesso");
  if (tipo) el.classList.add(tipo);
}

function sobrepostaTelaSenha() {
  const tela = document.getElementById("recoveryScreen");
  return !!tela && tela.classList.contains("overlay");
}

// sobreposta = true -> troca de senha dentro do app (app continua atrás)
// sobreposta = false -> link do e-mail (tela cheia, ainda sem entrar no app)
function mostrarTelaSenha(sobreposta) {
  const tela = document.getElementById("recoveryScreen");
  const login = document.getElementById("loginScreen");
  const root = document.getElementById("appRoot");
  if (!tela) return;
  tela.classList.toggle("overlay", !!sobreposta);
  tela.style.display = "flex";
  if (login) login.style.display = "none";
  if (root && !sobreposta) root.style.display = "none";
  mensagemRecuperacao("");
  const s1 = document.getElementById("recSenha");
  const s2 = document.getElementById("recSenha2");
  if (s1) {
    s1.value = "";
    s1.type = "password"; // reabrir a tela sempre volta a ocultar
    ligarOlhoSenha("recSenha", "toggleRecSenha");
  }
  if (s2) {
    s2.value = "";
    s2.type = "password";
    ligarOlhoSenha("recSenha2", "toggleRecSenha2");
  }
  const hint = document.getElementById("recHint");
  if (hint) {
    hint.textContent = sobreposta
      ? "Troque a senha da sua conta (mínimo de 6 caracteres)."
      : "Escolha uma nova senha para a sua conta (mínimo de 6 caracteres).";
  }
  const fechar = document.getElementById("btnFecharRecuperacao");
  if (fechar) fechar.textContent = sobreposta ? "Cancelar" : "Voltar ao login";
  if (s1) {
    try {
      s1.focus();
    } catch (e) {}
  }
}

function esconderTelaSenha() {
  const tela = document.getElementById("recoveryScreen");
  if (!tela) return;
  tela.style.display = "none";
  tela.classList.remove("overlay");
}

async function entrarComSessao(sessao) {
  if (!sessao || !window.HGStore) return false;
  HGStore.definirSessao(sessao.usuario, sessao.id);
  limparTelaUsuario(); // nunca deixar dados de outra conta visíveis
  mostrarApp();
  await iniciar();
  return true;
}

async function encerrarSessao() {
  ignorarEventosAuth = true;
  // manda o que estiver pendente ANTES de derrubar a sessão (o token ainda vale)
  if (window.HGStore) {
    try {
      await HGStore.flush();
    } catch (e) {
      /* o logout segue mesmo se o envio falhar */
    }
  }
  if (window.HGAuth) {
    try {
      await HGAuth.sair();
    } catch (e) {
      /* segue para limpar o estado local mesmo se a chamada falhar */
    }
  }
  if (window.HGStore) HGStore.limparSessao();
  esconderTelaSenha();
  limparTelaUsuario();
  mensagemLogin("");
  mostrarLogin();
  ignorarEventosAuth = false;
}

const formLoginEl = document.getElementById("formLogin");
if (formLoginEl) {
  formLoginEl.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    mensagemLogin("");
    const email = document.getElementById("loginEmail").value.trim();
    const senha = document.getElementById("loginSenha").value;
    if (!window.HGAuth)
      return mensagemLogin("Autenticação indisponível.", "erro");
    try {
      const sessao = await HGAuth.entrar(email, senha);
      if (!sessao) return mensagemLogin("Não foi possível entrar.", "erro");
      await entrarComSessao(sessao);
    } catch (e) {
      mensagemLogin(e && e.message ? e.message : "Falha ao entrar.", "erro");
    }
  });
}

const btnCriarContaEl = document.getElementById("btnCriarConta");
if (btnCriarContaEl) {
  btnCriarContaEl.addEventListener("click", async () => {
    mensagemLogin("");
    const email = document.getElementById("loginEmail").value.trim();
    const senha = document.getElementById("loginSenha").value;
    if (!email || !senha) {
      return mensagemLogin(
        "Informe e-mail e senha para criar a conta.",
        "erro",
      );
    }
    if (!window.HGAuth)
      return mensagemLogin("Autenticação indisponível.", "erro");
    try {
      const sessao = await HGAuth.criarConta(email, senha);
      if (sessao) {
        await entrarComSessao(sessao);
      } else {
        mensagemLogin(
          "Conta criada! Verifique seu e-mail para confirmar o acesso.",
          "sucesso",
        );
      }
    } catch (e) {
      mensagemLogin(
        e && e.message ? e.message : "Falha ao criar conta.",
        "erro",
      );
    }
  });
}

const btnEsqueciSenhaEl = document.getElementById("btnEsqueciSenha");
if (btnEsqueciSenhaEl) {
  btnEsqueciSenhaEl.addEventListener("click", async () => {
    mensagemLogin("");
    const email = document.getElementById("loginEmail").value.trim();
    if (!email)
      return mensagemLogin(
        "Informe seu e-mail para recuperar a senha.",
        "erro",
      );
    if (!window.HGAuth)
      return mensagemLogin("Autenticação indisponível.", "erro");
    try {
      await HGAuth.esqueciSenha(email);
      mensagemLogin(
        "Enviamos um e-mail com instruções para redefinir sua senha.",
        "sucesso",
      );
    } catch (e) {
      mensagemLogin(
        e && e.message ? e.message : "Falha ao enviar e-mail.",
        "erro",
      );
    }
  });
}

const btnSairEl = document.getElementById("btnSair");
if (btnSairEl) {
  btnSairEl.addEventListener("click", encerrarSessao);
}

// Trocar a senha dentro do app (mesma tela da recuperação, sobreposta)
const btnAlterarSenhaEl = document.getElementById("btnAlterarSenha");
if (btnAlterarSenhaEl) {
  btnAlterarSenhaEl.addEventListener("click", () => mostrarTelaSenha(true));
}

const formRecuperacaoEl = document.getElementById("formRecuperacao");
if (formRecuperacaoEl) {
  formRecuperacaoEl.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!window.HGAuth)
      return mensagemRecuperacao("Autenticação indisponível.", "erro");
    const senhaEl = document.getElementById("recSenha");
    const senha2El = document.getElementById("recSenha2");
    const senha = senhaEl ? senhaEl.value : "";
    const senha2 = senha2El ? senha2El.value : "";
    if (!senha || senha.length < 6)
      return mensagemRecuperacao(
        "A senha precisa ter ao menos 6 caracteres.",
        "erro",
      );
    if (senha !== senha2)
      return mensagemRecuperacao("As duas senhas não são iguais.", "erro");

    const botao = document.getElementById("btnSalvarSenha");
    if (botao) botao.disabled = true;
    try {
      await HGAuth.atualizarSenha(senha);
      ignorarEventosAuth = true;
      HGAuth.consumirRecuperacao();
      HGAuth.limparUrlAuth();
      mensagemRecuperacao("Senha alterada com sucesso!", "sucesso");
      const eraTroca = sobrepostaTelaSenha();
      await new Promise((r) => setTimeout(r, 700));
      esconderTelaSenha();
      if (eraTroca) {
        mostrarApp();
      } else {
        // veio do link de recuperação: a sessão já está autenticada
        const sessao = await HGAuth.obterSessao();
        if (sessao) await entrarComSessao(sessao);
        else mostrarLogin();
      }
    } catch (e) {
      mensagemRecuperacao(
        e && e.message ? e.message : "Falha ao alterar a senha.",
        "erro",
      );
    } finally {
      ignorarEventosAuth = false;
      if (botao) botao.disabled = false;
    }
  });
}

const btnFecharRecuperacaoEl = document.getElementById("btnFecharRecuperacao");
if (btnFecharRecuperacaoEl) {
  btnFecharRecuperacaoEl.addEventListener("click", async () => {
    if (sobrepostaTelaSenha()) {
      esconderTelaSenha(); // apenas fecha: o app continua aberto atrás
      return;
    }
    // veio do link do e-mail e desistiu: derruba a sessão e volta ao login
    ignorarEventosAuth = true;
    try {
      if (window.HGAuth) {
        HGAuth.consumirRecuperacao();
        await HGAuth.sair();
      }
    } catch (e) {
      /* segue para limpar o estado local */
    }
    if (window.HGStore) HGStore.limparSessao();
    ignorarEventosAuth = false;
    esconderTelaSenha();
    limparTelaUsuario();
    mostrarLogin();
  });
}

// Reage às mudanças de sessão do Supabase: link de recuperação de senha e
// sessão expirada/revogada (volta ao login em vez de ficar com tudo falhando).
if (window.HGAuth) {
  HGAuth.aoMudarSessao(async (sessao, evento) => {
    if (evento === "PASSWORD_RECOVERY") {
      mostrarTelaSenha(sobrepostaTelaSenha());
      return;
    }
    if (sessao || ignorarEventosAuth) return;
    const root = document.getElementById("appRoot");
    if (!root || root.style.display === "none") return; // já está no login
    if (window.HGStore) HGStore.limparSessao();
    limparTelaUsuario();
    mensagemLogin(
      "Sua sessão expirou. Entre novamente para continuar.",
      "erro",
    );
    mostrarLogin();
  });
}

(async function bootstrap() {
  try {
    // Link de redefinição de senha: pede a nova senha antes de liberar o app.
    if (window.HGAuth && HGAuth.emRecuperacao()) {
      mostrarTelaSenha(false);
      return;
    }
    const sessao = window.HGAuth ? await HGAuth.obterSessao() : null;
    if (sessao) {
      await entrarComSessao(sessao);
    } else {
      mostrarLogin();
    }
  } catch (err) {
    console.error("Erro durante inicialização:", err);
    mostrarLogin();
  }
})();
