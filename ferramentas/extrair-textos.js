#!/usr/bin/env node
/* ==========================================================================
   PHYGITAL BRASIL — EXTRATOR DE TEXTOS PARA TRADUÇÃO

   Uso:  node ferramentas/extrair-textos.js
         node ferramentas/extrair-textos.js --relatorio   (mostra o que ficou de fora)

   Roda à mão, nunca no navegador. Varre o HTML das 50 páginas e os scripts de
   site/assets/js/ e escreve site/assets/i18n/pt.json — o catálogo de tudo que
   o visitante lê em português. en.json e es.json são criados com as mesmas
   chaves e valores vazios, para outro agente preencher.

   POR QUE O DICIONÁRIO É INDEXADO PELO PRÓPRIO TEXTO EM PORTUGUÊS
   O português continua escrito no HTML. Marcar 2 mil elementos com data-i18n
   mudaria o markup das 50 páginas, e o cliente pediu duas vezes que o layout
   não mude. A chave é o texto normalizado; a tradução acontece em tempo de
   execução, em site/assets/js/i18n.js.

   POR ISSO ESTE ARQUIVO E O RUNTIME PRECISAM NORMALIZAR IGUAL.
   `normalizar()` aqui e `normalizar()` lá são a MESMA função, letra por letra.
   Se uma delas colapsar um espaço que a outra mantém, a chave não casa e a
   página inteira fica sem tradução, sem erro nenhum no console. Ao mexer numa,
   mexa na outra.
   ========================================================================== */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..');
const SITE = path.join(RAIZ, 'site');
const PASTA_SAIDA = path.join(SITE, 'assets', 'i18n');

const RELATORIO = process.argv.indexOf('--relatorio') >= 0;

/* Marcador interno da interpolação de template string. É um caractere de
   controle: não existe em arquivo de texto de verdade, então não colide. */
const MARCA = '\u0001';

/* --------------------------------------------------------------------------
   O QUE ENTRA

   Atributos: os cinco pedidos (placeholder, title, aria-label, alt, value de
   botão) mais os data-* que o phygital.js transforma em texto na tela — o
   diálogo de PB.confirmar() e o toast de data-demo são tão visíveis quanto
   qualquer parágrafo.
   -------------------------------------------------------------------------- */

const ATRIBUTOS = [
  'placeholder', 'title', 'aria-label', 'alt',
  'data-confirmar', 'data-confirmar-titulo', 'data-confirmar-ok',
  'data-demo', 'data-placeholder'
];

/* value só vale como texto em botão; em input de texto é dado, não rótulo. */
const TIPOS_DE_BOTAO = { button: 1, submit: 1, reset: 1 };

/* Conteúdo que não é texto de interface e nunca deve ser traduzido.
   O runtime pula exatamente as mesmas tags. */
const TAGS_OPACAS = { script: 1, style: 1, textarea: 1, pre: 1, code: 1, svg: 1 };

/* Trechos de JS que descrevem DADOS, não interface: a semente de demonstração
   de dados.js é nome de time, texto de chamado e manchete de notícia. Se
   entrassem no dicionário, o runtime passaria a traduzir conteúdo do banco
   sempre que ele coincidisse com a semente — traduzir dado do usuário é pior
   que não traduzir. */
const FUNCOES_IGNORADAS = { 'dados.js': ['semente'] };

/* O runtime não se traduz: "Português", "English" e "Español" aparecem iguais
   nos três idiomas, e o seletor já vai marcado com data-i18n="nao". */
const JS_IGNORADOS = { 'i18n.js': 1 };

/* --------------------------------------------------------------------------
   NORMALIZAÇÃO — espelhada em site/assets/js/i18n.js
   -------------------------------------------------------------------------- */

function normalizar(texto) {
  return String(texto == null ? '' : texto).replace(/\s+/g, ' ').trim();
}

function temLetra(texto) {
  return /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(texto);
}

/* --------------------------------------------------------------------------
   ENTIDADES HTML

   O navegador entrega o texto já decodificado ao runtime; o extrator lê o
   arquivo cru. Sem decodificar aqui, "Inscrições &amp; regras" viraria uma
   chave que nunca aparece no DOM.
   -------------------------------------------------------------------------- */

const ENTIDADES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ',
  middot: '·', bull: '•', hellip: '…', mdash: '—', ndash: '–',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  laquo: '«', raquo: '»', times: '×', deg: '°', copy: '©', reg: '®',
  trade: '™', euro: '€', ordm: 'º', ordf: 'ª', sup2: '²', frac12: '½'
};

