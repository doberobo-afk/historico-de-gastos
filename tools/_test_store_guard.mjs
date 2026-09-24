// ==========================================================================
// Teste do HGStore (js/store.js) SEM navegador: valida os cenários de perda de
// dados que o guard de gravação passou a cobrir.
//
//  1) load() falhou       -> NENHUM upsert é enviado (não sobrescreve a nuvem)
//  2) load() ok           -> gravação normal, no user_id da sessão
//  3) troca de conta      -> gravação bloqueada até carregar a conta nova
//  4) upsert falhou       -> pendente = true + retry agendado (backoff)
//  5) flush()             -> envia na hora, sem esperar o debounce
//  6) logout              -> estado limpo e gravação bloqueada
//
// Uso: node tools/_test_store_guard.mjs
// ==========================================================================
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const arquivoStore = path.join(process.cwd(), "js", "store.js");
const codigoStore = fs.readFileSync(arquivoStore, "utf8");

let passou = 0;
const falhas = [];
function checar(descricao, condicao, extra) {
  if (condicao) {
    passou++;
    console.log(`  ok    ${descricao}`);
  } else {
    falhas.push(descricao);
    console.log(`  FALHA ${descricao}${extra ? " -> " + extra : ""}`);
  }
}

// --------------------------------------------------------------------------
// Ambiente simulado: window + cliente Supabase falso + timers controláveis
// --------------------------------------------------------------------------
function criarAmbiente(estado) {
  const timers = [];
  const eventos = {};

  function fakeCliente() {
    return {
      from() {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle() {
                    if (estado.falhaLoad)
                      return Promise.resolve({
                        data: null,
                        error: { message: "TypeError: Failed to fetch" },
                      });
                    return Promise.resolve({
                      data: estado.linha ? { dados: estado.linha } : null,
                      error: null,
                    });
                  },
                };
              },
            };
          },
          upsert(payload) {
            estado.upserts.push(payload);
            if (estado.falhaUpsert)
              return Promise.resolve({
                error: { message: "TypeError: Failed to fetch" },
              });
            return Promise.resolve({ error: null });
          },
        };
      },
    };
  }

  const janela = {
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout: (id) => {
      if (timers[id - 1]) timers[id - 1] = null;
    },
    addEventListener: (nome, fn) => {
      (eventos[nome] = eventos[nome] || []).push(fn);
    },
    document: {
      visibilityState: "visible",
      addEventListener: (nome, fn) => {
        (eventos["doc:" + nome] = eventos["doc:" + nome] || []).push(fn);
      },
    },
    HGAuth: { client: fakeCliente },
    DADOS_INICIAIS: {
      controle_financeiro: [],
      controle_dividas: [],
      cadastros: { gastos_variaveis: ["MERCADO"] },
      resumo_meta: {},
    },
  };

  const contexto = vm.createContext({ window: janela, console });
  vm.runInContext(codigoStore, contexto);

  return {
    store: janela.HGStore,
    eventos,
    // executa e consome os timers agendados (debounce / retry)
    async rodarTimers(vezes) {
      for (let volta = 0; volta < (vezes || 5); volta++) {
        const pendentes = timers.filter(Boolean);
        if (!pendentes.length) return;
        timers.length = 0;
        for (const t of pendentes) await t.fn();
      }
    },
    timersPendentes: () => timers.filter(Boolean).length,
  };
}

function estadoNovo(extra) {
  return Object.assign(
    { falhaLoad: false, falhaUpsert: false, linha: null, upserts: [] },
    extra || {},
  );
}

const linhaComDados = {
  controle_financeiro: [{ TIPO: "MERCADO", VALOR: 10 }],
  controle_dividas: [],
  cadastros: { gastos_variaveis: ["MERCADO"] },
  resumo_meta: { ano_atual: 2026 },
};

