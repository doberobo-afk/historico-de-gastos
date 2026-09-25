// Valida as cores, o degradê, a espessura, a tensão e a legenda da VISÃO ANUAL
// (gráfico "Receitas x Despesas (12 meses)" do Resumo).
// Obs.: o projeto não usa Chart.js — o gráfico é desenhado à mão no canvas 2D,
// então o teste roda drawCompositeBarLineChart com um contexto de mentira que
// registra cada chamada de desenho (cores, degradês, espessuras e pontos).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.dirname(DIR);

let falhas = 0;
let total = 0;
function assert(cond, msg) {
  total++;
  if (cond) console.log(`  ok    ${msg}`);
  else {
    console.error(`  FALHA ${msg}`);
    falhas++;
  }
}

const appJs = fs.readFileSync(path.join(RAIZ, "js", "app.js"), "utf8");
const iniCores = appJs.indexOf("const CORES_ANUAL");
const iniFn = appJs.indexOf("function drawCompositeBarLineChart");
const fimFn = appJs.indexOf("function drawDonutChart");
assert(
  iniCores !== -1 && iniFn > iniCores && fimFn > iniFn,
  "bloco da visão anual localizado no js/app.js",
);
const codigo = appJs.slice(iniCores, fimFn);

// Path2D de mentira: só registra as operações do caminho (para conferir a tensão)
class Path2DStub {
  constructor(outro) {
    this.ops = outro ? outro.ops.slice() : [];
  }
  moveTo(...a) {
    this.ops.push(["moveTo", ...a]);
  }
  lineTo(...a) {
    this.ops.push(["lineTo", ...a]);
  }
  bezierCurveTo(...a) {
    this.ops.push(["bezierCurveTo", ...a]);
  }
  closePath() {
    this.ops.push(["closePath"]);
  }
}

const MESES = [
  "JANEIRO", "FEVEREIRO", "MARÇO", "ABRIL", "MAIO", "JUNHO",
  "JULHO", "AGOSTO", "SETEMBRO", "OUTUBRO", "NOVEMBRO", "DEZEMBRO",
];
const RECEITAS = Array(12).fill(1000);
const DESPESAS = [...Array(11).fill(900), 1500]; // dezembro fecha negativo (-500)

// Monta o sandbox com os "globais" usados pelo gráfico. requestAnimationFrame /
// cancelAnimationFrame podem ser um controlador falso (para testar a animação)
// ou undefined — nesse caso o gráfico pinta de forma síncrona (sem animação).
function criarApi(raf, cancelar) {
  return new Function(
    "document",
    "Path2D",
    "limparCanvas",
    "brMoeda",
    "esc",
    "ehLayoutMobile",
    "prefereMenosMovimento",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    `${codigo}; return { drawCompositeBarLineChart, CORES_ANUAL, corSaldoAnual, TENSAO_ANUAL, FIM_DEGRADE_ANUAL };`,
  );
}

// Controlador de requestAnimationFrame: guarda os callbacks e deixa o teste
// avançar o tempo na mão (determinístico).
function criarRafFalso() {
  let sequencia = 0;
  const pendentes = new Map();
  const estado = { cancelados: 0 };
  estado.raf = (cb) => {
    const id = ++sequencia;
    pendentes.set(id, cb);
    return id;
  };
  estado.cancel = (id) => {
    if (pendentes.delete(id)) estado.cancelados += 1;
  };
  estado.pendentes = () => pendentes.size;
  // roda um frame com o timestamp informado (mesmo relógio do rAF)
  estado.rodar = (agora) => {
    const fila = [...pendentes.values()];
    pendentes.clear();
    fila.forEach((cb) => cb(agora));
    return fila.length;
  };
  return estado;
}

// zera o registro de desenho para analisar um único frame da animação
function zerar(log) {
  log.gradientes.length = 0;
  log.paths.length = 0;
  log.arcos.length = 0;
  log.textos.length = 0;
}