function decodificar(texto) {
  if (texto.indexOf('&') < 0) return texto;
  return texto.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (tudo, corpo) => {
    if (corpo.charAt(0) === '#') {
      const hex = corpo.charAt(1) === 'x' || corpo.charAt(1) === 'X';
      const codigo = parseInt(hex ? corpo.slice(2) : corpo.slice(1), hex ? 16 : 10);
      return Number.isFinite(codigo) && codigo > 0 && codigo <= 0x10FFFF
        ? String.fromCodePoint(codigo) : tudo;
    }
    return Object.prototype.hasOwnProperty.call(ENTIDADES, corpo) ? ENTIDADES[corpo] : tudo;
  });
}

/* --------------------------------------------------------------------------
   CATÁLOGO
   -------------------------------------------------------------------------- */

const catalogo = new Map();
const descartes = new Map();   /* motivo -> exemplos, só para o relatório */

function descartar(motivo, texto) {
  if (!descartes.has(motivo)) descartes.set(motivo, { total: 0, exemplos: [] });
  const d = descartes.get(motivo);
  d.total++;
  if (d.exemplos.length < 8 && d.exemplos.indexOf(texto) < 0) d.exemplos.push(texto);
}

/**
 * @param {string} texto   já normalizado
 * @param {object} info    { arquivo, tipo: 'texto'|'atributo', atributo, frase }
 */
function registrar(texto, info) {
  if (!texto || !temLetra(texto)) return;

  /* {0} vem do extrator de JS: é rótulo montado por concatenação. Vira padrão,
     não texto fixo — o runtime casa esses por expressão regular. */
  const ehPadrao = /\{\d+\}/.test(texto);

  let item = catalogo.get(texto);
  if (!item) {
    item = {
      tipo: ehPadrao ? 'padrao' : info.tipo,
      ocorrencias: 0,
      arquivos: new Set(),
      atributos: new Set(),
      frase: null
    };
    catalogo.set(texto, item);
  }

  /* Um mesmo texto pode ser conteúdo numa página e atributo em outra; o tipo
     que manda é o mais forte, porque decide como o runtime aplica. */
  if (ehPadrao) item.tipo = 'padrao';
  else if (info.tipo === 'texto' && item.tipo === 'atributo') item.tipo = 'texto';

  item.ocorrencias++;
  item.arquivos.add(info.arquivo);
  if (info.atributo) item.atributos.add(info.atributo);
  /* A frase inteira ajuda quem traduz um pedaço solto ("de", "até") a entender
     onde ele cai. Guarda a primeira que aparecer. */
  if (!item.frase && info.frase && info.frase !== texto) item.frase = info.frase;
}

/* --------------------------------------------------------------------------
   VARREDURA DE HTML

   Máquina de estados simples, sem dependência. Cada trecho de texto entre duas
   tags é UM nó de texto — a mesma unidade que o runtime encontra no DOM.
   -------------------------------------------------------------------------- */