// --------------------------------------------------------------------------
// 1) load() falhou -> gravação bloqueada (pior cenário: apagar a nuvem)
// --------------------------------------------------------------------------
console.log("\n1) load() falhou -> nada é enviado para a nuvem");
{
  const estado = estadoNovo({ falhaLoad: true });
  const amb = criarAmbiente(estado);
  amb.store.definirSessao("dono@exemplo.com", "uuid-dono");
  await amb.store.load();
  checar(
    "carregado = false depois da falha no load",
    amb.store.status().carregado === false,
  );

  amb.store.save("hg_meta", { ano_atual: 2026 });
  await amb.store.push();
  await amb.rodarTimers();
  checar(
    "nenhum upsert enviado (documento do usuário preservado)",
    estado.upserts.length === 0,
    `upserts=${estado.upserts.length}`,
  );
  checar("erro fica visível no status", !!amb.store.status().erro);
  checar(
    "pendente = true (alteração guardada só em memória)",
    amb.store.status().pendente === true,
  );
}

// --------------------------------------------------------------------------
// 2) load() ok -> gravação normal, com o user_id da sessão
// --------------------------------------------------------------------------
console.log("\n2) load() ok -> gravação normal");
{
  const estado = estadoNovo({ linha: linhaComDados });
  const amb = criarAmbiente(estado);
  amb.store.definirSessao("dono@exemplo.com", "uuid-dono");
  const dados = await amb.store.load();
  checar("carregado = true", amb.store.status().carregado === true);
  checar("documento da nuvem normalizado", dados.cf.length === 1);

  amb.store.save("hg_controle_financeiro", dados.cf.concat([{ TIPO: "LUZ" }]));
  await amb.store.push();
  checar(
    "1 upsert enviado",
    estado.upserts.length === 1,
    `upserts=${estado.upserts.length}`,
  );
  checar(
    "upsert usa o user_id do usuário logado",
    !!estado.upserts[0] && estado.upserts[0].user_id === "uuid-dono",
  );
  checar(
    "documento enviado tem os 2 lançamentos",
    !!estado.upserts[0] &&
      estado.upserts[0].dados.controle_financeiro.length === 2,
  );
  checar("pendente = false depois do sucesso", amb.store.status().pendente === false);
}

// --------------------------------------------------------------------------
// 3) troca de conta no mesmo navegador -> bloqueia até carregar a conta nova
// --------------------------------------------------------------------------
console.log("\n3) troca de conta -> bloqueio até carregar a conta nova");
{
  const estado = estadoNovo({ linha: linhaComDados });
  const amb = criarAmbiente(estado);
  amb.store.definirSessao("a@exemplo.com", "uuid-a");
  await amb.store.load();
  amb.store.save("hg_controle_financeiro", [{ TIPO: "MERCADO" }]);
  await amb.store.push();
  const depoisDeA = estado.upserts.length;

  amb.store.definirSessao("b@exemplo.com", "uuid-b"); // troca de usuário
  amb.store.save("hg_controle_financeiro", [{ TIPO: "SOBRA-DA-CONTA-A" }]);
  await amb.store.push();
  checar(
    "nada é gravado antes de carregar a conta nova",
    estado.upserts.length === depoisDeA,
    `upserts=${estado.upserts.length}`,
  );

  await amb.store.load(); // agora sim, carrega a conta B
  checar(
    "edições feitas antes de carregar a conta nova são descartadas",
    amb.store.status().pendente === false,
    String(amb.store.status().erro),
  );

  amb.store.save("hg_controle_financeiro", [{ TIPO: "DA-CONTA-B" }]);
  await amb.store.flush();
  checar(
    "depois do load, a gravação volta a funcionar",
    estado.upserts.length === depoisDeA + 1,
    `upserts=${estado.upserts.length}`,
  );
  checar(
    "grava no documento da conta nova",
    estado.upserts[estado.upserts.length - 1].user_id === "uuid-b",
  );
}

// --------------------------------------------------------------------------
// 4) upsert falhou -> pendente + retry com backoff
// --------------------------------------------------------------------------
console.log("\n4) falha no upsert -> pendente + retry automático");
{
  const estado = estadoNovo({ linha: linhaComDados, falhaUpsert: true });
  const amb = criarAmbiente(estado);
  amb.store.definirSessao("dono@exemplo.com", "uuid-dono");
  await amb.store.load();
  amb.store.save("hg_controle_financeiro", [{ TIPO: "MERCADO" }]);
  await amb.store.push();
  checar("pendente = true depois de falhar", amb.store.status().pendente === true);
  checar(
    "erro reportado",
    /Failed to fetch/.test(String(amb.store.status().erro)),
  );
  checar("retry agendado (backoff)", amb.timersPendentes() > 0);

  estado.falhaUpsert = false;
  await amb.rodarTimers();
  checar("o retry enviou o documento", estado.upserts.length >= 2);
  checar(
    "pendente = false quando o retry dá certo",
    amb.store.status().pendente === false,
  );
}

