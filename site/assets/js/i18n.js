/* ==========================================================================
   PHYGITAL BRASIL — TRADUÇÃO EM TEMPO DE EXECUÇÃO

   PRIMEIRO SCRIPT DE TODAS AS 50 PÁGINAS — antes de dados.js e de phygital.js.

   A ordem é obrigatória, não estética. O dados.js pede /api/bootstrap durante o
   parse e o servidor devolve o conteúdo cadastrado JÁ TRADUZIDO; para traduzir
   no idioma certo ele precisa do ?lang=, e quem sabe o idioma é este arquivo.
   Enquanto ele vinha depois, a requisição saía com o cookie da navegação
   ANTERIOR: ?lang=en abria o conteúdo em português e ?lang=es abria em inglês.
   Por isso a resolução do idioma acontece no parse deste arquivo, síncrona, sem
   depender do bootstrap.

   COMO FUNCIONA
   O português continua escrito no HTML, exatamente como está hoje: nenhuma
   página ganhou data-i18n, nenhum layout mudou. A chave do dicionário é o
   PRÓPRIO TEXTO EM PORTUGUÊS, normalizado. Ao trocar de idioma, o runtime
   percorre o DOM, procura cada nó de texto no dicionário e reescreve o que
   encontrou. Em 'pt' não faz nada além de marcar o idioma — custo zero no
   idioma principal.

   Os dicionários são gerados por `node ferramentas/extrair-textos.js`. A
   função normalizar() daqui é a MESMA do extrator, letra por letra: se as duas
   divergirem numa vírgula, a chave não casa e nada é traduzido, sem erro no
   console.

   O QUE NUNCA É TRADUZIDO
   1. O que não está no dicionário. O dicionário só tem texto que um
      programador escreveu no HTML ou no JS do site; nome de time, texto de
      chamado e manchete cadastrada vêm do banco e não estão lá. É esta a
      garantia principal de que dado de usuário fica intacto — traduzir dado de
      usuário é pior que não traduzir. (O extrator ignora de propósito a semente
      de demonstração de dados.js, que é dado disfarçado de código.)
   2. Campo que o usuário edita: o valor de input, textarea e [contenteditable]
      nunca é tocado. Só o placeholder, que é rótulo.
   3. Qualquer subárvore marcada com data-i18n="nao", translate="no" ou
      .notranslate, e o conteúdo de <script>, <style>, <pre>, <code> e <svg>.

   API
     PB.i18n.idioma()        'pt' | 'en' | 'es'
     PB.i18n.definir(cod)    troca e persiste; com back-end recarrega a página,
                             porque o conteúdo cadastrado vem traduzido de lá
     PB.i18n.escolhido()     o idioma quando foi escolha, null quando foi palpite
     PB.i18n.t(texto)        traduz uma string solta (para o JS das páginas)
     PB.i18n.traduzir(raiz)  traduz o que houver dentro de um nó
     PB.i18n.idiomas()       lista de { codigo, rotulo }
   ========================================================================== */
