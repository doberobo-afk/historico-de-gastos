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

  var estado = {
    modo: "deslogado", // "nuvem" | "deslogado"
    usuario: null,
    userId: null,
    erro: null,
    ultimaSync: null,
    pendente: false,
  };

  var espelho = { cf: [], cd: [], cad: {}, meta: {} }; // último estado conhecido
  var pendentes = {}; // campos alterados aguardando envio
  var timerPush = null;
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
    return estado.usuario;
  }

  // Chamado no logout: derruba a sessão (nada fica salvo no navegador)
  function limparSessao() {
    estado.usuario = null;
    estado.userId = null;
    estado.modo = "deslogado";
    estado.erro = null;
    estado.ultimaSync = null;
    estado.pendente = false;
    pendentes = {};
    if (timerPush) {
      global.clearTimeout(timerPush);
      timerPush = null;
    }
    espelho = vazio();
    emitir();
  }

  // Sem usuário logado: não busca nada. Com usuário: carrega o documento do
  // Supabase e, no primeiro acesso (nenhuma linha ainda), publica a semente.
  function load() {
    if (estado.modo !== "nuvem" || !estado.userId) {
      espelho = vazio();
      emitir();
      return Promise.resolve(espelho);
    }
    var c = cliente();
    if (!c) {
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
          // Primeiro acesso desta conta: publica a semente de exemplos
          var sementeDados = semente();
          espelho = sementeDados;
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
            .then(function () {
              estado.erro = null;
              estado.ultimaSync = new Date().toISOString();
              emitir();
              return sementeDados;
            });
        }
        var dados = normalizar(resp.data.dados);
        espelho = dados;
        estado.erro = null;
        estado.ultimaSync = new Date().toISOString();
        emitir();
        return dados;
      })
      .catch(function (e) {
        estado.erro = mensagemErro(e);
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

  function push() {
    if (estado.modo !== "nuvem" || !estado.userId)
      return Promise.resolve(false);
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
        estado.ultimaSync = new Date().toISOString();
        emitir();
        return true;
      })
      .catch(function (e) {
        estado.erro = mensagemErro(e);
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
        estado.pendente = false;
        estado.erro = null;
        estado.ultimaSync = new Date().toISOString();
        emitir();
        return sementeDados;
      })
      .catch(function (e) {
        estado.erro = mensagemErro(e);
        emitir();
        return sementeDados;
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
    reset: reset,
    status: status,
    onChange: onChange,
  };
})(window);