// --------------------------------------------------------------------------
// 5) flush() -> envia na hora (fechar/mínimizar a aba não perde o lançamento)
// --------------------------------------------------------------------------
console.log("\n5) flush() / pagehide enviam sem esperar o debounce");
{
  const estado = estadoNovo({ linha: linhaComDados });
  const amb = criarAmbiente(estado);
  amb.store.definirSessao("dono@exemplo.com", "uuid-dono");
  await amb.store.load();

  amb.store.save("hg_controle_financeiro", [{ TIPO: "LUZ" }]);
  checar("antes do flush nada foi enviado", estado.upserts.length === 0);
  await amb.store.flush();
  checar("flush envia imediatamente", estado.upserts.length === 1);

  amb.store.save("hg_meta", { ano_atual: 2027 });
  const pagehide = amb.eventos["pagehide"] || [];
  checar("listener de pagehide registrado", pagehide.length > 0);
  pagehide.forEach((fn) => fn());
  await new Promise((r) => setImmediate(r));
  checar(
    "pagehide dispara o envio",
    estado.upserts.length === 2,
    `upserts=${estado.upserts.length}`,
  );
}

// --------------------------------------------------------------------------
// 6) logout -> estado limpo e gravação bloqueada até novo login
// --------------------------------------------------------------------------
console.log("\n6) logout -> estado limpo e gravação bloqueada");
{
  const estado = estadoNovo({ linha: linhaComDados });
  const amb = criarAmbiente(estado);
  amb.store.definirSessao("dono@exemplo.com", "uuid-dono");
  await amb.store.load();
  await amb.store.flush();
  const antes = estado.upserts.length;

  amb.store.limparSessao();
  amb.store.save("hg_controle_financeiro", [{ TIPO: "DEPOIS-DO-LOGOUT" }]);
  await amb.store.push();
  await amb.rodarTimers();
  checar("modo volta para deslogado", amb.store.status().modo === "deslogado");
  checar("carregado = false", amb.store.status().carregado === false);
  checar(
    "nada é gravado depois do logout",
    estado.upserts.length === antes,
    `upserts=${estado.upserts.length}`,
  );
}

// --------------------------------------------------------------------------
// 7) edições feitas com a base desconhecida nunca sobrescrevem o histórico
// --------------------------------------------------------------------------
console.log("\n7) edição sem base carregada -> descartada ao recarregar");
{
  const estado = estadoNovo({ falhaLoad: true, linha: linhaComDados });
  const amb = criarAmbiente(estado);
  amb.store.definirSessao("dono@exemplo.com", "uuid-dono");
  await amb.store.load(); // falha: base desconhecida
  amb.store.save("hg_controle_financeiro", [{ TIPO: "CRIADO-SEM-CONEXAO" }]);
  checar("nada gravado durante a falha", estado.upserts.length === 0);

  estado.falhaLoad = false; // rede voltou
  await amb.store.load(); // carrega a base real
  checar(
    "edições sem base são descartadas e o usuário avisado",
    amb.store.status().pendente === false &&
      /descartadas/.test(String(amb.store.status().erro)),
    String(amb.store.status().erro),
  );

  amb.store.save("hg_meta", { ano_atual: 2026 }); // simula o que iniciar() faz
  await amb.store.push();
  const enviado = estado.upserts[estado.upserts.length - 1];
  checar(
    "o documento enviado é o da nuvem (não o criado sem conexão)",
    !!enviado && enviado.dados.controle_financeiro.length === 1,
    JSON.stringify(enviado && enviado.dados.controle_financeiro),
  );
}

console.log(
  `\n${passou} verificações ok, ${falhas.length} falha(s)` +
    (falhas.length ? "\n- " + falhas.join("\n- ") : ""),
);
process.exit(falhas.length ? 1 : 0);