function varrerHtml(fonte, arquivo) {
  const pilha = [{ tag: '#raiz', textos: [], entradas: [] }];
  let i = 0;

  function topo() { return pilha[pilha.length - 1]; }

  function anotarTexto(bruto) {
    const t = normalizar(decodificar(bruto));
    if (!t) return;
    const alvo = topo();
    alvo.textos.push(t);
    if (temLetra(t)) alvo.entradas.push(t);
  }

  /* Um <strong> no meio de um parágrafo parte a frase em três nós de texto, e
     cada nó vira uma chave sozinha — é o preço de indexar pelo português. Para
     o tradutor não receber "Fale", "com a gente" e "hoje" soltos, o texto de
     elemento EM LINHA sobe para o pai e o bloco registra os pedaços com a
     frase inteira ao lado, em `contexto[chave].frase`.

     Só sobe o que é em linha: juntar o <h3> e o <p> de um mesmo <div> daria
     uma "frase" que ninguém escreveu. */
  function fechar() {
    if (pilha.length <= 1) return;
    const el = pilha.pop();
    const pai = topo();

    if (EM_LINHA[el.tag]) {
      el.textos.forEach((t) => pai.textos.push(t));
      el.entradas.forEach((t) => pai.entradas.push(t));
      return;
    }
    registrarBloco(el);
  }

  function registrarBloco(el) {
    if (!el.entradas.length) return;
    let frase = null;
    if (el.entradas.length > 1) {
      const inteira = el.textos.join(' ');
      /* Frase gigante não é frase: é a página inteira caindo num nó só. */
      if (inteira.length <= 300) frase = inteira;
    }
    el.entradas.forEach((t) => registrar(t, { arquivo, tipo: 'texto', frase }));
    el.textos.length = 0;
    el.entradas.length = 0;
  }

  while (i < fonte.length) {
    const lt = fonte.indexOf('<', i);
    if (lt < 0) { anotarTexto(fonte.slice(i)); break; }
    if (lt > i) anotarTexto(fonte.slice(i, lt));

    if (fonte.substr(lt, 4) === '<!--') {
      const fim = fonte.indexOf('-->', lt + 4);
      i = fim < 0 ? fonte.length : fim + 3;
      continue;
    }
    if (fonte.charAt(lt + 1) === '!' || fonte.charAt(lt + 1) === '?') {
      const fim = fonte.indexOf('>', lt);
      i = fim < 0 ? fonte.length : fim + 1;
      continue;
    }
    if (fonte.charAt(lt + 1) === '/') {
      const fim = fonte.indexOf('>', lt);
      const nome = fonte.slice(lt + 2, fim < 0 ? fonte.length : fim).trim().toLowerCase();
      /* Fecha até achar a tag correspondente: markup mal fechado não pode
         desalinhar o resto do arquivo. */
      for (let k = pilha.length - 1; k > 0; k--) {
        const igual = pilha[k].tag === nome;
        fechar();
        if (igual) break;
      }
      i = fim < 0 ? fonte.length : fim + 1;
      continue;
    }

    const fimTag = acharFimDaTag(fonte, lt);
    const cru = fonte.slice(lt + 1, fimTag);
    const nome = (cru.match(/^[a-zA-Z][\w:-]*/) || [''])[0].toLowerCase();
    if (!nome) { i = fimTag + 1; continue; }

    const atributos = lerAtributos(cru.slice(nome.length));
    anotarAtributos(nome, atributos, arquivo);

    const fechadaNaPropriaTag = /\/\s*$/.test(cru) || VAZIAS[nome];
    i = fimTag + 1;

    if (TAGS_OPACAS[nome] && !fechadaNaPropriaTag) {
      const fecha = acharFechamento(fonte, nome, i);
      const conteudo = fonte.slice(i, fecha.ini);
      /* Script inline com português dentro: manda para o extrator de JS. Script
         externo (src) já é varrido como arquivo. */
      if (nome === 'script' && !atributos.src && ehJavaScript(atributos.type)) {
        varrerJs(conteudo, arquivo);
      }
      i = fecha.fim;
      continue;
    }

    if (!fechadaNaPropriaTag) pilha.push({ tag: nome, textos: [], entradas: [] });
  }

  /* Fragmento de HTML montado por JS chega sem fechar as tags; o que sobrou na
     pilha é registrado do mesmo jeito. */
  while (pilha.length > 1) fechar();
  registrarBloco(pilha[0]);
}

/* Elementos que fazem parte da frase do pai, não de uma frase própria. */
const EM_LINHA = {
  a: 1, abbr: 1, b: 1, bdi: 1, bdo: 1, cite: 1, data: 1, dfn: 1, em: 1,
  i: 1, mark: 1, q: 1, s: 1, small: 1, span: 1, strong: 1, sub: 1, sup: 1,
  time: 1, u: 1, var: 1
};

const VAZIAS = {
  area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1,
  link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1
};

function ehJavaScript(tipo) {
  if (!tipo) return true;
  return /javascript|module|^text\/js$/i.test(tipo);
}

/** Fim de uma tag de abertura, respeitando > dentro de valor com aspas. */
function acharFimDaTag(fonte, ini) {
  let i = ini + 1;
  let aspas = '';
  while (i < fonte.length) {
    const c = fonte.charAt(i);
    if (aspas) { if (c === aspas) aspas = ''; }
    else if (c === '"' || c === '\'') aspas = c;
    else if (c === '>') return i;
    i++;
  }
  return fonte.length;
}

function acharFechamento(fonte, nome, desde) {
  const re = new RegExp('</\\s*' + nome + '\\s*>', 'i');
  const resto = fonte.slice(desde);
  const m = resto.match(re);
  if (!m) return { ini: fonte.length, fim: fonte.length };
  return { ini: desde + m.index, fim: desde + m.index + m[0].length };
}