(function (global, doc) {
  'use strict';

  var PB = global.PB = global.PB || {};

  var IDIOMAS = [
    { codigo: 'pt', rotulo: 'Português', html: 'pt-BR' },
    { codigo: 'en', rotulo: 'English', html: 'en' },
    { codigo: 'es', rotulo: 'Español', html: 'es' }
  ];

  var PADRAO = 'pt';
  var COOKIE = 'phygital_idioma';
  var CHAVE_LOCAL = 'phygital.idioma';
  var UM_ANO = 31536000;

  /* Mesma lista do extrator: o que não é conteúdo, mas o usuário lê. */
  var ATRIBUTOS = [
    'placeholder', 'title', 'aria-label', 'alt',
    'data-confirmar', 'data-confirmar-titulo', 'data-confirmar-ok',
    'data-demo', 'data-placeholder'
  ];

  var TIPOS_DE_BOTAO = { button: 1, submit: 1, reset: 1 };

  /* Conteúdo que não é texto de interface. Mesma lista do extrator. */
  var TAGS_OPACAS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, PRE: 1, CODE: 1, SVG: 1 };

  var _idioma = PADRAO;
  var _origem = 'padrao';        /* url | cookie | escolha | conta | servidor | navegador | padrao */
  var _textos = {};              /* chave normalizada -> tradução */
  var _padroes = [];             /* rótulos montados em tempo de execução */
  var _cache = {};               /* idioma -> pacote já baixado */
  var _tocado = false;           /* algum nó já foi reescrito nesta página? */
  var _observador = null;

  /* =====================================================================
     NORMALIZAÇÃO — espelhada em ferramentas/extrair-textos.js
     ===================================================================== */

  function normalizar(texto) {
    return String(texto == null ? '' : texto).replace(/\s+/g, ' ').trim();
  }

  function temLetra(texto) {
    return /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(texto);
  }

  function proprio(obj, chave) {
    return Object.prototype.hasOwnProperty.call(obj, chave);
  }

  /* =====================================================================
     ONDE MORAM OS DICIONÁRIOS

     A página pública usa assets/…, as do painel usam ../assets/…. Em vez de
     adivinhar, o caminho sai do src desta própria tag <script>.
     ===================================================================== */

  var BASE = (function () {
    var tag = doc.currentScript;
    if (!tag) {
      var tags = doc.getElementsByTagName('script');
      for (var i = tags.length - 1; i >= 0; i--) {
        if (/i18n\.js(\?|#|$)/.test(tags[i].getAttribute('src') || '')) { tag = tags[i]; break; }
      }
    }
    var src = tag ? (tag.getAttribute('src') || '') : '';
    if (!src) return 'assets/i18n/';
    return src.replace(/[^/]*$/, '').replace(/js\/$/, 'i18n/');
  }());

  /* XHR SÍNCRONO, de propósito — é o mesmo caminho que dados.js já usa.
     O dicionário precisa estar em memória antes do primeiro nó ser traduzido:
     em assíncrono a página apareceria em português e piscaria para o inglês
     um instante depois, e t() chamado pelo script da página devolveria
     português. Só acontece fora do 'pt', e o navegador guarda em cache. */
  function baixar(codigo) {
    if (_cache[codigo]) return _cache[codigo];

    var pacote = { textos: {}, padroes: [] };
    try {
      var req = new global.XMLHttpRequest();
      req.open('GET', BASE + codigo + '.json', false);
      req.send(null);
      if (req.status >= 200 && req.status < 300) {
        pacote = compilar(JSON.parse(req.responseText));
      }
    } catch (e) {
      /* Sem dicionário a página fica em português inteira, que é o certo:
         idioma quebrado não pode virar tela em branco. */
    }
    _cache[codigo] = pacote;
    return pacote;
  }

  /* Só entra no índice o que tem tradução de verdade. Com en.json ainda vazio,
     os dois mapas ficam vazios e o runtime não mexe em nada — é o que faz a
     entrega parcial ser segura. */
  function compilar(json) {
    var textos = {};
    var padroes = [];
    var mapa = (json && json.textos) || {};
    var chave;

    for (chave in mapa) {
      if (proprio(mapa, chave) && mapa[chave]) textos[normalizar(chave)] = mapa[chave];
    }

    var brutos = (json && json.padroes) || {};
    for (chave in brutos) {
      if (!proprio(brutos, chave) || !brutos[chave]) continue;
      var p = compilarPadrao(normalizar(chave), brutos[chave]);
      if (p) padroes.push(p);
    }
    return { textos: textos, padroes: padroes };
  }

  /* =====================================================================
     PADRÕES

     "{0} de {1} vagas oficiais preenchidas" não existe no HTML: a página monta
     esse rótulo por concatenação e o DOM recebe UM nó de texto já com os
     números dentro ("18 de 24 vagas oficiais preenchidas"). Casar isso exige
     expressão regular, então cada padrão vira uma.

     Para não sair casando frase à toa:
       - padrão sem trecho fixo com pelo menos 3 letras é descartado;
       - antes de rodar a regex há um indexOf no maior trecho fixo, que
         elimina quase tudo sem custo.
     ===================================================================== */

  function escaparRegex(texto) {
    return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function compilarPadrao(origem, saida) {
    var partes = origem.split(/\{(\d+)\}/);
    if (partes.length < 3) return null;          /* nenhum marcador */

    var fonte = '';
    var numeros = [];                            /* grupo N da regex -> {n} */
    var ancora = '';
    var letras = 0;
    var i;

    for (i = 0; i < partes.length; i++) {
      if (i % 2 === 0) {
        fonte += escaparRegex(partes[i]);
        if (partes[i].length > ancora.length) ancora = partes[i];
        letras += (partes[i].match(/[A-Za-zÀ-ÖØ-öø-ÿ]/g) || []).length;
      } else {
        fonte += '([\\s\\S]*?)';
        numeros.push(partes[i]);
      }
    }

    ancora = normalizar(ancora);
    if (ancora.length < 3 || !temLetra(ancora) || letras < 4) return null;

    try {
      return { re: new RegExp('^' + fonte + '$'), numeros: numeros, ancora: ancora, saida: saida };
    } catch (e) {
      return null;
    }
  }

  function aplicarPadroes(chave) {
    for (var i = 0; i < _padroes.length; i++) {
      var p = _padroes[i];
      if (chave.indexOf(p.ancora) < 0) continue;
      var m = p.re.exec(chave);
      if (!m) continue;

      var valores = {};
      for (var j = 0; j < p.numeros.length; j++) valores[p.numeros[j]] = m[j + 1];

      /* A tradução pode trocar a ordem dos marcadores — em espanhol o número
         costuma vir depois do rótulo. Por isso a substituição é por número, e
         não pela posição. */
      return p.saida.replace(/\{(\d+)\}/g, function (tudo, n) {
        return valores[n] === undefined ? '' : valores[n];
      });
    }
    return null;
  }

  /** @returns {string|null} null quando não há tradução para este texto. */
  function procurar(chave) {
    if (proprio(_textos, chave)) return _textos[chave];
    if (_padroes.length) return aplicarPadroes(chave);
    return null;
  }

  /* =====================================================================
     TRADUÇÃO DO DOM
     ===================================================================== */

  function pular(el) {
    if (!el || el.nodeType !== 1) return false;
    if (TAGS_OPACAS[String(el.nodeName).toUpperCase()]) return true;
    if (el.getAttribute) {
      if (el.getAttribute('data-i18n') === 'nao') return true;
      if (el.getAttribute('translate') === 'no') return true;
    }
    /* Texto que o usuário está escrevendo não se mexe. */
    if (el.isContentEditable) return true;
    if (el.className && String(el.className).indexOf('notranslate') >= 0) return true;
    return false;
  }

  /* O espaço da beirada é layout: "Fale " + <a> perde o espaço se a tradução
     entrar crua. A chave é o texto aparado; o que volta mantém as bordas. */
  function comBordas(original, texto) {
    var ini = /^\s*/.exec(original)[0];
    var fim = /\s*$/.exec(original)[0];
    return ini + texto + fim;
  }

  function traduzirTexto(no) {
    if (!no.nodeValue) return;

    /* Se o valor atual não é o que ESTE runtime escreveu, quem mandou foi a
       página: o texto de agora passa a ser o original. Sem isso, uma lista
       reescrita depois da troca de idioma ficaria presa no texto antigo. */
    var original = (no.pbAplicado !== undefined && no.nodeValue === no.pbAplicado)
      ? no.pbOriginal
      : no.nodeValue;

    var chave = normalizar(original);
    if (!chave || !temLetra(chave)) return;

    var traducao = procurar(chave);
    if (traducao === null || traducao === chave) {
      /* Sem tradução: volta ao português se este nó tinha sido traduzido. */
      if (no.pbOriginal !== undefined && no.nodeValue !== no.pbOriginal) {
        no.nodeValue = no.pbOriginal;
        no.pbAplicado = no.pbOriginal;
      }
      return;
    }

    var novo = comBordas(original, traducao);
    if (no.nodeValue === novo) return;
    no.pbOriginal = original;
    no.pbAplicado = novo;
    no.nodeValue = novo;
    _tocado = true;
  }

  function traduzirAtributo(el, nome) {
    var atual = el.getAttribute(nome);
    if (atual === null) return;

    var guarda = el.pbAtributos || (el.pbAtributos = {});
    var registro = guarda[nome];
    var original = (registro && registro.aplicado === atual) ? registro.original : atual;

    var chave = normalizar(original);
    if (!chave || !temLetra(chave)) return;

    var traducao = procurar(chave);
    if (traducao === null || traducao === chave) {
      if (registro && atual !== registro.original) {
        el.setAttribute(nome, registro.original);
        guarda[nome] = { original: registro.original, aplicado: registro.original };
      }
      return;
    }
    if (atual === traducao) return;
    el.setAttribute(nome, traducao);
    guarda[nome] = { original: original, aplicado: traducao };
    _tocado = true;
  }

  function traduzirAtributos(el) {
    if (!el.getAttribute) return;
    for (var i = 0; i < ATRIBUTOS.length; i++) traduzirAtributo(el, ATRIBUTOS[i]);

    var tag = String(el.nodeName).toUpperCase();
    /* value só é rótulo em botão. Em campo de texto é o que o usuário digitou. */
    if (tag === 'BUTTON') traduzirAtributo(el, 'value');
    if (tag === 'INPUT' && TIPOS_DE_BOTAO[String(el.type || '').toLowerCase()]) traduzirAtributo(el, 'value');
    if (tag === 'META' && el.getAttribute('name') === 'description') traduzirAtributo(el, 'content');
  }

  function percorrer(no) {
    if (!no) return;
    var tipo = no.nodeType;

    if (tipo === 3) { traduzirTexto(no); return; }
    if (tipo !== 1 && tipo !== 9 && tipo !== 11) return;
    if (tipo === 1) {
      if (pular(no)) return;
      traduzirAtributos(no);
    }

    var filhos = no.childNodes;
    for (var i = 0; i < filhos.length; i++) percorrer(filhos[i]);
  }

  function vazio() {
    for (var k in _textos) { if (proprio(_textos, k)) return false; }
    return _padroes.length === 0;
  }

  /**
   * Traduz o que houver dentro de um nó. Chame depois de montar HTML na mão —
   * embora o MutationObserver já faça isso sozinho.
   */
  function traduzir(raiz) {
    /* Dicionário vazio E nada traduzido ainda: não há o que fazer nem o que
       desfazer. É este atalho que deixa 'pt' custar zero. */
    if (vazio() && !_tocado) return;
    var alvo = raiz || doc.documentElement;
    var pai = alvo.parentNode;
    /* Nó entregue pelo observador pode estar dentro de <script> ou de uma área
       marcada como intraduzível; a checagem do pai evita entrar nela. */
    if (pai && pai.nodeType === 1 && pular(pai)) return;
    percorrer(alvo);
  }

  /* =====================================================================
     CONTEÚDO QUE O JAVASCRIPT MONTA DEPOIS

     Metade das telas do painel escreve innerHTML depois da carga. O observador
     traduz o que entrar.

     Não entra em laço porque as próprias alterações não são observadas: o
     observador é desligado antes de traduzir e religado depois. E porque cada
     nó guarda o que ESTE runtime escreveu (pbAplicado); se o valor atual for
     esse, não há nada de novo para traduzir.

     Não pesa em lista longa porque as mutações são juntadas num setTimeout(0):
     um innerHTML com 200 linhas vira UMA varredura, e não 200.
     ===================================================================== */

  var _pendentes = [];
  var _agendado = 0;

  function coletar(registros) {
    for (var i = 0; i < registros.length; i++) {
      var r = registros[i];
      if (r.type === 'characterData') { _pendentes.push(r.target); continue; }
      if (r.type === 'attributes') { _pendentes.push(r.target); continue; }
      for (var j = 0; j < r.addedNodes.length; j++) _pendentes.push(r.addedNodes[j]);
    }
  }

  function noDocumento(no) {
    if (no.isConnected !== undefined) return no.isConnected;
    return doc.documentElement.contains ? doc.documentElement.contains(no) : true;
  }

  function processarPendentes() {
    _agendado = 0;
    /* O que chegou entre o agendamento e agora ainda está na fila do
       observador; recolhe antes de desligar, senão essa leva se perde. */
    coletar(_observador.takeRecords());
    var lista = _pendentes;
    _pendentes = [];

    _observador.disconnect();
    try {
      /* Muitos nós soltos numa leva só: sai mais barato varrer a página uma
         vez do que repetir subárvores que se sobrepõem. */
      if (lista.length > 200) {
        percorrer(doc.body || doc.documentElement);
      } else {
        for (var i = 0; i < lista.length; i++) {
          if (lista[i] && noDocumento(lista[i])) traduzir(lista[i]);
        }
      }
    } finally {
      ligarObservador();
    }
  }

  function aoMudar(registros) {
    coletar(registros);
    if (!_pendentes.length || _agendado) return;
    _agendado = global.setTimeout(processarPendentes, 0);
  }

  /* Em 'pt' o observador nem chega a ser ligado: sem dicionário não há o que
     traduzir, e observar o documento inteiro à toa é justamente o custo que o
     idioma principal não pode ter. */
  function ligarObservador() {
    if (!global.MutationObserver || vazio()) return;
    if (!_observador) _observador = new global.MutationObserver(aoMudar);
    _observador.observe(doc.documentElement, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ATRIBUTOS.concat(['value', 'content'])
    });
  }

  function desligarObservador() {
    if (_observador) _observador.disconnect();
  }

  /* =====================================================================
     ESCOLHA DO IDIOMA

     Ordem: ?lang= na URL → cookie → preferência da conta → navegador → 'pt'.
     ===================================================================== */

  function suportado(codigo) {
    for (var i = 0; i < IDIOMAS.length; i++) if (IDIOMAS[i].codigo === codigo) return true;
    return false;
  }

  /** 'pt-BR' e 'PT' viram 'pt'; o que não for dos três vira null. */
  function limpar(valor) {
    if (!valor) return null;
    var c = String(valor).toLowerCase().replace(/_/g, '-').split('-')[0];
    return suportado(c) ? c : null;
  }

  /* decodeURIComponent lança URIError em escape truncado ('%', '%C3'), e os dois
     valores abaixo vêm de fora — barra de endereços e cookie. Estourar aqui
     derrubava o arquivo inteiro na carga: PB.i18n deixava de existir e o
     seletor sumia de todas as páginas, até alguém limpar o cookie na mão. */
  function decodificar(v) {
    try { return decodeURIComponent(v); } catch (e) { return v; }
  }

  function daUrl() {
    var busca = global.location && global.location.search;
    if (!busca) return null;
    var m = /[?&](?:lang|idioma)=([^&#]*)/i.exec(busca);
    return m ? limpar(decodificar(m[1])) : null;
  }

  function doCookie() {
    var todos = doc.cookie || '';
    var m = new RegExp('(?:^|; )' + COOKIE + '=([^;]*)').exec(todos);
    if (m) return limpar(decodificar(m[1]));
    try {
      return limpar(global.localStorage && global.localStorage.getItem(CHAVE_LOCAL));
    } catch (e) {
      return null;
    }
  }

  /* Preferência gravada na conta, como veio no /api/bootstrap. Não força
     chamada nenhuma: se o bootstrap ainda não rodou, devolve null e a decisão
     é revista quando o DOM fica pronto. */
  function daConta() {
    try {
      var conta = (PB.api && PB.api.conta && PB.api.conta())
        || (PB.dados && PB.dados.sessao && PB.dados.sessao());
      if (!conta) return null;
      return limpar(conta.idioma || conta.idiomaPreferido || conta.preferenciaIdioma);
    } catch (e) {
      return null;
    }
  }

  function doNavegador() {
    var nav = global.navigator;
    if (!nav) return null;
    var lista = nav.languages && nav.languages.length ? nav.languages : [nav.language || nav.userLanguage];
    for (var i = 0; i < lista.length; i++) {
      var c = limpar(lista[i]);
      if (c) return c;
    }
    return null;
  }

  /* Idioma que o servidor resolveu para a carga desta página, como veio no
     /api/bootstrap. É a resposta mais completa que existe: só ele enxerga a
     preferência gravada na conta, e o front-end não tem como ler essa coluna
     antes do bootstrap. null quando não há back-end. */
  function doServidor() {
    try {
      var d = PB.dados;
      if (!d || typeof d.idiomaResolvido !== 'function') return null;
      return limpar(d.idiomaResolvido());
    } catch (e) {
      return null;
    }
  }

  function resolver() {
    var c = daUrl();
    if (c) { _origem = 'url'; return c; }
    c = doCookie();
    if (c) { _origem = 'cookie'; return c; }
    c = daConta();
    if (c) { _origem = 'conta'; return c; }
    c = doNavegador();
    if (c) { _origem = 'navegador'; return c; }
    _origem = 'padrao';
    return PADRAO;
  }

  /* Origens que são DECISÃO — de quem montou o link, de quem já navegou aqui
     ou de quem clicou no seletor. 'navegador' e 'padrao' são palpite, e palpite
     não vale como ?lang= no bootstrap: atropelaria a preferência da conta, que
     só o servidor conhece. Ver o cabeçalho de dados.js. */
  var EXPLICITAS = { url: 1, cookie: 1, escolha: 1 };

  /* O cookie é o que o servidor lê para responder e-mail e mensagem de erro no
     idioma certo; o localStorage é o reforço para quando o cookie não pega
     (file://, navegação privada com cookie bloqueado). */
  function persistir(codigo) {
    try {
      /* encodeURIComponent mesmo com valor conhecido ('pt'/'en'/'es'): quem lê
         do outro lado decodifica, e gravar cru é o hábito que um dia produz o
         cookie que derruba o parser. */
      doc.cookie = COOKIE + '=' + encodeURIComponent(codigo)
        + '; Path=/; Max-Age=' + UM_ANO + '; SameSite=Lax';
    } catch (e) { /* sem cookie, segue só com localStorage */ }
    try {
      if (global.localStorage) global.localStorage.setItem(CHAVE_LOCAL, codigo);
    } catch (e) { /* cota / modo privado */ }
  }

  function marcarHtml(codigo) {
    for (var i = 0; i < IDIOMAS.length; i++) {
      if (IDIOMAS[i].codigo === codigo) {
        doc.documentElement.setAttribute('lang', IDIOMAS[i].html);
        return;
      }
    }
  }

  function carregarDicionario(codigo) {
    if (codigo === PADRAO) { _textos = {}; _padroes = []; return; }
    var pacote = baixar(codigo);
    _textos = pacote.textos;
    _padroes = pacote.padroes;
  }

  /* O CONTEÚDO CADASTRADO NÃO ESTÁ NO DICIONÁRIO

     Nome de campeonato, manchete e texto de banner vêm traduzidos do servidor,
     dentro do /api/bootstrap, e as ~50 páginas os desenham UMA vez, durante o
     parse. Reescrever o dicionário da interface não alcança esse texto — ele
     não está no dicionário, está no cache de dados. Sem o recarregamento
     abaixo, clicar no seletor trocava a interface na hora e deixava o nome do
     campeonato na língua anterior: exatamente a tela misturada que este arquivo
     existe para não produzir.

     É o mesmo remédio que PB.recarregar() aplica depois de toda gravação, pelo
     mesmo motivo: tela meio velha é pior que tela que pisca. E é UMA requisição
     só — a página que volta já pede o bootstrap com o idioma novo, porque o
     cookie foi gravado antes de sair daqui.

     Sem back-end (GitHub Pages, file://) o conteúdo é a semente em português e
     não muda com o idioma; ali a troca continua instantânea, sem recarregar. */
  function conteudoVemDoServidor() {
    try {
      return !!(PB.dados && typeof PB.dados.modo === 'function' && PB.dados.modo() === 'api');
    } catch (e) {
      return false;
    }
  }

  /* Recarrega a MESMA página, preservando a querystring (?id=…). O ?lang= é
     reescrito quando existe: deixá-lo com o valor antigo faria o parâmetro
     vencer o cookie recém-gravado e a tela voltaria para o idioma de antes. */
  function recarregarNoIdioma(codigo) {
    var loc = global.location;
    var busca = loc.search || '';
    if (/[?&](?:lang|idioma)=/i.test(busca)) {
      busca = busca.replace(/([?&])(lang|idioma)=[^&#]*/gi, '$1$2=' + encodeURIComponent(codigo));
    }
    loc.replace(loc.pathname + busca);
  }

  /**
   * @param {string} codigo
   * @param {boolean} [silencioso] true = só alinha a interface: não grava o
   *   cookie nem recarrega. É como o runtime se ajusta ao idioma que o servidor
   *   já usou para traduzir o conteúdo desta carga.
   */
  function definir(codigo, silencioso) {
    var alvo = limpar(codigo);
    if (!alvo || alvo === _idioma) {
      sincronizarSeletores();
      return _idioma;
    }

    if (!silencioso) {
      _origem = 'escolha';
      persistir(alvo);
    }
    _idioma = alvo;

    if (!silencioso && conteudoVemDoServidor()) {
      sincronizarSeletores();
      recarregarNoIdioma(alvo);
      return _idioma;
    }

    marcarHtml(alvo);
    carregarDicionario(alvo);

    /* A troca é na hora: cada nó guarda o português original, então voltar para
       'pt' é reescrever o original de volta. */
    desligarObservador();
    traduzir(doc.documentElement);
    ligarObservador();

    sincronizarSeletores();
    return _idioma;
  }

  /* =====================================================================
     SELETOR DE IDIOMA

     Única adição visual. O cabeçalho e a barra lateral estão copiados nas 50
     páginas; editar as 50 à mão seria 50 chances de errar. O seletor é
     injetado aqui, procurando o ponto de ancoragem. Se a página não tiver o
     ponto, não acontece nada — como todo inicializador deste projeto.
     ===================================================================== */

  var ESTILO = [
    '.i18n-idioma{display:inline-flex;align-items:center;gap:6px;color:inherit}',
    '.i18n-idioma__globo{width:14px;height:14px;flex:none;opacity:.85}',
    /* O site estiliza todo <select> como campo de formulário: 48px de altura,
       borda, fundo branco e seta. Aqui é um controle de barra, não um campo —
       por isso a régua toda é desfeita, senão a faixa do cabeçalho cresce. */
    '.i18n-idioma__campo{appearance:none;-webkit-appearance:none;-moz-appearance:none;',
    'width:auto;min-height:0;border:0;border-radius:0;box-shadow:none;',
    'background:transparent;color:inherit;font:inherit;letter-spacing:inherit;',
    'cursor:pointer;padding:2px 2px 2px 0;line-height:1.2}',
    '.i18n-idioma__campo:hover,.i18n-idioma__campo:focus{border:0;box-shadow:none}',
    '.i18n-idioma__campo:focus-visible{outline:2px solid var(--amarelo);outline-offset:2px}',
    /* A lista nativa herda a cor do <select>; sem isto, opção branca em fundo
       branco no Windows. */
    '.i18n-idioma__campo option{color:var(--grafite);background:var(--branco)}',
    '.i18n-idioma--topo .i18n-idioma__campo{text-transform:uppercase}',
    '.i18n-idioma--topo{color:var(--cinza-40)}',
    '.i18n-idioma--topo:hover{color:var(--amarelo)}',
    '.i18n-idioma--mobile{display:flex;width:100%;padding:var(--e-3) 0;',
    'border-bottom:1px solid var(--linha);color:rgba(255,255,255,.9);',
    'font-family:var(--fonte-display);font-weight:600;text-transform:uppercase;',
    'letter-spacing:.05em;font-size:.9375rem}',
    '.i18n-idioma--mobile .i18n-idioma__globo{width:18px;height:18px}',
    '.i18n-idioma--painel{display:flex;width:100%;min-height:46px;gap:var(--e-3);',
    'padding:12px var(--e-4);border-top:1px solid var(--linha);',
    'color:rgba(255,255,255,.7);font-size:.9375rem}',
    '.i18n-idioma--painel .i18n-idioma__globo{width:19px;height:19px}',
    '.i18n-idioma--painel:hover{background:rgba(255,255,255,.06);color:#fff}',

    /* Telas .auth — FORA DO FLUXO, de propósito.
       .auth__painel centra a caixa do formulário com place-items:center; um
       elemento em fluxo no fim da coluna empurraria o formulário para cima
       (metade da altura do seletor) e a tela deixaria de ser a de antes. No
       absoluto o seletor ocupa a faixa do padding de baixo (--e-6, 48px), que
       já existe vazia em todas as cinco telas, e nada se move. O position
       abaixo é só para essa coluna virar a referência do absoluto — sem
       deslocamento, não muda nada do que se vê. */
    '.auth__painel{position:relative}',
    '.i18n-idioma--auth{position:absolute;left:var(--e-5);right:var(--e-5);',
    'bottom:var(--e-3);justify-content:center;',
    'color:var(--texto-suave);font-size:var(--t-peq)}',
    '.i18n-idioma--auth:hover{color:var(--texto)}',

    /* Splash do painel: fundo escuro e nenhuma barra onde encostar. .splash já
       é position:fixed, então serve de referência sem precisar de regra nova. */
    '.i18n-idioma--splash{position:absolute;left:0;right:0;bottom:var(--e-5);',
    'justify-content:center;color:rgba(255,255,255,.55);font-size:var(--t-peq)}',
    '.i18n-idioma--splash:hover{color:#fff}'
  ].join('');

  var GLOBO = '<svg class="i18n-idioma__globo" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
    + ' stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/>'
    + '<path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18"/></svg>';

  var _seletores = [];
  var _sequencia = 0;

  function injetarEstilo() {
    if (doc.getElementById('pb-i18n-estilo')) return;
    var tag = doc.createElement('style');
    tag.id = 'pb-i18n-estilo';
    tag.appendChild(doc.createTextNode(ESTILO));
    (doc.head || doc.documentElement).appendChild(tag);
  }

  function criarSeletor(variacao) {
    _sequencia++;
    var id = 'pb-idioma-' + _sequencia;

    var caixa = doc.createElement('div');
    caixa.className = 'i18n-idioma i18n-idioma--' + variacao;
    /* O próprio seletor nunca é traduzido: "English" é English em toda língua. */
    caixa.setAttribute('data-i18n', 'nao');
    caixa.innerHTML = GLOBO;

    var rotulo = doc.createElement('label');
    rotulo.className = 'sr-only';
    rotulo.setAttribute('for', id);
    rotulo.appendChild(doc.createTextNode('Idioma / Language / Idioma'));
    caixa.appendChild(rotulo);

    var campo = doc.createElement('select');
    campo.className = 'i18n-idioma__campo';
    campo.id = id;
    for (var i = 0; i < IDIOMAS.length; i++) {
      var op = doc.createElement('option');
      op.value = IDIOMAS[i].codigo;
      op.appendChild(doc.createTextNode(IDIOMAS[i].rotulo));
      if (IDIOMAS[i].codigo === _idioma) op.selected = true;
      campo.appendChild(op);
    }
    campo.onchange = function () { definir(campo.value); };

    caixa.appendChild(campo);
    _seletores.push(campo);
    return caixa;
  }

  function sincronizarSeletores() {
    for (var i = 0; i < _seletores.length; i++) {
      if (_seletores[i].value !== _idioma) _seletores[i].value = _idioma;
    }
  }

  function injetarSeletores() {
    if (doc.querySelector('.i18n-idioma')) return;
    injetarEstilo();

    /* Site público: na faixa superior, junto das redes sociais. */
    var faixas = doc.querySelectorAll('.cabecalho__topo .container .flex');
    if (faixas.length) faixas[faixas.length - 1].appendChild(criarSeletor('topo'));

    /* A faixa some no mobile; o menu mobile ganha a própria cópia. */
    var mobile = doc.querySelector('.nav-mobile');
    if (mobile) mobile.appendChild(criarSeletor('mobile'));

    /* Painéis: no rodapé da barra lateral, logo acima de "Sair da conta". */
    var rodape = doc.querySelector('.painel__rodape');
    if (rodape) {
      var sair = rodape.querySelector('.btn-sair');
      var seletor = criarSeletor('painel');
      if (sair) rodape.insertBefore(seletor, sair);
      else rodape.appendChild(seletor);
    }

    /* Telas de autenticação (login, cadastro, recuperar senha, verificar
       e-mail, primeiro acesso): não têm cabeçalho nem barra lateral, então
       nenhuma das âncoras acima existe. O seletor vai no pé da coluna do
       formulário — inclusive no login, que é a primeira tela de quem chega de
       fora e a única porta dos dois painéis. */
    var colunaAuth = doc.querySelector('.auth__painel');
    if (colunaAuth) colunaAuth.appendChild(criarSeletor('auth'));

    /* Splash do painel, a sexta tela sem cabeçalho. */
    var splash = doc.querySelector('.splash');
    if (splash) splash.appendChild(criarSeletor('splash'));
  }

  /* =====================================================================
     PARTIDA
     ===================================================================== */

  _idioma = resolver();
  marcarHtml(_idioma);
  if (_idioma !== PADRAO) carregarDicionario(_idioma);
  /* Escolha vinda da URL vale para as próximas páginas também. */
  if (_origem === 'url') persistir(_idioma);

  function iniciar() {
    /* ALINHAMENTO COM O SERVIDOR

       Quando a resolução acima foi só palpite ('navegador'/'padrao'), o
       bootstrap saiu sem ?lang= e quem escolheu o idioma do conteúdo foi o
       servidor — que enxerga a preferência gravada na conta, invisível daqui
       antes da resposta. A interface se alinha ao que ele decidiu; o conteúdo
       na tela já está nesse idioma, então não há nada a recarregar.

       Escolha explícita (URL, cookie, clique) manda mais e não é revista:
       naquele caso o ?lang= foi junto e os dois lados já concordam. */
    if (!EXPLICITAS[_origem]) {
      var doBanco = doServidor();
      var novo = doBanco || daConta();
      if (novo && novo !== _idioma) {
        definir(novo, true);
        _origem = doBanco ? 'servidor' : 'conta';
      }
    }

    injetarSeletores();
    traduzir(doc.documentElement);
    ligarObservador();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', iniciar);
  else iniciar();

  /* =====================================================================
     API
     ===================================================================== */

  PB.i18n = {
    idioma: function () { return _idioma; },
    definir: function (codigo) { return definir(codigo); },

    /**
     * O idioma quando ele é ESCOLHA (link com ?lang=, cookie desta máquina,
     * clique no seletor); null quando é só palpite do navegador. É o que o
     * dados.js manda no ?lang= do bootstrap — palpite fica de fora para não
     * atropelar a preferência gravada na conta.
     * @returns {string|null}
     */
    escolhido: function () { return EXPLICITAS[_origem] ? _idioma : null; },

    /** Traduz uma string solta. Devolve o português quando não há tradução. */
    t: function (texto) {
      if (_idioma === PADRAO) return texto;
      var chave = normalizar(texto);
      if (!chave) return texto;
      var achado = procurar(chave);
      return achado === null ? texto : comBordas(String(texto), achado);
    },

    traduzir: function (raiz) { traduzir(raiz); },

    idiomas: function () {
      var lista = [];
      for (var i = 0; i < IDIOMAS.length; i++) {
        lista.push({ codigo: IDIOMAS[i].codigo, rotulo: IDIOMAS[i].rotulo });
      }
      return lista;
    },

    /* Para depurar no console: de onde veio o idioma e quantas chaves entraram. */
    diagnostico: function () {
      return {
        idioma: _idioma,
        origem: _origem,
        base: BASE,
        textos: Object.keys(_textos).length,
        padroes: _padroes.length
      };
    }
  };

}(window, document));
