// ==========================================================================
// Controle Financeiro - App
// Persistência: /api/sync (Vercel Function + Supabase) com fallback
// automático para o localStorage - ver webapp/js/store.js
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

// Envia o PDF para /api/extrair (processado em memória, nunca salvo em disco)
async function importarPDF(arquivo) {
  const hoje = new Date();
  const formData = new FormData();
  formData.append("arquivo", arquivo, arquivo.name);
  formData.append("ano", String(hoje.getFullYear()));
  formData.append("mes", String(hoje.getMonth() + 1));

  const resposta = await fetch("/api/extrair", {
    method: "POST",
    body: formData,
  });
  const dados = await resposta.json().catch(() => null);
  if (!dados || !dados.ok) {
    throw new Error(
      (dados && (dados.erro || dados.detalhe)) || "Falha ao extrair o PDF.",
    );
  }

  const novos = processarFaturaCartao(dados.lancamentos || []);
  // Usa o vencimento real da fatura (competência) para classificar os lançamentos,
  // mas NÃO altera o campo DATA — ele continua sendo a data da compra.
  const mesVencimento = MESES[(parseInt(dados.mes, 10) || 0) - 1];
  const anoVencimento = parseInt(dados.ano, 10);
  if (mesVencimento) {
    novos.forEach((n) => {
      n.VENCIMENTO = mesVencimento;
      if (anoVencimento) n.ANO = anoVencimento;
    });
  }

  STATE.cf = [...novos, ...STATE.cf];
  salvar(LS_KEYS.cf, STATE.cf);
  return {
    total: novos.length,
    soma: novos.reduce((acc, n) => acc + num(n.VALOR), 0),
    mesVencimento,
    anoVencimento,
    tipoDetectado: dados.vencimento_detectado
      ? `fatura de cartão (PDF) — vencimento ${dados.vencimento} (competência ${mesVencimento}/${anoVencimento})`
      : "fatura de cartão (PDF) — vencimento não encontrado no PDF, usado mês atual",
  };
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

function limparCanvas(ctx, canvas) {
  const dpr = window.devicePixelRatio || 1;
  const alturaBase = parseInt(
    canvas.dataset.alturaBase || canvas.getAttribute("height") || "220",
    10,
  );
  canvas.dataset.alturaBase = alturaBase;
  const larguraCss =
    canvas.clientWidth || canvas.getBoundingClientRect().width || 300;

  canvas.width = larguraCss * dpr;
  canvas.height = alturaBase * dpr;
  canvas.style.height = alturaBase + "px";

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, larguraCss, alturaBase);
  return { w: larguraCss, h: alturaBase };
}

// util: draw rounded rect (filled)
function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
  ctx.fill();
}

function drawBarChartDuplo(
  canvasId,
  labels,
  serieA,
  serieB,
  corA,
  corB,
  nomeA,
  nomeB,
) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const { w, h } = limparCanvas(ctx, canvas);

  const padLeft = 50,
    padBottom = 40,
    padTop = 20,
    padRight = 10;
  const areaW = w - padLeft - padRight;
  const areaH = h - padTop - padBottom;
  const maxVal = Math.max(1, ...serieA, ...serieB);
  const grupoW = areaW / labels.length;
  const barW = grupoW * 0.35;

  // background grid
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const y = padTop + (areaH * i) / gridSteps;
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + areaW, y);
  }
  ctx.stroke();

  ctx.font = "12px Segoe UI";
  ctx.fillStyle = "#071025"; // darker text for better contrast on light panels
  ctx.textAlign = "center";

  labels.forEach((label, i) => {
    const xGrupo = padLeft + i * grupoW;
    const alturaA = (serieA[i] / maxVal) * areaH;
    const alturaB = (serieB[i] / maxVal) * areaH;

    // bar A with vertical gradient and rounded corners
    const xA = xGrupo + grupoW * 0.12;
    const yA = padTop + areaH - alturaA;
    const gradA = ctx.createLinearGradient(0, yA, 0, padTop + areaH);
    gradA.addColorStop(0, shadeColor(corA, 18));
    gradA.addColorStop(1, corA);
    ctx.fillStyle = gradA;
    roundedRect(ctx, xA, yA, barW, Math.max(2, alturaA), 6);

    // bar B
    const xB = xGrupo + grupoW * 0.12 + barW + 6;
    const yB = padTop + areaH - alturaB;
    const gradB = ctx.createLinearGradient(0, yB, 0, padTop + areaH);
    gradB.addColorStop(0, shadeColor(corB, 18));
    gradB.addColorStop(1, corB);
    ctx.fillStyle = gradB;
    roundedRect(ctx, xB, yB, barW, Math.max(2, alturaB), 6);

    // value labels (dark for contrast)
    ctx.fillStyle = "#071025";
    ctx.font = "11px Segoe UI";
    if (alturaA > 12) {
      ctx.fillText(brMoeda(serieA[i]), xA + barW / 2, yA - 6);
    }
    if (alturaB > 12) {
      ctx.fillText(brMoeda(serieB[i]), xB + barW / 2, yB - 6);
    }

    ctx.fillStyle = "#666";
    ctx.fillText(label.slice(0, 3), xGrupo + grupoW / 2, padTop + areaH + 14);
  });

  // legenda estilizada (pill)
  ctx.textAlign = "left";
  const legendX = padLeft;
  const legendY = 8;
  // A
  ctx.fillStyle = corA;
  roundedRect(ctx, legendX, legendY - 6, 10, 10, 3);
  ctx.fillStyle = "#071025";
  ctx.fillText(nomeA, legendX + 18, legendY + 2);
  // B
  ctx.fillStyle = corB;
  roundedRect(ctx, legendX + 120, legendY - 6, 10, 10, 3);
  ctx.fillStyle = "#071025";
  ctx.fillText(nomeB, legendX + 138, legendY + 2);
}