function lerAtributos(cru) {
  const mapa = {};
  const re = /([a-zA-Z_:@#$][\w:.\-]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(cru))) {
    const valor = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : (m[5] !== undefined ? m[5] : ''));
    mapa[m[1].toLowerCase()] = valor;
  }
  return mapa;
}

function anotarAtributos(tag, atributos, arquivo) {
  ATRIBUTOS.forEach((nome) => {
    if (!atributos[nome] || ehEndereco(atributos[nome])) return;
    registrar(normalizar(decodificar(atributos[nome])), {
      arquivo, tipo: 'atributo', atributo: nome
    });
  });

  if (tag === 'button' && atributos.value) {
    registrar(normalizar(decodificar(atributos.value)), { arquivo, tipo: 'atributo', atributo: 'value' });
  }
  if (tag === 'input' && atributos.value && TIPOS_DE_BOTAO[(atributos.type || '').toLowerCase()]) {
    registrar(normalizar(decodificar(atributos.value)), { arquivo, tipo: 'atributo', atributo: 'value' });
  }
  if (tag === 'meta' && (atributos.name || '').toLowerCase() === 'description' && atributos.content) {
    registrar(normalizar(decodificar(atributos.content)), { arquivo, tipo: 'atributo', atributo: 'content' });
  }
}

/* --------------------------------------------------------------------------
   VARREDURA DE JAVASCRIPT

   Um léxico pequeno: só precisa distinguir string de comentário, de regex e de
   nome. Com os tokens em mãos, o texto sai de duas formas:

     'Chamado aberto'                  → texto fixo
     '<h3>' + esc(t.titulo) + '</h3>'  → fragmento de HTML, que volta para o
                                         varredor de HTML acima
     x + ' de ' + y + ' vagas'         → padrão "{0} de {1} vagas"

   O padrão existe porque a página monta esse rótulo em tempo de execução: no
   DOM ele é UM nó de texto ("3 de 24 vagas"), que só casa por expressão
   regular.
   -------------------------------------------------------------------------- */

const PALAVRAS_ANTES_DE_REGEX = {
  return: 1, typeof: 1, instanceof: 1, in: 1, of: 1, new: 1, delete: 1,
  void: 1, case: 1, do: 1, else: 1, yield: 1, await: 1
};

/* Pontuação que encerra a expressão: o que vem depois é outra cadeia. */
const TERMINADORES = {
  ',': 1, ';': 1, ':': 1, '?': 1, '=': 1, '<': 1, '>': 1, '!': 1,
  '&': 1, '|': 1, '^': 1, '~': 1, '-': 1, '*': 1, '/': 1, '%': 1
};

const ABRE = { '(': ')', '[': ']', '{': '}' };
const FECHA = { ')': 1, ']': 1, '}': 1 };

/* Palavra reservada encerra a cadeia. Sem isto, o `return` de
   `return '<h3>' + titulo` entra na MESMA parte que a string e o literal
   inteiro vira marcador: some do dicionário o HTML todo que o JS monta. */
const PALAVRAS_RESERVADAS = {
  return: 1, typeof: 1, instanceof: 1, in: 1, of: 1, new: 1, delete: 1,
  void: 1, case: 1, do: 1, else: 1, yield: 1, await: 1, throw: 1,
  var: 1, let: 1, const: 1, function: 1, if: 1, while: 1, for: 1,
  switch: 1, break: 1, continue: 1, try: 1, catch: 1, finally: 1
};