// Desenha o gráfico com um ctx de mentira e devolve tudo que foi "pintado"
function renderizar({
  mobile = false,
  w = 600,
  h = 360,
  raf,
  cancelar,
  menosMovimento = false,
} = {}) {
  const log = { gradientes: [], paths: [], arcos: [], textos: [] };
  const ctx = { _fill: "", _stroke: "", _lw: 1, _font: "", _align: "" };
  Object.defineProperties(ctx, {
    fillStyle: { get() { return this._fill; }, set(v) { this._fill = v; } },
    strokeStyle: { get() { return this._stroke; }, set(v) { this._stroke = v; } },
    lineWidth: { get() { return this._lw; }, set(v) { this._lw = v; } },
    font: { get() { return this._font; }, set(v) { this._font = v; } },
    textAlign: { get() { return this._align; }, set(v) { this._align = v; } },
    shadowColor: { get() { return ""; }, set() {} },
    shadowBlur: { get() { return 0; }, set() {} },
  });
  Object.assign(ctx, {
    setTransform() {}, clearRect() {}, fillRect() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, bezierCurveTo() {},
    arc(x, y, r) { log.arcos.push({ x, y, r, cor: this._fill }); },
    fill(p) { log.fills = (log.fills || []); log.fills.push({ cor: this._fill, ops: p ? p.ops : null }); },
    stroke(p) { log.paths.push({ cor: this._stroke, lw: this._lw, ops: p ? p.ops : null }); },
    fillText(t, x, y) { log.textos.push({ t, x, y, cor: this._fill, fonte: this._font }); },
    // largura proporcional à fonte atual (~0,62 de cada caractere)
    measureText(t) { return { width: t.length * 0.62 * (parseFloat(this._font) || 11) }; },
    createLinearGradient(x0, y0, x1, y1) {
      const g = { args: [x0, y0, x1, y1], stops: [] };
      g.addColorStop = (p, c) => g.stops.push([p, c]);
      log.gradientes.push(g);
      return g;
    },
  });

  const listeners = {};
  const canvas = {
    _hg_chartHandlers: null,
    _hg_chartAnim: null,
    style: {},
    dataset: {},
    adicionados: 0,
    removidos: 0,
    getContext: () => ctx,
    addEventListener(tipo, fn) {
      canvas.adicionados += 1;
      listeners[tipo] = fn;
    },
    removeEventListener(tipo) {
      canvas.removidos += 1;
      delete listeners[tipo];
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
  };
  // tooltip real do app (criado via createElement): 150x68 é o tamanho típico
  const tooltipEl = {
    id: "",
    innerHTML: "",
    offsetWidth: 150,
    offsetHeight: 68,
    style: {},
  };
  const documentMock = {
    getElementById: (id) => (id === "chartAnual" ? canvas : null),
    createElement: () => tooltipEl,
    body: { appendChild() {} },
    documentElement: { clientWidth: 375, clientHeight: 667 },
  };
  const api = criarApi(raf, cancelar)(
    documentMock,
    Path2DStub,
    () => ({ w, h }),
    (v) => `R$ ${Number(v || 0).toFixed(2)}`,
    (v) => String(v),
    () => mobile,
    () => menosMovimento,
    raf,
    cancelar,
  );
  api.drawCompositeBarLineChart("chartAnual", MESES, RECEITAS, DESPESAS);
  return { log, api, listeners, tooltipEl, canvas };
}

console.log("1) Paleta da visão anual");
{
  const { api } = renderizar();
  const C = api.CORES_ANUAL;
  assert(C.receita === "#3b82f6", "Receitas: azul #3b82f6");
  assert(C.despesa === "#f97316", "Despesas: laranja #f97316");
  assert(C.saldoPositivo === "#22c55e", "Saldo positivo: verde #22c55e");
  assert(C.saldoNegativo === "#ef4444", "Saldo negativo: vermelho #ef4444");
  assert(C.receitaFillInicio === "rgba(59,130,246,0.3)", "degradê Receitas: rgba(59,130,246,0.3) no topo");
  assert(C.receitaFillFim === "rgba(59,130,246,0)", "degradê Receitas: rgba(59,130,246,0) na base");
  assert(C.despesaFillInicio === "rgba(249,115,22,0.3)", "degradê Despesas: rgba(249,115,22,0.3) no topo");
  assert(C.despesaFillFim === "rgba(249,115,22,0)", "degradê Despesas: rgba(249,115,22,0) na base");
  assert(api.FIM_DEGRADE_ANUAL === 300, "degradê criado até 300px");
  assert(api.TENSAO_ANUAL === 0.4, "tension 0.4");
  assert(api.corSaldoAnual(0) === "#22c55e" && api.corSaldoAnual(10) === "#22c55e", "saldo >= 0 é verde");
  assert(api.corSaldoAnual(-0.5) === "#ef4444", "saldo < 0 é vermelho");
}

console.log("2) Desktop 600x360");
{
  const { log } = renderizar({ mobile: false, w: 600, h: 360 });

  const grad300 = log.gradientes.filter((g) =>
    g.args[0] === 0 && g.args[1] === 0 && g.args[2] === 0 && g.args[3] === 300);
  assert(grad300.length === 2, "createLinearGradient(0, 0, 0, 300) usado nas 2 áreas");

  const azul = grad300.find((g) => g.stops[0] && g.stops[0][1] === "rgba(59,130,246,0.3)");
  assert(!!azul && azul.stops[1][1] === "rgba(59,130,246,0)", "Receitas: degradê azul 0.3 -> 0");
  const laranja = grad300.find((g) => g.stops[0] && g.stops[0][1] === "rgba(249,115,22,0.3)");
  assert(!!laranja && laranja.stops[1][1] === "rgba(249,115,22,0)", "Despesas: degradê laranja 0.3 -> 0");

  const linhas = log.paths.filter((p) => p.cor === "#3b82f6" || p.cor === "#f97316");
  assert(linhas.length === 2, "linhas de Receitas (#3b82f6) e Despesas (#f97316) traçadas");
  assert(linhas.every((p) => p.lw === 3), "borderWidth 3 nas duas linhas");
  assert(
    log.paths.filter((p) => p.cor === "#22c55e").length >= 1 &&
      log.paths.filter((p) => p.cor === "#ef4444").length >= 1,
    "Saldo: trechos verdes (>= 0) e vermelhos (< 0)",
  );
  assert(
    log.paths.filter((p) => p.cor === "#22c55e" || p.cor === "#ef4444").every((p) => p.lw === 3),
    "borderWidth 3 na linha de Saldo",
  );
  assert(!log.arcos.some((a) => a.r === 2), "pointRadius 0 no desktop (nenhum ponto r=2)");

  // tension 0.4: controle 1 a 40% e controle 2 a 60% do trecho
  // (ignora as linhas de grade, que são traçadas sem Path2D)
  const serie = log.paths.find(
    (p) => p.ops && p.ops.some((o) => o[0] === "bezierCurveTo"),
  );
  const ops = serie.ops;
  const mv = ops.find((o) => o[0] === "moveTo");
  const bc = ops.find((o) => o[0] === "bezierCurveTo");
  const [x0, y0] = [mv[1], mv[2]];
  const [, cx1, cy1, cx2, cy2, x1, y1] = bc;
  assert(Math.abs(cx1 - x0 - 0.4 * (x1 - x0)) < 1e-6, "tension 0.4: 1º controle a 40% do trecho");
  assert(Math.abs(x1 - cx2 - 0.4 * (x1 - x0)) < 1e-6, "tension 0.4: 2º controle a 60% do trecho");
  assert(cy1 === y0 && cy2 === y1, "curva suave (controles na horizontal dos pontos)");

  const legenda = [["Receitas", "#3b82f6"], ["Despesas", "#f97316"], ["Saldo", "#22c55e"]];
  legenda.forEach(([nome, cor]) => {
    assert(
      log.textos.some((t) => t.t === nome && t.cor === cor),
      `legenda da visão anual: "${nome}" na cor ${cor}`,
    );
  });
  assert(
    MESES.every((m) => log.textos.some((t) => t.t === m.slice(0, 3))),
    "12 rótulos de mês desenhados",
  );
}

console.log("3) Celular 375px (canvas real de 259x256)");
{
  const { log, api } = renderizar({ mobile: true, w: 259, h: 256 });
  assert(api.corSaldoAnual(-500) === "#ef4444", "375px: dezembro negativo fica vermelho");

  assert(
    log.gradientes.every((g) => g.args[3] <= 300),
    "375px: nenhum degradê passa de 300px",
  );
  assert(
    log.gradientes.some((g) => g.args[3] === 256),
    "375px: degradê termina no fim do canvas (256px)",
  );
  assert(
    log.arcos.filter((a) => a.r === 2).length >= 36,
    "375px: pointRadius 2 nos pontos das 3 séries (>= 36 pontos)",
  );
  assert(
    log.arcos.filter((a) => a.r === 2).every((a) => a.y >= 0 && a.y <= 256),
    "375px: pontos desenhados dentro da área de 256px",
  );
  assert(
    !log.textos.some((t) => t.t.startsWith("R$")),
    "375px: eixo Y com rótulo curto (sem moeda completa)",
  );
  assert(
    log.textos.some((t) => /^-?\d+,\dk$/.test(t.t)),
    "375px: rótulo compacto do eixo Y (ex.: 1,5k)",
  );

  // eixo Y: alinhado à direita em padLeft-8 e sem sair do canvas (largura 0)
  const eixoY = log.textos.filter(
    (t) => t.cor === "rgba(255,255,255,0.72)" && /^-?[\d.,]+k?$/.test(t.t),
  );
  assert(eixoY.length === 6, "375px: 6 rótulos desenhados no eixo Y");
  assert(
    eixoY.every((t) => t.x - t.t.length * 6.2 >= 0),
    "375px: rótulos do eixo Y não saem pela esquerda do canvas",
  );

  // meses: um a cada dois (6 rótulos) e sem encostar um no outro
  const mesesDesenhados = log.textos
    .filter((t) => MESES.some((m) => m.slice(0, 3) === t.t))
    .sort((a, b) => a.x - b.x);
  assert(mesesDesenhados.length === 6, "375px: 6 rótulos de mês (JAN, MAR, MAI...)");
  assert(
    mesesDesenhados.every((t, i, arr) => i === 0 || t.x - arr[i - 1].x >= 3 * 6.2),
    "375px: rótulos de mês sem sobreposição",
  );
  assert(
    mesesDesenhados.every((t) => t.x >= 0 && t.x <= 259),
    "375px: rótulos dentro da largura do canvas",
  );

  const legenda = log.textos.filter((t) => ["Receitas", "Despesas", "Saldo"].includes(t.t));
  assert(
    legenda.length === 3 &&
      legenda[0].cor === "#3b82f6" &&
      legenda[1].cor === "#f97316" &&
      legenda[2].cor === "#22c55e",
    "375px: legenda mantém as cores das séries",
  );
  assert(
    legenda[legenda.length - 1].x <= 259,
    "375px: legenda cabe na largura do canvas",
  );
}

console.log("4) Celular estreito 320px (canvas 204x256)");
{
  const { log } = renderizar({ mobile: true, w: 204, h: 256 });
  const larguraTexto = (t) => t.x + t.t.length * 0.62 * (parseFloat(t.fonte) || 11);

  const legenda = log.textos.filter((t) =>
    ["Receitas", "Despesas", "Saldo"].includes(t.t),
  );
  assert(legenda.length === 3, "320px: legenda com as 3 séries");
  assert(
    legenda.every((t) => larguraTexto(t) <= 204),
    "320px: legenda não vaza a largura do canvas",
  );
  assert(
    parseFloat(legenda[0].fonte) < 10,
    `320px: legenda reduz a fonte para caber (${legenda[0].fonte})`,
  );

  const meses = log.textos
    .filter((t) => MESES.some((m) => m.slice(0, 3) === t.t))
    .sort((a, b) => a.x - b.x);
  assert(meses.length === 6, "320px: 6 rótulos de mês");
  assert(
    meses.every((t, i, arr) => i === 0 || t.x - arr[i - 1].x >= 3 * 0.62 * 10),
    "320px: rótulos de mês sem sobreposição",
  );
}

console.log("5) Interação: toque no celular e hover no desktop");
{
  const { log, listeners, tooltipEl, canvas } = renderizar({
    mobile: true,
    w: 259,
    h: 256,
  });

  assert(typeof listeners.pointerdown === "function", "listener pointerdown registrado");
  assert(typeof listeners.pointermove === "function", "listener pointermove registrado");
  assert(typeof listeners.pointerup === "function", "listener pointerup registrado");
  assert(typeof listeners.pointerleave === "function", "listener pointerleave registrado");
  assert(typeof listeners.pointercancel === "function", "listener pointercancel registrado");
  assert(listeners.mousemove === undefined, "mousemove não é mais usado (só pointer events)");
  assert(
    Object.keys(canvas._hg_chartHandlers).length === 5,
    "5 handlers guardados para limpeza no re-render",
  );

  // toque em JANEIRO (x=46 = início da área do gráfico)
  zerar(log);
  listeners.pointerdown({
    pointerType: "touch",
    pointerId: 1,
    clientX: 46,
    clientY: 300,
    pageX: 46,
    pageY: 300,
  });
  assert(/JANEIRO/.test(tooltipEl.innerHTML), "toque em JANEIRO mostra o mês no tooltip");
  assert(
    /Saldo: <b style="color:#22c55e">R\$ 100\.00<\/b>/.test(tooltipEl.innerHTML),
    "tooltip do toque traz receita/despesa/saldo do mês (verde)",
  );
  assert(tooltipEl.style.opacity === "1", "tooltip visível no toque");
  assert(tooltipEl.style.left === "58px", "tooltip à direita do toque (46+12)");
  assert(tooltipEl.style.top === "214px", "tooltip acima do dedo (300-68-18)");
  assert(log.arcos.some((a) => a.r === 5), "mês tocado fica destacado no gráfico");

  // toque perto da borda direita: tooltip não vaza a tela de 375px
  listeners.pointerdown({
    pointerType: "touch",
    pointerId: 2,
    clientX: 250,
    clientY: 300,
    pageX: 250,
    pageY: 300,
  });
  assert(/DEZEMBRO/.test(tooltipEl.innerHTML), "toque na direita seleciona DEZEMBRO");
  assert(
    /Saldo: <b style="color:#ef4444">/.test(tooltipEl.innerHTML),
    "saldo negativo de dezembro usa vermelho no tooltip",
  );
  assert(tooltipEl.style.left === "217px", "tooltip limitado a 375-150-8 = 217px");

  // dedo no topo da tela: tooltip desce em vez de sair por cima
  listeners.pointerdown({
    pointerType: "touch",
    pointerId: 3,
    clientX: 100,
    clientY: 20,
    pageX: 100,
    pageY: 20,
  });
  assert(tooltipEl.style.top === "40px", "dedo no topo: tooltip aparece abaixo (20+20)");

  // após soltar o dedo o tooltip continua (tempo de leitura)
  listeners.pointerup({ pointerType: "touch", pointerId: 3, clientX: 100, clientY: 20 });
  assert(tooltipEl.style.opacity === "1", "tooltip permanece visível após soltar o dedo");

  // o navegador dispara pointerleave também ao levantar o dedo: isso não pode
  // cortar o tempo de leitura (o timer do pointerup é quem esconde)
  listeners.pointerleave({ pointerType: "touch", pointerId: 3 });
  assert(
    tooltipEl.style.opacity === "1",
    "pointerleave de toque respeita o tempo de leitura",
  );

  // gesto cancelado (por exemplo, o navegador assumiu a rolagem): esconde na hora
  listeners.pointercancel({ pointerType: "touch", pointerId: 3 });
  assert(tooltipEl.style.opacity === "0", "pointercancel esconde o tooltip");

  // hover com mouse segue funcionando
  zerar(log);
  listeners.pointermove({
    pointerType: "mouse",
    clientX: 46,
    clientY: 120,
    pageX: 46,
    pageY: 120,
  });
  assert(/JANEIRO/.test(tooltipEl.innerHTML), "hover com mouse também mostra o tooltip");
  assert(tooltipEl.style.top === "108px", "tooltip de mouse fica abaixo do cursor (120-12)");
  assert(log.arcos.some((a) => a.r === 5), "mês com hover fica destacado");

  // sair com o mouse esconde na hora (pointerleave não-touch)
  listeners.pointerleave({ pointerType: "mouse" });
  assert(tooltipEl.style.opacity === "0", "pointerleave de mouse esconde na hora");
}

console.log("6) Animação de entrada e prefers-reduced-motion");
{
  const raf = criarRafFalso();
  const { log, canvas, api } = renderizar({
    mobile: true,
    w: 259,
    h: 256,
    raf: raf.raf,
    cancelar: raf.cancel,
  });

  assert(raf.pendentes() === 1, "animação agendada no primeiro render");
  assert(canvas._hg_chartAnim !== null, "frame guardado no canvas (cancelável no re-render)");
  assert(log.textos.length === 0, "nada pintado antes do primeiro frame");

  const seriesDoFrame = () =>
    log.paths.filter((p) => p.ops && p.ops.some((o) => o[0] === "bezierCurveTo"));
  const yDoPrimeiroPonto = (p) => p.ops.find((o) => o[0] === "moveTo")[2];

  // frame inicial (t = 0): as séries começam na base
  raf.rodar(1000);
  const frame1 = seriesDoFrame();
  assert(frame1.length >= 2, "frame inicial pintou as séries");
  const yBase = yDoPrimeiroPonto(frame1[0]);
  assert(
    yDoPrimeiroPonto(frame1[0]) === yDoPrimeiroPonto(frame1[1]),
    "no t=0 Receitas e Despesas ficam na base (mesma altura)",
  );

  // metade do tempo (t = 0,5 -> ease-out em 87,5%)
  zerar(log);
  raf.rodar(1240);
  const yMeio = yDoPrimeiroPonto(seriesDoFrame()[1]); // receitas (2ª série)

  // fim (t = 1)
  zerar(log);
  raf.rodar(1480);
  const frameFinal = seriesDoFrame();
  const yFinal = yDoPrimeiroPonto(frameFinal[1]);
  assert(raf.pendentes() === 0, "animação termina sem frames pendentes");
  assert(canvas._hg_chartAnim === null, "frame liberado ao terminar");

  assert(yMeio < yBase, "meio da animação: a série já subiu da base");
  assert(yMeio > yFinal, "meio da animação: ainda não chegou ao valor final");
  assert(yBase > yFinal, "a série cresce da base até o valor real");

  // o fim da animação tem exatamente a geometria do desenho estático
  const estatico = renderizar({ mobile: true, w: 259, h: 256 });
  const serieEstatica = estatico.log.paths.filter(
    (p) => p.ops && p.ops.some((o) => o[0] === "bezierCurveTo"),
  )[1];
  assert(
    yDoPrimeiroPonto(serieEstatica) === yFinal,
    "fim da animação coincide com o desenho sem animação",
  );
  assert(
    frameFinal[1].ops.length === serieEstatica.ops.length,
    "mesma geometria do caminho (só as alturas mudam)",
  );
}

{
  // resize/troca de aba DURANTE a animação: cancela o loop antigo e não
  // duplica listeners no mesmo canvas
  const raf = criarRafFalso();
  const { canvas, api } = renderizar({
    mobile: true,
    w: 259,
    h: 256,
    raf: raf.raf,
    cancelar: raf.cancel,
  });
  assert(raf.pendentes() === 1, "animação em andamento antes do re-render");

  const adicionadosAntes = canvas.adicionados;
  api.drawCompositeBarLineChart("chartAnual", MESES, RECEITAS, DESPESAS);
  assert(canvas.removidos >= 5, "re-render remove os 5 listeners antigos");
  assert(
    canvas.adicionados === adicionadosAntes + 5,
    "re-render registra os 5 listeners de novo (sem duplicar)",
  );
  assert(raf.cancelados >= 1, "re-render cancela a animação que estava rodando");
  assert(
    raf.pendentes() === 0,
    "re-render pinta direto (animação só na primeira pintura do canvas)",
  );
}

{
  const raf = criarRafFalso();
  const { log, canvas } = renderizar({
    mobile: true,
    w: 259,
    h: 256,
    raf: raf.raf,
    cancelar: raf.cancel,
    menosMovimento: true,
  });
  assert(raf.pendentes() === 0, "prefers-reduced-motion: nenhuma animação agendada");
  assert(canvas._hg_chartAnim === null, "prefers-reduced-motion: sem frame pendente");
  assert(
    log.paths.some((p) => p.cor === "#3b82f6"),
    "prefers-reduced-motion: desenha direto, no tamanho final",
  );
}

{
  // sem requestAnimationFrame (ex.: ambiente sem rAF): pinta síncrono
  const { log } = renderizar({ mobile: true, w: 259, h: 256 });
  assert(
    log.paths.some((p) => p.cor === "#f97316"),
    "sem requestAnimationFrame: desenho síncrono funciona",
  );
}

console.log(`\n${total} verificacoes, ${falhas} falha(s)${falhas === 0 ? " SUCESSO!" : ""}\n`);
process.exit(falhas === 0 ? 0 : 1);