// Smooth multi-line chart (spline) with glow and filled area
function drawSmoothLineChart(
  canvasId,
  labels,
  serieA,
  serieB,
  corA,
  corB,
  nomeA,
  nomeB,
) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const { w, h } = limparCanvas(ctx, canvas);

  const padLeft = 40,
    padBottom = 36,
    padTop = 24,
    padRight = 18;
  const areaW = w - padLeft - padRight;
  const areaH = h - padTop - padBottom;
  const maxVal = Math.max(1, ...serieA, ...serieB);

  // grid
  ctx.strokeStyle = "rgba(255,255,255,0.04)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  const steps = 4;
  for (let i = 0; i <= steps; i++) {
    const y = padTop + (areaH * i) / steps;
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + areaW, y);
  }
  ctx.stroke();

  // helper to compute point
  const pointX = (i) => padLeft + (areaW * i) / (labels.length - 1);
  const pointY = (val) => padTop + areaH - (val / maxVal) * areaH;

  // draw area + line for series
  function drawSerie(vals, color, fillAlpha) {
    // build path
    ctx.beginPath();
    for (let i = 0; i < vals.length; i++) {
      const x = pointX(i);
      const y = pointY(vals[i]);
      if (i === 0) ctx.moveTo(x, y);
      else {
        // cubic bezier toward next point
        const prevX = pointX(i - 1);
        const prevY = pointY(vals[i - 1]);
        const cx1 = prevX + (x - prevX) * 0.4;
        const cy1 = prevY;
        const cx2 = prevX + (x - prevX) * 0.6;
        const cy2 = y;
        ctx.bezierCurveTo(cx1, cy1, cx2, cy2, x, y);
      }
    }

    // fill area
    ctx.lineTo(padLeft + areaW, padTop + areaH);
    ctx.lineTo(padLeft, padTop + areaH);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, padTop, 0, padTop + areaH);
    g.addColorStop(0, shadeColor(color, 30));
    g.addColorStop(1, shadeColor(color, 85));
    ctx.fillStyle = `rgba(${hexToRgb(color)}, ${fillAlpha})`;
    ctx.fill();

    // stroke line
    ctx.beginPath();
    for (let i = 0; i < vals.length; i++) {
      const x = pointX(i);
      const y = pointY(vals[i]);
      if (i === 0) ctx.moveTo(x, y);
      else {
        const prevX = pointX(i - 1);
        const prevY = pointY(vals[i - 1]);
        const cx1 = prevX + (x - prevX) * 0.4;
        const cy1 = prevY;
        const cx2 = prevX + (x - prevX) * 0.6;
        const cy2 = y;
        ctx.bezierCurveTo(cx1, cy1, cx2, cy2, x, y);
      }
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 3;
    // glow
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // markers
    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(0,0,0,0.08)";
    for (let i = 0; i < vals.length; i++) {
      const x = pointX(i);
      const y = pointY(vals[i]);
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  // draw series B behind A for nice overlap
  drawSerie(serieB, corB, 0.06);
  drawSerie(serieA, corA, 0.08);

  // x labels
  ctx.font = "11px Segoe UI";
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  labels.forEach((lab, i) => {
    ctx.fillText(lab.slice(0, 3), pointX(i), padTop + areaH + 18);
  });

  // legend
  ctx.font = "12px Segoe UI";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(nomeA, padLeft + 12, 16);
  ctx.fillStyle = corA;
  ctx.beginPath();
  ctx.arc(padLeft - 4, 10, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.fillText(nomeB, padLeft + 120, 16);
  ctx.fillStyle = corB;
  ctx.beginPath();
  ctx.arc(padLeft + 104, 10, 5, 0, Math.PI * 2);
  ctx.fill();
}

// Composite chart: grouped bars for Receita/Despesa + red saldo line overlay
function drawCompositeBarLineChart(canvasId, labels, receitas, despesas) {
  // Novo gráfico estilizado: áreas suaves para Receitas/Despesas e linha de Saldo
  try {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    // remove previous handlers if present (avoid duplicate event listeners)
    if (canvas._hg_chartHandlers) {
      canvas.removeEventListener(
        "mousemove",
        canvas._hg_chartHandlers.mousemove,
      );
      canvas.removeEventListener(
        "mouseleave",
        canvas._hg_chartHandlers.mouseleave,
      );
      canvas._hg_chartHandlers = null;
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

    // layout
    const padLeft = 56,
      padRight = 20,
      padTop = 24,
      padBottom = 56;
    const areaW = w - padLeft - padRight;
    const areaH = h - padTop - padBottom;

    // background subtle gradient
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "#0f1720");
    bg.addColorStop(1, "#0b1a22");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // helper coordinate mapping
    const mapX = (i) => padLeft + (areaW * i) / Math.max(1, labels.length - 1);
    const mapY = (v) =>
      padTop + areaH - ((v - minVal) / Math.max(1, maxVal - minVal)) * areaH;

    // grid and Y labels
    ctx.font = "11px Segoe UI";
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 1;
    const steps = 5;
    for (let i = 0; i <= steps; i++) {
      const v = minVal + (i * (maxVal - minVal)) / steps;
      const y = mapY(v);
      ctx.strokeStyle = "rgba(255,255,255,0.04)";
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + areaW, y);
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.72)";
      ctx.fillText(brMoeda(v), padLeft - 8, y + 4);
    }

    // smooth area path builder
    function buildSmoothPath(values) {
      const path = new Path2D();
      for (let i = 0; i < values.length; i++) {
        const x = mapX(i);
        const y = mapY(values[i]);
        if (i === 0) path.moveTo(x, y);
        else {
          const px = mapX(i - 1);
          const py = mapY(values[i - 1]);
          const cx1 = px + (x - px) * 0.35;
          const cy1 = py;
          const cx2 = px + (x - px) * 0.65;
          const cy2 = y;
          path.bezierCurveTo(cx1, cy1, cx2, cy2, x, y);
        }
      }
      return path;
    }

    // draw area + line function
    function drawArea(values, colorHex, alphaFill) {
      if (!values || values.length === 0) return;
      const path = buildSmoothPath(values);
      // close to baseline
      const lastX = mapX(values.length - 1);
      const firstX = mapX(0);
      const baseY = mapY(0);
      const fillPath = new Path2D(path);
      fillPath.lineTo(lastX, baseY);
      fillPath.lineTo(firstX, baseY);
      fillPath.closePath();
      const g = ctx.createLinearGradient(0, padTop, 0, padTop + areaH);
      g.addColorStop(0, `${colorHex}33`);
      g.addColorStop(1, `${colorHex}05`);
      ctx.fillStyle = g;
      ctx.fill(fillPath);

      // stroke
      ctx.strokeStyle = colorHex;
      ctx.lineWidth = 2.6;
      ctx.shadowColor = colorHex;
      ctx.shadowBlur = 10;
      ctx.stroke(path);
      ctx.shadowBlur = 0;
    }

    // colors
    const corReceita = "#4aa3ff"; // blue
    const corDespesa = "#ff6b3d"; // orange

    // draw despesas behind receitas for visual depth
    drawArea(despesas, corDespesa, 0.12);
    drawArea(receitas, corReceita, 0.14);

    // saldo line (bold)
    const saldoPath = buildSmoothPath(saldos);
    ctx.strokeStyle = "#ff2e2e";
    ctx.lineWidth = 3;
    ctx.shadowColor = "#ff6b6b";
    ctx.shadowBlur = 8;
    ctx.stroke(saldoPath);
    ctx.shadowBlur = 0;

    // x labels
    ctx.font = "11px Segoe UI";
    ctx.fillStyle = "rgba(255,255,255,0.86)";
    ctx.textAlign = "center";
    labels.forEach((lab, i) => {
      ctx.fillText(lab.slice(0, 3), mapX(i), padTop + areaH + 18);
    });

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
      bg2.addColorStop(0, "#0f1720");
      bg2.addColorStop(1, "#0b1a22");
      ctx.fillStyle = bg2;
      ctx.fillRect(0, 0, cw, ch);

      // grid + labels
      ctx.font = "11px Segoe UI";
      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      for (let i = 0; i <= steps; i++) {
        const v = minVal + (i * (maxVal - minVal)) / steps;
        const y = mapY(v);
        ctx.strokeStyle = "rgba(255,255,255,0.04)";
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(padLeft + areaW, y);
        ctx.stroke();
        ctx.fillStyle = "rgba(255,255,255,0.72)";
        ctx.fillText(brMoeda(v), padLeft - 8, y + 4);
      }

      // areas & saldo
      drawArea(despesas, corDespesa, 0.12);
      drawArea(receitas, corReceita, 0.14);
      ctx.strokeStyle = "#ff2e2e";
      ctx.lineWidth = 3;
      ctx.shadowColor = "#ff6b6b";
      ctx.shadowBlur = 8;
      ctx.stroke(saldoPath);
      ctx.shadowBlur = 0;

      // x labels
      ctx.font = "11px Segoe UI";
      ctx.fillStyle = "rgba(255,255,255,0.86)";
      ctx.textAlign = "center";
      labels.forEach((lab, i) => {
        ctx.fillText(lab.slice(0, 3), mapX(i), padTop + areaH + 18);
      });

      // highlight vertical and markers
      if (highlightIndex >= 0 && highlightIndex < labels.length) {
        const hx = mapX(highlightIndex);
        ctx.beginPath();
        ctx.moveTo(hx, padTop);
        ctx.lineTo(hx, padTop + areaH);
        ctx.strokeStyle = "rgba(255,255,255,0.06)";
        ctx.lineWidth = 1.2;
        ctx.stroke();

        // marker circles on saldo line
        const sy = mapY(saldos[highlightIndex]);
        ctx.fillStyle = "#ff2e2e";
        ctx.beginPath();
        ctx.arc(hx, sy, 5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // initial draw
    redraw(-1);

    // mouse interactivity
    function onMove(e) {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      // find nearest index
      const ratio = (x - padLeft) / areaW;
      let idx = Math.round(ratio * (labels.length - 1));
      idx = Math.max(0, Math.min(labels.length - 1, idx));
      redraw(idx);

      // position tooltip
      const receitaV = receitas[idx] || 0;
      const despesaV = despesas[idx] || 0;
      const saldoV = saldos[idx] || 0;
      tooltip.innerHTML = `<div style="font-weight:600;margin-bottom:6px">${esc(labels[idx])}</div>
        <div>Receita: <b>${brMoeda(receitaV)}</b></div>
        <div>Despesa: <b>${brMoeda(despesaV)}</b></div>
        <div>Saldo: <b style="color:${saldoV >= 0 ? "#8ef7a9" : "#ff8b8b"}">${brMoeda(saldoV)}</b></div>`;
      tooltip.style.left = e.pageX + 12 + "px";
      tooltip.style.top = e.pageY - 12 + "px";
      tooltip.style.opacity = "1";
      tooltip.style.transform = "translateY(0) scale(1)";
    }
    function onLeave() {
      redraw(-1);
      tooltip.style.opacity = "0";
      tooltip.style.transform = "translateY(-6px) scale(0.98)";
    }

    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseleave", onLeave);
    canvas._hg_chartHandlers = { mousemove: onMove, mouseleave: onLeave };
  } catch (err) {
    console.error("Erro em drawCompositeBarLineChart (novo):", err);
  }
}

// helper: convert hex to r,g,b string
function hexToRgb(hex) {
  const c = hex.replace("#", "");
  const num = parseInt(c, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `${r},${g},${b}`;
}

function drawDonutChart(canvasId, labels, valores) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const { w, h } = limparCanvas(ctx, canvas);
  const corLegenda = "#f2c95a";

  const total = valores.reduce((a, b) => a + b, 0);
  const cx = w * 0.32,
    cy = h / 2,
    raio = Math.min(cx, cy) - 10,
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

  // legend with circles
  let ly = 12;
  ctx.font = "12px Segoe UI";
  labels.forEach((label, i) => {
    if (valores[i] <= 0) return;
    const cor = CORES_GRAFICO[i % CORES_GRAFICO.length];
    // circle
    ctx.beginPath();
    ctx.arc(w * 0.62 + 6, ly + 6, 6, 0, Math.PI * 2);
    ctx.fillStyle = cor;
    ctx.fill();
    // text
    ctx.fillStyle = corLegenda;
    ctx.textAlign = "left";
    const pct = ((valores[i] / total) * 100).toFixed(0);
    ctx.fillText(`${label} — ${pct}%`, w * 0.62 + 18, ly + 9);
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
function somaCF({ tipos, ano, mes, entradaSaida }) {
  return STATE.cf
    .filter((r) => {
      if (tipos && !tipos.includes(r.TIPO)) return false;
      if (ano && String(r.ANO || anoDaDataBr(r.DATA)) !== String(ano))
        return false;
      if (mes && String(r.VENCIMENTO || mesDaDataBr(r.DATA)) !== String(mes))
        return false;
      if (entradaSaida && r.ENTRADA_SAIDA !== entradaSaida) return false;
      return true;
    })
    .reduce((acc, r) => acc + num(r.VALOR), 0);
}

function somaCD({ tipos, ano, mes }) {
  return STATE.cd
    .filter((r) => {
      if (tipos && !tipos.includes(r.TIPO)) return false;
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

  // Visão Anual (horizontal: meses como colunas)
  const tabelaAnual = document.getElementById("tabelaAnual");
  tabelaAnual.innerHTML = "";
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

  // cabeçalho com meses
  let header = "<tr><th></th>";
  MESES.forEach((m) => {
    const destaque = m === mes ? 'class="selected-month"' : "";
    header += `<th ${destaque}>${m}</th>`;
  });
  header += "</tr>";
  tabelaAnual.innerHTML += header;

  // linhas: Receita, Despesas, Saldo
  const buildRow = (label, valores) => {
    let row = `<tr><td><strong>${label}</strong></td>`;
    MESES.forEach((m, i) => {
      const destaque = m === mes ? 'class="selected-month"' : "";
      row += `<td ${destaque}>${brMoeda(valores[i])}</td>`;
    });
    row += "</tr>";
    return row;
  };

  tabelaAnual.innerHTML += buildRow("Receita", receitasPorMes);
  tabelaAnual.innerHTML += buildRow("Despesas", despesasPorMes);
  const saldos = receitasPorMes.map((r, i) => r - despesasPorMes[i]);
  tabelaAnual.innerHTML += buildRow("Saldo", saldos);

  drawCompositeBarLineChart(
    "chartAnual",
    MESES,
    receitasPorMes,
    despesasPorMes,
  );
}

document.getElementById("resumoAno").addEventListener("change", renderResumo);
document.getElementById("resumoMes").addEventListener("change", renderResumo);

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
  el.classList.remove("online", "offline", "sincronizando");
  el.classList.add(
    nuvem ? (s.pendente ? "sincronizando" : "online") : "offline",
  );
  el.textContent = nuvem
    ? s.pendente
      ? "☁️ Sincronizando…"
      : "☁️ Sincronizado"
    : "💾 Local (offline)";
  el.title = nuvem
    ? `Dados na nuvem (Supabase) · usuário ${s.usuario}`
    : `Sem /api/sync (${s.erro || "offline"}): os dados ficam salvos neste navegador`;
}

if (window.HGStore) HGStore.onChange(renderStatusSync);

// ---------------------------------------------------------------------
// PWA: service worker (instalação no celular)
// ---------------------------------------------------------------------
if ("serviceWorker" in navigator && location.protocol.indexOf("http") === 0) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("sw.js")
      .catch((e) =>
        console.warn("[PWA] service worker não registrado:", e.message),
      );
  });
}

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
  // Carrega da nuvem (/api/sync); sem backend, usa o cache local e,
  // se não houver nada, publica os exemplos de demonstração.
  if (window.HGStore) {
    try {
      const dados = await HGStore.load();
      STATE = Object.assign({ pronto: true }, dados);
    } catch (e) {
      console.error("Falha ao carregar os dados:", e);
    }
  }
  STATE.pronto = true;

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

function mensagemLogin(texto, tipo) {
  const el = document.getElementById("loginMensagem");
  if (!el) return;
  el.textContent = texto || "";
  el.classList.remove("erro", "sucesso");
  if (tipo) el.classList.add(tipo);
}

async function entrarComSessao(sessao) {
  if (!sessao || !window.HGStore) return false;
  HGStore.definirSessao(sessao.usuario, sessao.token);
  mostrarApp();
  await iniciar();
  return true;
}

async function encerrarSessao() {
  if (window.HGAuth) {
    try {
      await HGAuth.sair();
    } catch (e) {
      /* segue para limpar o estado local mesmo se a chamada falhar */
    }
  }
  if (window.HGStore) HGStore.limparSessao();
  mensagemLogin("");
  mostrarLogin();
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

(async function bootstrap() {
  try {
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
