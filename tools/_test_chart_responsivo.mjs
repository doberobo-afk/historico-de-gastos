import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.dirname(DIR);

let falhas = 0, total = 0;
function assert(cond, msg) {
  total++;
  if (cond) console.log(`  ok    ${msg}`);
  else { console.error(`  FALHA ${msg}`); falhas++; }
}

console.log("1) Regras CSS scroll horizontal");
const css = fs.readFileSync(path.join(RAIZ, "css", "style.css"), "utf8");

assert(css.includes(".grafico-scroll-wrapper"), "classe wrapper existe");
assert(css.includes("overflow-x: auto"), "wrapper tem overflow-x auto");
assert(css.includes("min-width: 600px"), "container min-width 600px desktop");
assert(css.includes("min-width: 650px"), "container 650px no mobile (donut com legenda ao lado)");
assert(css.includes("overflow-x: visible"), "desktop sem scroll");
assert(css.includes("arraste para ver mais"), "dica de scroll no mobile");

console.log("1b) Tamanho do grafico no celular (max-height 320px)");
const cssSemComentarios = css.replace(/\/\*[\s\S]*?\*\//g, "");
const blocoMobile = cssSemComentarios.slice(
  cssSemComentarios.indexOf("@media (max-width: 768px)"),
  cssSemComentarios.indexOf("@media (min-width: 769px)"),
);
assert(blocoMobile.length > 0, "bloco @media (max-width: 768px) localizado");
assert(blocoMobile.includes("#graficoContainer"), "seletor #graficoContainer aplicado");
assert(blocoMobile.includes(".chart-container"), "seletor .chart-container aplicado");
assert(blocoMobile.includes("height: 280px"), "container com height 280px");
assert(blocoMobile.includes("max-height: 320px"), "container com max-height 320px");
assert(blocoMobile.includes("padding: 12px"), "container com padding 12px");
assert(blocoMobile.includes("max-height: 260px"), "canvas com max-height 260px");
assert(!blocoMobile.includes("!important"), "sem !important no bloco mobile (regra do projeto)");
assert(
  css.includes("@media (prefers-reduced-motion: reduce)"),
  "CSS respeita prefers-reduced-motion",
);
assert(
  /#graficoContainer\s*{[^}]*min-width:\s*0[^}]*width:\s*100%/.test(blocoMobile),
  "anual: largura 100% da tela (cabe em 375px, sem arrastar)",
);
assert(
  /\.grafico-scroll-wrapper\.tem-scroll::after/.test(blocoMobile),
  "dica de scroll so aparece com a classe .tem-scroll",
);

console.log("1c) HTML envolve canvas no wrapper");
const html = fs.readFileSync(path.join(RAIZ, "index.html"), "utf8");
assert(html.includes('class="grafico-scroll-wrapper"'), "wrapper no HTML");
assert(html.includes('class="grafico-canvas-container"'), "container no HTML");
assert(html.includes('id="graficoContainer"'), "container do anual com id graficoContainer");
assert(html.includes('id="chartAnual"'), "chartAnual presente");
assert(html.includes('id="chartCategorias"'), "chartCategorias presente");

console.log("2) Funcoes JS responsivas");
const appJs = fs.readFileSync(path.join(RAIZ, "js", "app.js"), "utf8");
const mIni = "// == GRAFICOS-RESPONSIVOS (inicio) ==";
const mFim = "// == GRAFICOS-RESPONSIVOS (fim) ==";
const posIni = appJs.indexOf(mIni);
const posFim = appJs.indexOf(mFim);
assert(posIni !== -1 && posFim > posIni, "bloco responsivo delimitado no js/app.js");

const codigo = appJs.slice(posIni + mIni.length, posFim);
function criarAmbiente(dpr = 1, larguraJanela = 1440, matchMedia) {
  const windowMock = {
    devicePixelRatio: dpr,
    innerWidth: larguraJanela,
    getComputedStyle: (el) => el._computedStyle || { height: "360px" },
  };
  if (matchMedia) windowMock.matchMedia = matchMedia;
  const ctxMock = {
    setTransform() {}, clearRect() {},
    measureText: (t) => ({ width: t.length * 7 }),
  };
  const fn = new Function("window", `${codigo}; return { ALTURA_GRAFICO_PADRAO, OPCOES_GRAFICO, alturaCanvasCss, alturaCanvasFallback, ehLayoutMobile, prefereMenosMovimento, encurtarTexto, limparCanvas };`);
  return { windowMock, ctxMock, modulo: fn(windowMock) };
}

// 2a: Options equivalentes ao Chart.js (responsive/maintainAspectRatio/aspectRatio)
{
  const { modulo } = criarAmbiente(1);
  const o = modulo.OPCOES_GRAFICO;
  assert(o.responsive === true, "options: responsive true");
  assert(o.maintainAspectRatio === false, "options: maintainAspectRatio false");
  assert(o.aspectRatio === 1.6, "options: aspectRatio 1.6 no mobile");
  assert(o.mediaMobile === "(max-width: 768px)", "options: mesmo breakpoint do CSS (768px)");
  assert(o.alturaMobileMax === 320, "options: teto de 320px no celular");
}

// 2b: Desktop (container 600px)
{
  const { ctxMock, modulo } = criarAmbiente(1, 1440);
  const canvas = { clientWidth: 600, clientHeight: 360, dataset: {}, getAttribute: () => null, style: {} };
  const dim = modulo.limparCanvas(ctxMock, canvas);
  assert(!modulo.ehLayoutMobile(), "desktop: ehLayoutMobile() falso");
  assert(dim.w === 600 && dim.h === 360, "desktop: w=600, h=360");
  assert(canvas.width === 600 && canvas.height === 360, "desktop: buffer dpr=1 igual as dimensoes");
  assert(!canvas.style.height, "desktop: nao fixa height inline quando CSS define clientHeight");
}

// 2c: Celular 375px de largura -> visao anual cabe na tela. Medidas reais com
// o CSS atual: 375 - 20 (main) - 20 (padding do main) - 28 (panel) - 24
// (padding do chart-box) = 283px de container; com 12px de padding de cada
// lado do container => canvas de 259 x 256px (280px de altura - 2*12px).
{
  const { ctxMock, modulo } = criarAmbiente(2, 375);
  const canvas = { clientWidth: 259, clientHeight: 256, dataset: {}, getAttribute: () => null, style: {} };
  const dim = modulo.limparCanvas(ctxMock, canvas);
  assert(modulo.ehLayoutMobile(), "375px: ehLayoutMobile() verdadeiro");
  assert(dim.w === 259 && dim.h === 256, "375px: canvas 259x256 (280px - 2*12px de padding)");
  assert(dim.h <= 320, "375px: altura dentro do max-height de 320px");
  assert(dim.h / dim.w < modulo.OPCOES_GRAFICO.aspectRatio, "375px: mais baixo que o aspectRatio 1.6 (1.01x)");
  assert(canvas.width === 518 && canvas.height === 512, "375px: buffer escalado por dpr=2");
  assert(!canvas.style.height, "375px: nao fixa height inline (CSS manda)");
}

// 2d: Celular com CSS antigo em cache (340px) -> o JS limita a 320px
{
  const { ctxMock, modulo } = criarAmbiente(3, 375);
  const canvas = { clientWidth: 650, clientHeight: 340, dataset: {}, getAttribute: () => null, style: {} };
  const dim = modulo.limparCanvas(ctxMock, canvas);
  assert(dim.w === 650 && dim.h === 320, "mobile: largura original mantida e altura limitada a 320px");
  assert(canvas.width === 1950 && canvas.height === 960, "mobile: buffer escalado por dpr=3 (1950x960)");
}

// 2e: Sem altura no CSS -> fallback pelo aspectRatio 1.6 no celular
{
  const { ctxMock, modulo } = criarAmbiente(2, 375);
  const canvas = {
    clientWidth: 343,
    clientHeight: 0,
    _computedStyle: { height: "" },
    dataset: {},
    getAttribute: () => null,
    style: {},
  };
  const dim = modulo.limparCanvas(ctxMock, canvas);
  assert(dim.h === 214, "375px sem CSS: 343 / 1.6 = 214px (aspectRatio)");
  assert(canvas.style.height === "214px", "375px sem CSS: altura aplicada com aviso inline");
  assert(214 <= modulo.OPCOES_GRAFICO.alturaMobileMax, "375px sem CSS: abaixo do teto de 320px");
}

// 2f: Canvas escondido
{
  const { ctxMock, modulo } = criarAmbiente(2, 1440);
  const canvas = {
    clientWidth: 0,
    clientHeight: 0,
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    _computedStyle: { height: "340px" },
    dataset: {},
    getAttribute: () => null,
    style: {},
  };
  const dim = modulo.limparCanvas(ctxMock, canvas);
  assert(dim.h === 340, "escondido: resolve altura pelo getComputedStyle");
  assert(!canvas.style.height, "escondido: nao grava inline persistente");
}

// 2g: encurtarTexto
{
  const { ctxMock, modulo } = criarAmbiente(1);
  const curto = modulo.encurtarTexto(ctxMock, "Apenas 50%", 200);
  assert(curto === "Apenas 50%", "encurtarTexto: preserva quando cabe");
  const longo = modulo.encurtarTexto(ctxMock, "DESPESAS COM EDUCACAO E CURSOS 45%", 70);
  assert(longo.endsWith("…") && ctxMock.measureText(longo).width <= 70, "encurtarTexto: encurta com reticencia");
}

// 2h: prefers-reduced-motion (animação de entrada é pulada)
{
  const soReduce = (q) => ({ matches: q.includes("prefers-reduced-motion") });
  const { modulo } = criarAmbiente(1, 1440, soReduce);
  assert(modulo.prefereMenosMovimento() === true, "com reduce: prefereMenosMovimento() verdadeiro");
}
{
  const soMobile = (q) => ({ matches: q.includes("max-width: 768px") });
  const { modulo } = criarAmbiente(2, 375, soMobile);
  assert(modulo.prefereMenosMovimento() === false, "sem reduce: animação permitida");
  assert(modulo.ehLayoutMobile() === true, "matchMedia: breakpoint de 768px continua correto");
}
{
  const { modulo } = criarAmbiente(1, 1440);
  assert(modulo.prefereMenosMovimento() === false, "sem matchMedia: assume que pode animar");
}

console.log("3) Listeners de resize e orientacao");
assert(/window\.addEventListener\(\s*["']resize["']\s*,\s*redesenharGraficosResponsivos\s*\)/.test(appJs), "addEventListener('resize')");
assert(/window\.addEventListener\(\s*["']orientationchange["']\s*,\s*redesenharGraficosResponsivos\s*\)/.test(appJs), "addEventListener('orientationchange')");

console.log(`\n${total} verificacoes, ${falhas} falha(s)${falhas === 0 ? " SUCESSO!" : ""}\n`);
process.exit(falhas === 0 ? 0 : 1);