function lexer(fonte) {
  const tokens = [];
  let i = 0;
  let anterior = null;

  function podeSerRegex() {
    if (!anterior) return true;
    if (anterior.tipo === 'nome') return !!PALAVRAS_ANTES_DE_REGEX[anterior.valor];
    if (anterior.tipo === 'texto' || anterior.tipo === 'numero') return false;
    return !FECHA[anterior.valor];
  }

  function empurrar(t) { tokens.push(t); anterior = t; }

  while (i < fonte.length) {
    const c = fonte.charAt(i);

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') { i++; continue; }

    if (c === '/' && fonte.charAt(i + 1) === '/') {
      const fim = fonte.indexOf('\n', i);
      i = fim < 0 ? fonte.length : fim + 1;
      continue;
    }
    if (c === '/' && fonte.charAt(i + 1) === '*') {
      const fim = fonte.indexOf('*/', i + 2);
      i = fim < 0 ? fonte.length : fim + 2;
      continue;
    }
    if (c === '/' && podeSerRegex()) {
      let j = i + 1;
      let classe = false;
      while (j < fonte.length) {
        const d = fonte.charAt(j);
        if (d === '\\') { j += 2; continue; }
        if (d === '[') classe = true;
        else if (d === ']') classe = false;
        else if (d === '/' && !classe) break;
        else if (d === '\n') break;
        j++;
      }
      i = j + 1;
      while (/[a-z]/i.test(fonte.charAt(i))) i++;
      empurrar({ tipo: 'regex', valor: '', ini: i });
      continue;
    }

    if (c === '"' || c === '\'' || c === '`') {
      const lida = lerString(fonte, i);
      empurrar({ tipo: 'texto', valor: lida.valor, ini: i });
      i = lida.fim;
      continue;
    }

    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < fonte.length && /[\w$]/.test(fonte.charAt(j))) j++;
      empurrar({ tipo: 'nome', valor: fonte.slice(i, j), ini: i });
      i = j;
      continue;
    }

    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < fonte.length && /[\w.]/.test(fonte.charAt(j))) j++;
      empurrar({ tipo: 'numero', valor: fonte.slice(i, j), ini: i });
      i = j;
      continue;
    }

    empurrar({ tipo: 'pontuacao', valor: c, ini: i });
    i++;
  }

  return tokens;
}

const ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };

function lerString(fonte, ini) {
  const aspa = fonte.charAt(ini);
  let i = ini + 1;
  let saida = '';
  while (i < fonte.length) {
    const c = fonte.charAt(i);
    if (c === '\\') {
      const p = fonte.charAt(i + 1);
      if (p === 'u') {
        if (fonte.charAt(i + 2) === '{') {
          const fim = fonte.indexOf('}', i + 3);
          saida += String.fromCodePoint(parseInt(fonte.slice(i + 3, fim), 16) || 32);
          i = fim + 1;
          continue;
        }
        saida += String.fromCharCode(parseInt(fonte.substr(i + 2, 4), 16) || 32);
        i += 6;
        continue;
      }
      if (p === 'x') {
        saida += String.fromCharCode(parseInt(fonte.substr(i + 2, 2), 16) || 32);
        i += 4;
        continue;
      }
      if (p === '\n') { i += 2; continue; }
      saida += Object.prototype.hasOwnProperty.call(ESCAPES, p) ? ESCAPES[p] : p;
      i += 2;
      continue;
    }
    if (c === aspa) return { valor: saida, fim: i + 1 };
    /* Só a crase aceita quebra de linha; nas outras, string sem fechar é erro
       de sintaxe e para aqui mesmo. */
    if (c === '\n' && aspa !== '`') return { valor: saida, fim: i };
    if (aspa === '`' && c === '$' && fonte.charAt(i + 1) === '{') {
      let nivel = 1;
      let j = i + 2;
      while (j < fonte.length && nivel > 0) {
        if (fonte.charAt(j) === '{') nivel++;
        else if (fonte.charAt(j) === '}') nivel--;
        j++;
      }
      saida += MARCA;   /* marcador de interpolação, vira {n} depois */
      i = j;
      continue;
    }
    saida += c;
    i++;
  }
  return { valor: saida, fim: i };
}

/** Índice do fechamento que casa com o abridor em `ini`. */
function casarBloco(tokens, ini, fim) {
  const alvo = ABRE[tokens[ini].valor];
  let nivel = 0;
  for (let i = ini; i < fim; i++) {
    const t = tokens[i];
    if (t.tipo !== 'pontuacao') continue;
    if (ABRE[t.valor]) nivel++;
    else if (FECHA[t.valor]) {
      nivel--;
      if (nivel === 0) return t.valor === alvo ? i : i;
    }
  }
  return fim;
}

/**
 * Percorre um intervalo de tokens e emite cada cadeia de concatenação.
 * Recursivo: o miolo de cada parênteses/colchete/chave é analisado à parte,
 * senão strings dentro de chamadas ficariam de fora.
 */
