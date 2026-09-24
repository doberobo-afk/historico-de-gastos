// ==========================================================================
// HGStore - utilitários de segurança + camada de persistência
// --------------------------------------------------------------------------
// Segurança  : safeParse() (JSON nunca derruba a aplicação) e esc() (escape
//              de HTML para tudo que vem do usuário/planilha)
// Persistência: Supabase direto (tabela public.hg_dados, RLS por user_id) via
//              HGAuth.client() (js/auth-config.js). Sem /api/sync, sem
//              LocalStorage: sem usuário logado, não há dados a carregar.
// IMPORTANTE: hg_dados precisa de UNIQUE (user_id) para o upsert funcionar
//             (onConflict é sempre por user_id, o dono usado pelo RLS):
//   ALTER TABLE public.hg_dados ADD CONSTRAINT hg_dados_user_id_unique UNIQUE (user_id);
//             (ou, melhor, user_id como PRIMARY KEY: ver
//              docs/migracao_pk_user_id.sql)
//
// SEGURANÇA DE DADOS (não regredir!):
//   push() só grava depois de um load() bem-sucedido (estado.carregado).
//   Sem esse guard, uma falha de rede no boot deixava o espelho vazio e o
//   upsert sobrescrevia o documento do usuário na nuvem com cf/cd/cad vazios.
//   As gravações pendentes também são enviadas em pagehide/visibilitychange
//   (flush) e reenviadas com backoff se a rede cair.
// ==========================================================================
(function (global) {
  "use strict";

  // Mesmas chaves usadas antes como cache local; mantidas só como
  // identificadores dos campos de STATE (cf/cd/cad/meta) em salvar()/save().
  var CHAVES = {
    cf: "hg_controle_financeiro",
    cd: "hg_controle_dividas",
    cad: "hg_cadastros",
    meta: "hg_meta",
  };
  var CAMPOS = ["cf", "cd", "cad", "meta"];
  var TABELA = "hg_dados";
  var DEBOUNCE_MS = 900; // agrupa várias alterações em um único upsert

  // Backoff do reenvio automático quando o upsert falha (rede/5xx/401).
  var RETRY_MS = [2000, 5000, 15000, 45000, 120000];

  var estado = {
    modo: "deslogado", // "nuvem" | "deslogado"
    usuario: null,
    userId: null,
    carregado: false, // só vira true após um load() bem-sucedido
    erro: null,
    ultimaSync: null,
    pendente: false,
    tentativas: 0,
  };

  var espelho = { cf: [], cd: [], cad: {}, meta: {} }; // último estado conhecido
  var pendentes = {}; // campos alterados aguardando envio
  var timerPush = null;
  var timerRetry = null;
  var ouvintes = [];

  // Traduz o erro 42P10 do Postgres (falta UNIQUE na coluna do onConflict)
  // numa mensagem acionável, em vez do texto críptico do PostgREST.
  function mensagemErro(e) {
    var base = (e && e.message) || String(e || "");
    if (
      e &&
      (e.code === "42P10" || /no unique|exclusion constraint/i.test(base))
    ) {
      return (
        "hg_dados sem UNIQUE(user_id) - rode no SQL Editor do Supabase: " +
        "ALTER TABLE public.hg_dados ADD CONSTRAINT hg_dados_user_id_unique UNIQUE (user_id);"
      );
    }
    return base || "erro desconhecido";
  }

  // ---------------------------------------------------------------------
  // Utilitários de segurança
  // ---------------------------------------------------------------------
  function safeParse(texto, padrao) {
    if (texto === null || texto === undefined) return padrao;
    if (typeof texto === "object") return texto;
    var s = String(texto).trim();
    if (!s) return padrao;
    try {
      var valor = JSON.parse(s);
      return valor === null || valor === undefined ? padrao : valor;
    } catch (e) {
      console.warn("[HGStore] JSON inválido ignorado:", e.message);
      return padrao;
    }
  }

  function esc(valor) {
    if (valor === null || valor === undefined) return "";
    return String(valor)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Converte número/string (BR "1.234,56" ou US "1234.56") sem retornar NaN
  function num(valor) {
    if (typeof valor === "number") return isFinite(valor) ? valor : 0;
    if (valor === null || valor === undefined) return 0;
    var s = String(valor).replace(/R\$|\s|\u00a0/g, "");
    if (!s) return 0;
    var temVirgula = s.indexOf(",") !== -1;
    var temPonto = s.indexOf(".") !== -1;
    var decimal =
      temVirgula && temPonto
        ? s.lastIndexOf(",") > s.lastIndexOf(".")
          ? ","
          : "."
        : temVirgula
          ? ","
          : ".";
    if (decimal === ",") s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
    var n = parseFloat(s);
    return isFinite(n) ? n : 0;
  }

  // ---------------------------------------------------------------------
  // Semente (exemplos fictícios) - usada só no primeiro acesso de uma conta
  // ---------------------------------------------------------------------
  function semente() {
    var exemplos = global.DADOS_INICIAIS || {};
    return {
      cf: exemplos.controle_financeiro || [],
      cd: exemplos.controle_dividas || [],
      cad: exemplos.cadastros || {},
      meta: exemplos.resumo_meta || {},
    };
  }

  function vazio() {
    return { cf: [], cd: [], cad: {}, meta: {} };
  }

  function normalizar(dados) {
    var d = dados && typeof dados === "object" ? dados : {};
    return {
      cf: Array.isArray(d.controle_financeiro) ? d.controle_financeiro : [],
      cd: Array.isArray(d.controle_dividas) ? d.controle_dividas : [],
      cad: d.cadastros && typeof d.cadastros === "object" ? d.cadastros : {},
      meta:
        d.resumo_meta && typeof d.resumo_meta === "object" ? d.resumo_meta : {},
    };
  }

  function serializar(dados) {
    return {
      controle_financeiro: dados.cf || [],
      controle_dividas: dados.cd || [],
      cadastros: dados.cad || {},
      resumo_meta: dados.meta || {},
    };
  }

  // ---------------------------------------------------------------------
  // Cliente Supabase (compartilhado com HGAuth - js/auth-config.js)
  // ---------------------------------------------------------------------
  function cliente() {
    if (!global.HGAuth || typeof global.HGAuth.client !== "function")
      return null;
    return global.HGAuth.client();
  }

  function status() {
    return {
      modo: estado.modo,
      usuario: estado.usuario,
      carregado: estado.carregado,
      erro: estado.erro,
      pendente: estado.pendente,
      ultimaSync: estado.ultimaSync,
    };
  }

  function emitir() {
    ouvintes.forEach(function (cb) {
      try {
        cb(status());
      } catch (e) {
        console.warn("[HGStore] ouvinte falhou:", e.message);
      }
    });
  }

  // ---------------------------------------------------------------------
  // API pública
  // ---------------------------------------------------------------------
  // Chamado após login/signup bem-sucedido (usuario = e-mail, userId = auth.uid())
  function definirSessao(usuario, userId) {
    estado.usuario = String(usuario || "").trim() || null;
    estado.userId = String(userId || "").trim() || null;
    estado.modo = estado.userId ? "nuvem" : "deslogado";
    // Cada login (ou troca de conta) precisa carregar de novo antes de gravar:
    // é o que impede um usuário de gravar por cima do documento do outro.
    estado.carregado = false;
    estado.erro = null;
    estado.tentativas = 0;
    espelho = vazio();
    pendentes = {};
    return estado.usuario;
  }

  // Chamado no logout: derruba a sessão (nada fica salvo no navegador)
  function limparSessao() {
    estado.usuario = null;
    estado.userId = null;
    estado.modo = "deslogado";
    estado.carregado = false;
    estado.erro = null;
    estado.ultimaSync = null;
    estado.pendente = false;
    estado.tentativas = 0;
    pendentes = {};
    if (timerPush) {
      global.clearTimeout(timerPush);
      timerPush = null;
    }
    if (timerRetry) {
      global.clearTimeout(timerRetry);
      timerRetry = null;
    }
    espelho = vazio();
    emitir();
  }

  // Sem usuário logado: não busca nada. Com usuário: carrega o documento do
  // Supabase e, no primeiro acesso (nenhuma linha ainda), publica a semente.
  function load() {
    if (estado.modo !== "nuvem" || !estado.userId) {
      estado.carregado = false;
      espelho = vazio();
      emitir();
      return Promise.resolve(espelho);
    }
    var c = cliente();
    if (!c) {
      estado.carregado = false;
      estado.erro = "Supabase indisponível";
      emitir();
      return Promise.resolve(vazio());
    }
    return c
      .from(TABELA)
      .select("dados")
      .eq("user_id", estado.userId)
      .maybeSingle()
      .then(function (resp) {
        if (resp.error) throw resp.error;
        if (!resp.data) {
          // Nenhuma linha com este user_id: NÃO grava nada sozinho (já causou
          // perda de dados reais quando o RLS/user_id estava desalinhado).
          // Mostra os exemplos só em memória; eles só são persistidos se o
          // usuário de fato salvar algo (save()/push()) ou clicar em
          // "Restaurar dados de exemplo" (reset()).
          console.warn(
            "[HGStore] nenhuma linha em hg_dados para user_id=" +
              estado.userId +
              " (usuario=" +
              estado.usuario +
              "). Mostrando exemplos em memória, SEM salvar na nuvem. Se " +
              "você já tem dados, confira se o user_id da linha em hg_dados " +
              "bate com este id (auth.users.id da sessão atual) antes de " +
              "criar qualquer lançamento novo.",
          );
          var sementeDados = semente();
          espelho = sementeDados;
          // O carregamento em si deu certo (a conta simplesmente ainda não tem
          // documento): libera a gravação, mas nada é enviado sem ação do
          // usuário.
          estado.carregado = true;
          estado.tentativas = 0;
          estado.erro =
            "nenhum documento salvo ainda para esta conta (exemplos exibidos, nada foi gravado)";
          emitir();
          return sementeDados;
        }
        var dados = normalizar(resp.data.dados);
        var primeiroCarregamento = !estado.carregado;
        var tinhaPendentes = Object.keys(pendentes).length > 0;
        espelho = dados;
        estado.carregado = true;
        estado.tentativas = 0;
        estado.erro = null;
        estado.ultimaSync = new Date().toISOString();
        if (primeiroCarregamento && tinhaPendentes) {
          // Havia alterações pendentes feitas quando a base ainda era
          // desconhecida (o load anterior falhou). Enviá-las substituiria o
          // documento inteiro e apagaria o histórico real da nuvem, então elas
          // são descartadas aqui e o usuário é avisado pelo status.
          pendentes = {};
          estado.pendente = false;
          estado.erro =
            "seus dados da nuvem foram recarregados; as alterações feitas antes disso foram descartadas para não sobrescrever o histórico";
        }
        emitir();
        return dados;
      })
      .catch(function (e) {
        estado.erro = mensagemErro(e);
        // Load falhou: BLOQUEIA a gravação (ver push()). Sem isso, o próximo
        // push enviaria o documento vazio e apagaria os dados do usuário.
        estado.carregado = false;
        espelho = vazio();
        emitir();
        return espelho;
      });
  }

  // Guarda em memória e agenda o upsert no Supabase (debounce)
  function save(chaveLS, valor) {
    var campo = null;
    CAMPOS.forEach(function (c) {
      if (CHAVES[c] === chaveLS) campo = c;
    });
    if (!campo) return; // chave desconhecida: ignora

    espelho[campo] = valor;
    pendentes[campo] = valor;

    if (estado.modo !== "nuvem" || !estado.userId) return;
    estado.pendente = true;
    emitir();
    if (timerPush) global.clearTimeout(timerPush);
    timerPush = global.setTimeout(push, DEBOUNCE_MS);
  }

  // Reenvia automaticamente o que ficou pendente (rede instável: sai e volta)
  function agendarRetry() {
    if (timerRetry) return;
    if (estado.modo !== "nuvem" || !estado.userId) return;
    var i = Math.min(estado.tentativas, RETRY_MS.length - 1);
    timerRetry = global.setTimeout(function () {
      timerRetry = null;
      if (estado.modo !== "nuvem" || !estado.userId) return;
      if (!estado.carregado) {
        // Sem carregamento confirmado ainda: tenta carregar e só depois grava
        // (o que o usuário alterou continua guardado em pendentes).
        load().then(function () {
          if (estado.carregado && estado.pendente) push();
        });
        return;
      }
      if (estado.pendente) push();
    }, RETRY_MS[i]);
  }

  // Envia AGORA o que estiver pendente. Usado em pagehide/visibilitychange
  // (fechar/mínimizar a aba não espera o debounce), no logout e no botão de
  // "tentar novamente" do indicador de sincronização.
  function flush() {
    if (timerPush) {
      global.clearTimeout(timerPush);
      timerPush = null;
    }
    if (estado.modo !== "nuvem" || !estado.userId)
      return Promise.resolve(false);
    if (!estado.pendente) return Promise.resolve(false);
    return push();
  }

  // Pedido manual de sincronização (indicador de status clicável).
  function retry() {
    if (estado.modo !== "nuvem" || !estado.userId)
      return Promise.resolve(false);
    if (estado.carregado) return flush();
    return load();
  }

  function push() {
    if (estado.modo !== "nuvem" || !estado.userId)
      return Promise.resolve(false);
    // GUARD DE SEGURANÇA: nunca gravar antes de um carregamento bem-sucedido.
    // Se o load falhou, o espelho está vazio e o upsert apagaria o documento
    // do usuário na nuvem. Aqui a gravação é bloqueada e o erro fica visível.
    if (!estado.carregado) {
      estado.pendente = true;
      estado.erro =
        "não foi possível carregar seus dados da nuvem — gravação bloqueada para não sobrescrever seu histórico";
      agendarRetry();
      emitir();
      return Promise.resolve(false);
    }
    var c = cliente();
    if (!c) return Promise.resolve(false);
    var dados = {
      cf: pendentes.cf !== undefined ? pendentes.cf : espelho.cf,
      cd: pendentes.cd !== undefined ? pendentes.cd : espelho.cd,
      cad: pendentes.cad !== undefined ? pendentes.cad : espelho.cad,
      meta: pendentes.meta !== undefined ? pendentes.meta : espelho.meta,
    };
    return c
      .from(TABELA)
      .upsert(
        {
          usuario: estado.usuario,
          user_id: estado.userId,
          dados: serializar(dados),
          atualizado_em: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      )
      .then(function (resp) {
        if (resp.error) throw resp.error;
        pendentes = {};
        estado.pendente = false;
        estado.erro = null;
        estado.tentativas = 0;
        estado.ultimaSync = new Date().toISOString();
        emitir();
        return true;
      })
      .catch(function (e) {
        estado.erro = mensagemErro(e);
        estado.pendente = true;
        estado.tentativas++;
        agendarRetry(); // tenta de novo com backoff (e em "online")
        emitir();
        return false;
      });
  }

  // Apaga o documento do usuário na nuvem e volta para os exemplos fictícios
  function reset() {
    pendentes = {};
    var sementeDados = semente();
    espelho = sementeDados;

    if (estado.modo !== "nuvem" || !estado.userId) {
      emitir();
      return Promise.resolve(sementeDados);
    }
    var c = cliente();
    if (!c) return Promise.resolve(sementeDados);
    return c
      .from(TABELA)
      .upsert(
        {
          usuario: estado.usuario,
          user_id: estado.userId,
          dados: serializar(sementeDados),
          atualizado_em: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      )
      .then(function (resp) {
        if (resp.error) throw resp.error;
        estado.carregado = true; // substituição explícita e confirmada
        estado.pendente = false;
        estado.erro = null;
        estado.tentativas = 0;
        estado.ultimaSync = new Date().toISOString();
        emitir();
        return sementeDados;
      })
      .catch(function (e) {
        estado.erro = mensagemErro(e);
        estado.pendente = true;
        estado.tentativas++;
        agendarRetry();
        emitir();
        return sementeDados;
      });
  }

  // ---------------------------------------------------------------------
  // Garantia de entrega: manda o que estiver pendente antes do navegador
  // fechar/mínimizar a aba e assim que a conexão voltar.
  // ---------------------------------------------------------------------
  if (global.addEventListener) {
    global.addEventListener("pagehide", function () {
      flush();
    });
    global.addEventListener("beforeunload", function () {
      flush();
    });
    global.addEventListener("online", function () {
      estado.tentativas = 0;
      flush();
    });
  }
  if (global.document && global.document.addEventListener) {
    global.document.addEventListener("visibilitychange", function () {
      if (global.document.visibilityState === "hidden") flush();
    });
  }

  function onChange(cb) {
    if (typeof cb === "function") {
      ouvintes.push(cb);
      cb(status());
    }
    return function () {
      ouvintes = ouvintes.filter(function (o) {
        return o !== cb;
      });
    };
  }

  global.HGStore = {
    CHAVES: CHAVES,
    safeParse: safeParse,
    esc: esc,
    num: num,
    definirSessao: definirSessao,
    limparSessao: limparSessao,
    load: load,
    save: save,
    push: push,
    flush: flush,
    retry: retry,
    reset: reset,
    status: status,
    onChange: onChange,
  };
})(window);