function analisarIntervalo(tokens, ini, fim, emitir) {
  let partes = [];        /* { literal: string } | { valor: true } */
  let inicioCadeia = -1;
  let tokensNaParte = 0;
  let literalDaParte = null;

  function fecharParte() {
    if (tokensNaParte === 0) return;
    if (tokensNaParte === 1 && literalDaParte !== null) partes.push({ literal: literalDaParte });
    else partes.push({ valor: true });
    tokensNaParte = 0;
    literalDaParte = null;
  }

  function fecharCadeia() {
    fecharParte();
    if (partes.some((p) => p.literal !== undefined)) {
      let n = 0;
      const texto = partes.map((p) => (p.literal !== undefined ? p.literal : '{' + (n++) + '}')).join('');
      emitir(texto, inicioCadeia);
    }
    partes = [];
    inicioCadeia = -1;
  }

  let i = ini;
  while (i < fim) {
    const t = tokens[i];

    if (t.tipo === 'pontuacao' && ABRE[t.valor]) {
      const f = casarBloco(tokens, i, fim);
      analisarIntervalo(tokens, i + 1, f, emitir);
      tokensNaParte += 2;              /* grupo inteiro conta como valor */
      literalDaParte = null;
      i = f + 1;
      continue;
    }
    if (t.tipo === 'pontuacao' && FECHA[t.valor]) { fecharCadeia(); i++; continue; }
    if (t.tipo === 'pontuacao' && t.valor === '+') { fecharParte(); i++; continue; }
    if (t.tipo === 'pontuacao' && TERMINADORES[t.valor]) { fecharCadeia(); i++; continue; }
    if (t.tipo === 'nome' && PALAVRAS_RESERVADAS[t.valor]) { fecharCadeia(); i++; continue; }

    if (inicioCadeia < 0) inicioCadeia = i;
    if (t.tipo === 'texto' && tokensNaParte === 0) literalDaParte = t.valor;
    else literalDaParte = null;
    tokensNaParte++;
    i++;
  }
  fecharCadeia();
}

/* Nomes que garantem que a string ao lado é texto para gente. setAttribute
   fica de fora de propósito: quase todo uso dele é 'aria-hidden' e afins. */
const CHAMADAS_DE_TEXTO = [
  'toast', 'confirmar', 'alert', 'confirm', 'prompt', 'textContent', 'innerText',
  'innerHTML', 'placeholder', 'title', 'erro', 'mensagem', 'rotulo'
];

/**
 * A string é argumento de uma dessas chamadas, ou o lado direito de
 * `algo.textContent =`? Vale só a chamada que ENVOLVE a string; olhar "os
 * últimos oito tokens" deixava passar todo seletor escrito dentro de uma
 * função chamada confirmar().
 */
function contextoDeTexto(tokens, indice) {
  const anterior = tokens[indice - 1];
  if (!anterior) return false;

  if (anterior.valor === '=' && tokens[indice - 2]
    && CHAMADAS_DE_TEXTO.indexOf(tokens[indice - 2].valor) >= 0) return true;

  let nivel = 0;
  for (let i = indice - 1; i >= 0 && indice - i < 40; i--) {
    const t = tokens[i];
    if (t.tipo !== 'pontuacao') continue;
    if (FECHA[t.valor]) { nivel++; continue; }
    if (!ABRE[t.valor]) continue;
    if (nivel > 0) { nivel--; continue; }
    const nome = tokens[i - 1];
    return !!(nome && nome.tipo === 'nome' && CHAMADAS_DE_TEXTO.indexOf(nome.valor) >= 0);
  }
  return false;
}

/* --------------------------------------------------------------------------
   É TEXTO PARA GENTE?

   Vale só para string SOLTA de JavaScript. Texto que sai de fragmento de HTML
   não passa por aqui: ali a posição já prova que é conteúdo visível.
   -------------------------------------------------------------------------- */

function pareceTextoHumano(texto) {
  if (!temLetra(texto)) return 'sem letra';
  if (texto.length > 400) return 'longo demais';

  if (/^(https?:|mailto:|tel:|data:|\/|\.\.?\/)/i.test(texto)) return 'endereço';
  if (/\.(html|js|mjs|css|svg|png|jpe?g|webp|gif|json|zip|xlsx|pdf|ico|xml|rels)(\?|#|$)/i.test(texto)) return 'arquivo';
  if (/^[.#[]/.test(texto)) return 'seletor css';
  if (/^[?&][a-z]/i.test(texto)) return 'querystring';
  /* Caminho de arquivo e tipo MIME não têm espaço. "Atleta/Time", que é
     cabeçalho de planilha, escapa pela inicial maiúscula. */
  if (texto.indexOf('/') >= 0 && !/\s/.test(texto)
    && (/[._]/.test(texto) || /^[a-z]/.test(texto))) return 'caminho';
  if (/\[data-|\]\s*$/.test(texto) && !/\s\w+\s/.test(texto)) return 'seletor css';
  if (/[{;]\s*[a-z-]+\s*:/.test(texto) && /[;:]/.test(texto) && !/\s[A-ZÀ-Ú]/.test(texto)) return 'css';
  if (/^\(.*:.*\)$/.test(texto)) return 'consulta de mídia';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(texto)) return 'e-mail';
  if (/[?&=]/.test(texto) && !/\s/.test(texto)) return 'chave técnica';
  if (/[,[\]]/.test(texto) && /^[a-z0-9\s,.#[\]:()>+~*="'-]+$/.test(texto)) return 'seletor css';
  if (/^[a-z][a-z0-9]*([_-]{1,2}[a-z0-9]+)+$/.test(texto)) return 'classe ou chave';
  if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(texto)) return 'constante';
  if (/^[a-z][a-zA-Z0-9]*$/.test(texto)) return 'identificador';
  /* "0px 0px -40px 0px": tem letra, mas nenhuma palavra. */
  if (!/[A-Za-zÀ-ÖØ-öø-ÿ]{3}/.test(texto)) return 'sem palavra';
  /* GET, PATCH, NFD: sigla técnica solta no código. Rótulo de tela em caixa
     alta (SMTP, CPF) chega pelo HTML, que não passa por este filtro. */
  if (/^[A-Z][A-Z0-9]{1,6}$/.test(texto)) return 'sigla técnica';
  if (texto.length <= 2) return 'curto demais';

  return null;
}

/* Valor de atributo que é endereço não é texto: entra no dicionário só para o
   tradutor copiar de volta igual. */
function ehEndereco(valor) {
  return /^(https?:\/\/|mailto:|tel:|data:|\.\.?\/|\/)/i.test(valor);
}

function varrerJs(fonte, arquivo) {
  const tokens = lexer(fonte);
  const base = path.basename(arquivo);
  const proibidos = intervalosProibidos(tokens, FUNCOES_IGNORADAS[base] || []);

  analisarIntervalo(tokens, 0, tokens.length, (texto, indice) => {
    if (proibidos.some((f) => indice >= f[0] && indice < f[1])) return;

    /* MARCA guarda a interpolação de template string: vira valor variável. */
    let n = 0;
    const comPlaceholders = texto.replace(new RegExp(MARCA, 'g'), () => '{' + (n++) + '}');
    const bruto = renumerar(comPlaceholders);

    if (/<[a-zA-Z/!]/.test(bruto) && />/.test(bruto)) {
      varrerHtml(bruto, arquivo);
      return;
    }

    /* A concatenação pode começar NO MEIO de uma tag:
         '<button class="' + classe + '" aria-label="Destaque ' + n + '">'
       parte em três, e o pedaço do meio chega aqui sem nenhum '<'. Com um
       abridor de mentira na frente, o varredor de HTML lê os atributos e o
       aria-label não se perde. */
    if (/^[^<>]*=\s*"/.test(bruto)) {
      varrerHtml('<x ' + bruto, arquivo);
      return;
    }

    const limpo = normalizar(bruto);
    if (!limpo) return;
    const motivo = contextoDeTexto(tokens, indice) ? null : pareceTextoHumano(limpo);
    if (motivo) { descartar(motivo, limpo); return; }
    registrar(limpo, { arquivo, tipo: 'texto' });
  });
}

/** Deixa os marcadores em ordem: "{1} de {0}" nunca acontece na saída. */
function renumerar(texto) {
  let n = 0;
  return texto.replace(/\{\d+\}/g, () => '{' + (n++) + '}');
}

function intervalosProibidos(tokens, nomes) {
  const faixas = [];
  if (!nomes.length) return faixas;
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i].tipo !== 'nome' || tokens[i].valor !== 'function') continue;
    const nome = tokens[i + 1];
    if (!nome || nome.tipo !== 'nome' || nomes.indexOf(nome.valor) < 0) continue;
    let j = i + 2;
    while (j < tokens.length && !(tokens[j].tipo === 'pontuacao' && tokens[j].valor === '{')) j++;
    if (j >= tokens.length) continue;
    faixas.push([i, casarBloco(tokens, j, tokens.length) + 1]);
  }
  return faixas;
}

/* --------------------------------------------------------------------------
   ARQUIVOS
   -------------------------------------------------------------------------- */

function listar(pasta, filtro) {
  let itens = [];
  try { itens = fs.readdirSync(pasta); } catch (e) { return []; }
  return itens
    .filter((n) => filtro.test(n))
    .map((n) => path.join(pasta, n))
    .filter((p) => fs.statSync(p).isFile())
    .sort();
}

function relativo(arquivo) {
  return path.relative(RAIZ, arquivo).split(path.sep).join('/');
}

/* --------------------------------------------------------------------------
   SAÍDA
   -------------------------------------------------------------------------- */

function ordenar(chaves) {
  return chaves.sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

function montar(idioma, vazio) {
  const textos = {};
  const padroes = {};
  const contexto = {};

  ordenar(Array.from(catalogo.keys())).forEach((chave) => {
    const item = catalogo.get(chave);
    const destino = item.tipo === 'padrao' ? padroes : textos;
    destino[chave] = vazio ? '' : chave;

    const ficha = {
      tipo: item.tipo,
      usos: item.ocorrencias,
      arquivos: Array.from(item.arquivos).sort().slice(0, 3)
    };
    if (item.atributos.size) ficha.atributos = Array.from(item.atributos).sort();
    /* Chave longa já é a frase inteira: repetir o contexto só engordaria o
       arquivo que quem traduz precisa abrir. */
    if (item.frase && chave.length <= 90) ficha.frase = item.frase;
    contexto[chave] = ficha;
  });

  const pacote = {
    idioma,
    versao: 1,
    geradoEm: new Date().toISOString(),
    resumo: {
      textos: Object.keys(textos).length,
      padroes: Object.keys(padroes).length,
      total: catalogo.size
    },
    textos,
    padroes
  };
  /* O contexto só vai no pt.json: é material para quem traduz, e o runtime
     baixa en.json/es.json em toda página traduzida — carregar de novo a lista
     de arquivos de cada chave só engordaria o download. */
  if (!vazio) pacote.contexto = contexto;
  return pacote;
}

function gravar(nome, dados) {
  const destino = path.join(PASTA_SAIDA, nome);
  fs.writeFileSync(destino, JSON.stringify(dados, null, 2) + '\n', 'utf8');
  return destino;
}

/* --------------------------------------------------------------------------
   PRINCIPAL
   -------------------------------------------------------------------------- */

function principal() {
  const htmls = []
    .concat(listar(SITE, /\.html$/))
    .concat(listar(path.join(SITE, 'painel'), /\.html$/))
    .concat(listar(path.join(SITE, 'admin'), /\.html$/));

  const scripts = listar(path.join(SITE, 'assets', 'js'), /\.js$/)
    .filter((arquivo) => !JS_IGNORADOS[path.basename(arquivo)]);

  htmls.forEach((arquivo) => varrerHtml(fs.readFileSync(arquivo, 'utf8'), relativo(arquivo)));
  scripts.forEach((arquivo) => varrerJs(fs.readFileSync(arquivo, 'utf8'), relativo(arquivo)));

  fs.mkdirSync(PASTA_SAIDA, { recursive: true });
  const pt = gravar('pt.json', montar('pt', false));
  const en = gravar('en.json', montar('en', true));
  const es = gravar('es.json', montar('es', true));

  let textos = 0;
  let padroes = 0;
  let ocorrencias = 0;
  catalogo.forEach((item) => {
    if (item.tipo === 'padrao') padroes++; else textos++;
    ocorrencias += item.ocorrencias;
  });

  console.log('Arquivos lidos: ' + htmls.length + ' HTML + ' + scripts.length + ' JS');
  console.log('Strings distintas: ' + catalogo.size + ' (' + textos + ' fixas, ' + padroes + ' padrões)');
  console.log('Ocorrências: ' + ocorrencias);
  console.log('Gravado: ' + relativo(pt) + ', ' + relativo(en) + ', ' + relativo(es));

  if (RELATORIO) {
    console.log('\nDescartado (string solta de JS que não parece texto de tela):');
    Array.from(descartes.entries())
      .sort((a, b) => b[1].total - a[1].total)
      .forEach(([motivo, d]) => {
        console.log('  ' + motivo + ': ' + d.total);
        d.exemplos.forEach((e) => console.log('      ' + JSON.stringify(e.slice(0, 70))));
      });
  }
}

principal();
